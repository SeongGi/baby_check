// In-memory Cloudflare Worker & D1 mock for sync-harness tests (06 설계 2.5, 2.9).
// 클라이언트만 보는 빠른 검사용입니다. 서버 동작의 최종 판정은 실제 서버 코드로 도는
// 하네스 모드(2.10)에서 합니다. 한도(500건, 1MB), 삭제 표식 upsert, 같은 버전 무시,
// 410, 올리기 분류, 페이지 당겨 받기를 실제 서버와 같은 규칙으로 흉내 냅니다.
import { compareCodePoints } from '../../../src/utils/compareCodePoints.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_ITEMS = 500;
const MAX_PAGE_BYTES = 800 * 1024;
const CURSOR_MARGIN_MS = 120_000;

export const state = {
  // 가족: key -> { createdAt, updatedAt, lastClientId, pendingDeletionAt, sharedJson, profileUpdatedAt }
  families: new Map(),
  // 기록: key -> Map(logId -> { clientUpdatedAt, updatedAt, deletedAt, rawJson })
  logs: new Map(),
  // 영구 삭제한 가족 key (deleted_families)
  deleted: new Set(),
  // 회원(members): key -> Set(clientId). 실제 서버처럼 연결 요청(connect)이 성공할 때만 더합니다.
  members: new Map(),
  // 쓰기가 있었던 요청마다 한 건: { logs, tombstones, profile }
  commits: [],
  // 요청 목록: { kind, clientId, pushLogs, pushDeleted, pull, status, writes }
  requests: [],
  maxPushItems: 400,
  maxPageRows: 500,
  // 서버 시각을 정합니다. 없으면 Date.now().
  clock: null,
  beforeRead: null,
  beforeTransaction: null,
  beforeCommit: null,
  // 어댑터가 설치하는 요청 훅. (body, request) => Promise<{status}|undefined>
  onRequest: null,
  // 응답 본문을 바꿔치기합니다(아기 정보 가드 검사 등). (body, response) => response
  tamperSyncResponse: null,
  // 올리기 분류를 "항상 받아들이지 않음"으로 만듭니다(진전 없음 중단 검사).
  rejectAllPushes: false,
  // 다음 sync 요청에 이 상태 코드를 돌려줍니다(한 번만). 또는 함수(body)=>status|null.
  failNextSync: null,
  offline: false,
};

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

const now = () => (state.clock ? state.clock() : Date.now());

const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item).sort().reduce((sorted, key) => {
          if (item[key] !== undefined) sorted[key] = item[key];
          return sorted;
        }, {})
      : item);

function makeJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const familyLogs = (key) => {
  let logs = state.logs.get(key);
  if (!logs) { logs = new Map(); state.logs.set(key, logs); }
  return logs;
};

const missingResponse = (key) =>
  state.deleted.has(key)
    ? makeJsonResponse({ ok: false, error: 'family_deleted' }, 410)
    : makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);

const createFamily = (key) => {
  const t = now();
  state.families.set(key, {
    createdAt: t, updatedAt: t, lastClientId: '', pendingDeletionAt: null, sharedJson: null, profileUpdatedAt: 0,
  });
  familyLogs(key);
};

// 시험용 직접 조작: 상대 기기가 서버에 남긴 행을 흉내 냅니다(어댑터의 inject에 해당).
state.ensureFamily = (key) => { if (!state.families.has(key)) createFamily(key); };
state.injectLog = (key, log, serverTime = now()) => {
  state.ensureFamily(key);
  familyLogs(key).set(log.id, {
    clientUpdatedAt: log.updatedAt || log.timestamp || 0,
    updatedAt: serverTime,
    deletedAt: null,
    rawJson: canonical(log),
  });
};
state.injectTombstone = (key, id, serverTime = now()) => {
  state.ensureFamily(key);
  familyLogs(key).set(id, {
    clientUpdatedAt: 0, updatedAt: serverTime, deletedAt: serverTime, rawJson: canonical({ deleted: true, id }),
  });
};
state.liveLogs = (key) =>
  [...familyLogs(key).entries()].filter(([, row]) => row.deletedAt === null).map(([id, row]) => [id, row.rawJson]);
state.deletedIds = (key) =>
  [...familyLogs(key).entries()].filter(([, row]) => row.deletedAt !== null).map(([id]) => id);
state.addMember = (key, clientId) => {
  let set = state.members.get(key);
  if (!set) { set = new Set(); state.members.set(key, set); }
  set.add(clientId);
};
state.reset = () => {
  state.members.clear();
  state.families.clear();
  state.logs.clear();
  state.deleted.clear();
  state.commits.length = 0;
  state.requests.length = 0;
};

const isCompleteShared = (p) =>
  p && typeof p === 'object'
  && typeof p.name === 'string' && typeof p.birthDate === 'string' && typeof p.birthWeight === 'string'
  && typeof p.targetFormula === 'number' && Number.isFinite(p.targetFormula);

const remoteProfileOf = (family) =>
  family.sharedJson === null ? undefined : { ...JSON.parse(family.sharedJson), sharedUpdatedAt: family.profileUpdatedAt };

async function handleSync(key, clientId, bodyText) {
  if (state.beforeRead) {
    const hook = state.beforeRead;
    state.beforeRead = null;
    await hook();
  }
  const request = { kind: 'sync', clientId, pushLogs: 0, pushDeleted: 0, pull: null, status: 200, writes: 0, bodyBytes: 0, logWrites: 0, committed: false };
  state.requests.push(request);
  const fail = (response) => { request.status = response.status; return response; };

  request.bodyBytes = encoder.encode(bodyText).length;
  if (request.bodyBytes > MAX_BODY_BYTES) {
    return fail(makeJsonResponse({ ok: false, error: 'payload_too_large' }, 413));
  }
  let body;
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return fail(makeJsonResponse({ ok: false, error: 'invalid_json' }, 400)); }
  const pushLogs = Array.isArray(body.pushLogs) ? body.pushLogs : [];
  const pushDeletedIds = Array.isArray(body.pushDeletedIds) ? body.pushDeletedIds : [];
  request.pushLogs = pushLogs.length;
  request.pushDeleted = pushDeletedIds.length;
  request.hasProfile = !!body.pushProfile;
  if (body.pull) {
    request.pull = { after: [Number(body.pull.afterUpdatedAt) || 0, String(body.pull.afterLogId ?? '')], limit: body.pull.limit };
  }
  if (pushLogs.length + pushDeletedIds.length > MAX_REQUEST_ITEMS) {
    return fail(makeJsonResponse({ ok: false, error: 'too_many_items' }, 413));
  }
  // 어댑터(server-adapter.mjs)의 멈춤과 실패 주입이 쓰는 훅입니다. 기다릴 수 있고, {status}를 돌려주면 그 응답으로 끝납니다.
  if (state.onRequest) {
    const outcome = await state.onRequest(body, request);
    if (outcome?.status) return fail(makeJsonResponse({ ok: false, error: `injected_${outcome.status}` }, outcome.status));
  }
  if (state.failNextSync) {
    const status = typeof state.failNextSync === 'function' ? state.failNextSync(body, request) : state.failNextSync;
    if (typeof state.failNextSync !== 'function') state.failNextSync = null;
    if (status) return fail(makeJsonResponse({ ok: false, error: `injected_${status}` }, status));
  }
  const family = state.families.get(key);
  if (!family) return fail(missingResponse(key));
  if (state.beforeTransaction) await state.beforeTransaction();

  const logs = familyLogs(key);
  const t = now();
  const written = { logs: [], tombstones: [], profile: false };

  // 쓰기 계획: 확정 전에 커밋 실패 훅을 부를 수 있도록 먼저 모읍니다.
  const plan = [];
  for (const log of pushLogs) {
    if (!log || typeof log.id !== 'string') continue;
    const clientUpdatedAt = log.updatedAt || log.timestamp || 0;
    const rawJson = canonical(log);
    const existing = logs.get(log.id);
    if (!existing) plan.push({ type: 'insert', id: log.id, clientUpdatedAt, rawJson });
    else if (existing.deletedAt === null
      && (clientUpdatedAt > existing.clientUpdatedAt
        || (clientUpdatedAt === existing.clientUpdatedAt && compareCodePoints(rawJson, existing.rawJson) > 0))) {
      plan.push({ type: 'update', id: log.id, clientUpdatedAt, rawJson });
    }
  }
  for (const id of pushDeletedIds) {
    if (typeof id !== 'string') continue;
    const existing = logs.get(id);
    if (!existing || existing.deletedAt === null) plan.push({ type: 'tombstone', id });
  }
  let profileRejected = false;
  let profileWrite = null;
  if (body.pushProfile) {
    const p = body.pushProfile;
    const ts = p.sharedUpdatedAt;
    if (!isCompleteShared(p) || typeof ts !== 'number' || !Number.isFinite(ts)) profileRejected = true;
    else {
      const json = canonical({ name: p.name, birthDate: p.birthDate, birthWeight: p.birthWeight, targetFormula: p.targetFormula });
      if (family.profileUpdatedAt < ts
        || (family.profileUpdatedAt === ts && compareCodePoints(family.sharedJson ?? '', json) < 0)) {
        profileWrite = { json, ts };
      }
    }
  }
  if (state.beforeCommit) {
    try { await state.beforeCommit(plan); } catch (error) {
      return fail(makeJsonResponse({ ok: false, error: String(error?.message || error) }, 500));
    }
  }
  for (const w of plan) {
    if (w.type === 'tombstone') {
      logs.set(w.id, { clientUpdatedAt: 0, updatedAt: t, deletedAt: t, rawJson: canonical({ deleted: true, id: w.id }) });
      written.tombstones.push(w.id);
    } else {
      logs.set(w.id, { clientUpdatedAt: w.clientUpdatedAt, updatedAt: t, deletedAt: null, rawJson: w.rawJson });
      written.logs.push(w.id);
    }
  }
  if (profileWrite) {
    family.sharedJson = profileWrite.json;
    family.profileUpdatedAt = profileWrite.ts;
    written.profile = true;
  }
  request.writes = written.logs.length + written.tombstones.length + (written.profile ? 1 : 0);
  request.logWrites = written.logs.length + written.tombstones.length;
  request.committed = request.writes > 0;
  if (request.writes > 0) {
    family.updatedAt = t;
    family.lastClientId = clientId;
    state.commits.push(written);
  }

  // 올리기 분류: 보낸 기록 id의 서버 행을 다시 읽어 나눕니다. skipPull 요청도 같습니다.
  const acceptedIds = [];
  const remoteLogs = [];
  const remoteDeletedIds = [];
  const seen = new Set();
  for (const log of pushLogs) {
    if (!log || typeof log.id !== 'string' || seen.has(log.id)) continue;
    seen.add(log.id);
    const row = logs.get(log.id);
    if (!row || state.rejectAllPushes) continue;
    if (row.deletedAt !== null) remoteDeletedIds.push(log.id);
    else if (row.rawJson === canonical(log)) acceptedIds.push(log.id);
    else remoteLogs.push(JSON.parse(row.rawJson));
  }

  const response = {
    ok: true,
    acceptedIds,
    remoteLogs,
    remoteDeletedIds,
    maxPushItems: state.maxPushItems,
    maxPageRows: state.maxPageRows,
  };
  if (profileRejected) response.profileRejected = true;

  if (body.pull) {
    const [afterAt, afterId] = request.pull.after;
    const limit = Math.min(state.maxPageRows, Math.max(25, Math.floor(Number(body.pull.limit)) || 500));
    response.cursorCandidate = t - CURSOR_MARGIN_MS;
    const rows = [...logs.entries()]
      .filter(([id, row]) => row.updatedAt > afterAt || (row.updatedAt === afterAt && id > afterId))
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const page = [];
    let bytes = 0;
    let hasMore = false;
    for (const [id, row] of rows) {
      if (page.length >= limit) { hasMore = true; break; }
      page.push([id, row]);
      bytes += encoder.encode(row.rawJson).length;
      if (bytes >= MAX_PAGE_BYTES) { hasMore = rows.length > page.length; break; }
    }
    for (const [id, row] of page) {
      if (seen.has(id) && (acceptedIds.includes(id) || remoteDeletedIds.includes(id) || remoteLogs.some(l => l.id === id))) {
        // 올리기 분류에서 이미 담은 id는 한 번만 담습니다.
        continue;
      }
      if (row.deletedAt !== null) remoteDeletedIds.push(id);
      else remoteLogs.push(JSON.parse(row.rawJson));
    }
    response.hasMore = hasMore;
    if (hasMore) {
      const [lastId, lastRow] = page[page.length - 1];
      response.nextAfter = { updatedAt: lastRow.updatedAt, logId: lastId };
    }
  }
  const profile = remoteProfileOf(family);
  if (profile) response.remoteProfile = profile;
  return state.tamperSyncResponse
    ? makeJsonResponse(state.tamperSyncResponse(body, response))
    : makeJsonResponse(response);
}

globalThis.fetch = async function fakeFetch(url, options = {}) {
  if (state.offline) {
    throw new TypeError('Network request failed');
  }

  const parsedUrl = new URL(String(url));
  const pathname = parsedUrl.pathname;
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});

  const authHeader = headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+([a-zA-Z0-9_-]+)$/i);
  const syncKey = match ? match[1] : '';
  const clientId = headers.get('X-Client-Id') || 'test-client';

  // 1. POST /api/family/connect
  if (pathname === '/api/family/connect' && method === 'POST') {
    state.requests.push({ kind: 'connect', clientId, status: 200 });
    const body = options.body ? JSON.parse(options.body) : {};
    if (state.families.has(syncKey)) {
      state.addMember(syncKey, clientId);
      return makeJsonResponse({ ok: true, isNewFamily: false });
    }
    // 영구 삭제한 가족은 allowCreate와 상관없이 410이고 다시 생기지 않습니다.
    if (state.deleted.has(syncKey) || !body.allowCreate) return missingResponse(syncKey);
    createFamily(syncKey);
    state.addMember(syncKey, clientId);
    return makeJsonResponse({ ok: true, isNewFamily: true });
  }

  // 2. GET /api/family/token
  if (pathname === '/api/family/token' && method === 'GET') {
    if (state.beforeRead) await state.beforeRead();
    const fam = state.families.get(syncKey);
    if (!fam) return missingResponse(syncKey);
    const tokenResponse = {
      ok: true,
      changeToken: `${fam.updatedAt}:${fam.lastClientId || ''}`,
      profileUpdatedAt: fam.profileUpdatedAt || 0,
      deletionReadyAt: fam.pendingDeletionAt || null,
    };
    // members=1이면 요청한 클라이언트가 아닌 회원 수를 싣습니다(07 2.7-2). 값이 없으면 응답은 그대로입니다.
    if (parsedUrl.searchParams.get('members') === '1') {
      const others = [...(state.members.get(syncKey) ?? [])].filter((id) => id !== clientId);
      tokenResponse.otherMembers = others.length;
    }
    return makeJsonResponse(tokenResponse);
  }

  // 3. POST /api/family/sync
  if (pathname === '/api/family/sync' && method === 'POST') {
    return handleSync(syncKey, clientId, options.body ? String(options.body) : '');
  }

  // 4. POST /api/family/delete-schedule
  if (pathname === '/api/family/delete-schedule' && method === 'POST') {
    const fam = state.families.get(syncKey);
    if (!fam) return missingResponse(syncKey);
    const readyAt = now() + 60 * 60 * 1000;
    fam.pendingDeletionAt = readyAt;
    return makeJsonResponse({ ok: true, readyAt });
  }

  // 5. POST /api/family/cancel-delete
  if (pathname === '/api/family/cancel-delete' && method === 'POST') {
    const fam = state.families.get(syncKey);
    if (!fam) return missingResponse(syncKey);
    fam.pendingDeletionAt = null;
    return makeJsonResponse({ ok: true });
  }

  // 6. POST /api/family/delete (냉각 기간 검증 강제)
  if (pathname === '/api/family/delete' && method === 'POST') {
    // 1.7.9 삭제 따르기(07 2.7-1): 가족이 없을 때만 삭제 기록을 남깁니다. 가족이 있으면 409, 이미 삭제됐으면 410.
    const legacyBody = options.body ? JSON.parse(options.body) : {};
    if (legacyBody.legacyDeletion === true) {
      if (state.families.has(syncKey)) return makeJsonResponse({ ok: false, error: 'family_exists' }, 409);
      if (state.deleted.has(syncKey)) return makeJsonResponse({ ok: false, error: 'family_deleted' }, 410);
      state.deleted.add(syncKey);
      return makeJsonResponse({ ok: true });
    }
    const fam = state.families.get(syncKey);
    if (!fam) return missingResponse(syncKey);
    if (!fam.pendingDeletionAt || fam.pendingDeletionAt > now()) {
      return makeJsonResponse({ ok: false, error: 'cooling_period_active' }, 400);
    }
    state.families.delete(syncKey);
    state.logs.delete(syncKey);
    state.members.delete(syncKey);
    state.deleted.add(syncKey);
    return makeJsonResponse({ ok: true });
  }

  // 7. GET /api/family/deletion-status
  if (pathname === '/api/family/deletion-status' && method === 'GET') {
    const fam = state.families.get(syncKey);
    if (!fam) return missingResponse(syncKey);
    const scheduled = !!fam.pendingDeletionAt;
    const readyAt = fam.pendingDeletionAt || undefined;
    const canDeleteNow = scheduled && (readyAt <= now());
    return makeJsonResponse({ ok: true, scheduled, readyAt, canDeleteNow });
  }

  return originalFetch.apply(this, arguments);
};
