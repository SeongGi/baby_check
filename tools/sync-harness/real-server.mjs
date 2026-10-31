// 실제 Worker 코드(server/src/index.ts)를 node:sqlite D1 흉내 위에서 HTTP 서버로 띄웁니다(06 설계 2.10).
// 첫 줄에 {"harness":"real-server","port":N} 한 줄을 출력하고, stdin이 닫히면 스스로 끝납니다.
//
// 제어 엔드포인트(모두 POST, JSON 본문, JSON 응답). 경로가 /__harness/ 로 시작하면 Worker에 넘기기 전에 가로챕니다.
//   clock    {set: ms} 고정 시각으로 맞춤 | {advance: ms} 진행 | {real: true} 실제 시각으로 복귀 | {} 조회
//   hold     {op:'add', match, at?, delayMs?, skip?, times?} 조건에 맞는 요청, 배치, 문장을 멈춤 -> {ruleId}
//            {op:'list'} -> {rules, held} | {op:'remove', ruleId} | {op:'clear'}
//   release  {id} | {ruleId} | {all: true} 멈춘 것을 풀어 줌 -> {released: [id...]}
//   fail     {op:'add', mode, match, at?, status?, skip?, times?} 실패 주입 -> {ruleId}
//            mode: beforeCommit | afterCommit | http (status 기본 503, http503도 같은 뜻) | drop
//            {op:'list'} | {op:'remove', ruleId} | {op:'clear'}
//   state    {q:'requests'|'family'|'logs'|'stats'|'held'|'config', key?, from?} 서버 상태 조회
//   inject   {key, ensureFamily?, family?, log?, logs?, tombstone?, tombstones?, serverTime?, member?, remove?, gone?}
//   wipe     {scope:'logs'|'all'|'snapshot'|'restore'|'reset', name?}
//   config   {maxPushItems?, maxPageRows?} 서버 상수 변경
//   fs       {op, ...} 가짜 Firestore 제어(상태 시드, 시계, 집계, 오류 주입, 걸쇠, 1.7.9 흉내). 사용법은 stubs/fake-firestore-state.mjs 머리말
//            기기의 가짜 Firebase SDK는 POST /__fs/rpc 로 같은 상태에 질의합니다(07 설계 5.1).
// match 필드: kind(push|pull|connect|token|other|sync, 배열 가능), clientId, hasPushItems, batch(write|read).
// 문장 걸쇠(at: statement, match.sql이나 match.statement가 있으면 기본): Worker 호출 안의 D1 문장 하나의 앞이나 뒤에서 멈춤.
//   match.sql        문장 SQL에 맞는 정규식 소스(대소문자 무시). 예) 'INSERT[\\s\\S]*deleted_families'
//   match.statement  그 호출 안에서 1부터 세는 문장 번호(batch는 문장마다 하나)
//   match.when       before(문장 실행 전) | after(실행 뒤, 기본). 요청 종류 match(kind, clientId)와 함께 쓸 수 있음
//   실행 뒤에 멈추면 그 문장의 효과는 이미 확정된 채로 다른 요청이 끼어든다. 실행 전에 멈추면 아직 아무것도 안 한 채로 끼어든다.
// at: start(Worker 호출 전, 기본) | response(Worker 처리 뒤 응답 전) | batch(match.batch가 있으면 기본) | statement.
// skip: 앞의 N번은 건너뜀(기본 0). times: 적용 횟수(기본 1, 'always'는 무제한).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createD1Mock } from './stubs/d1-mock.mjs';
import { createFakeFirestore } from './stubs/fake-firestore-state.mjs';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HARNESS_DIR, '../..');
const worker = (await import(pathToFileURL(path.join(PROJECT_DIR, 'server/src/index.ts')).href)).default;
const schemaSql = readFileSync(path.join(PROJECT_DIR, 'server/schema.sql'), 'utf8');

const DEFAULT_MAX_PUSH_ITEMS = 400;
const DEFAULT_MAX_PAGE_ROWS = 500;

// ────────────── 서버 시계 ──────────────
const clock = { fixed: null, offset: 0 };
const nowMs = () => (clock.fixed !== null ? clock.fixed : Date.now() + clock.offset);
const clockStatus = () => ({ now: nowMs(), mode: clock.fixed !== null ? 'fixed' : 'real', offsetMs: clock.offset });

// ────────────── 환경과 규칙 ──────────────
const config = { maxPushItems: DEFAULT_MAX_PUSH_ITEMS, maxPageRows: DEFAULT_MAX_PAGE_ROWS };
const applyEnvConfig = () => {
  env.MAX_PUSH_ITEMS = String(config.maxPushItems);
  env.MAX_PAGE_ROWS = String(config.maxPageRows);
};
const fakeFirestore = createFakeFirestore();
const env = { DB: null, clock: nowMs, MAX_PUSH_ITEMS: '', MAX_PAGE_ROWS: '' };
if (process.env.HARNESS_MAX_PUSH_ITEMS) config.maxPushItems = Number(process.env.HARNESS_MAX_PUSH_ITEMS);
if (process.env.HARNESS_MAX_PAGE_ROWS) config.maxPageRows = Number(process.env.HARNESS_MAX_PAGE_ROWS);
applyEnvConfig();

let nextId = 1;
const holdRules = [];
const failRules = [];
const held = [];
const requests = [];
const snapshots = new Map();
let inflight = 0;

const sanitizeClientId = (value) => (String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown-client');
const familyIdOf = (key) =>
  createHash('sha256').update(`babycheck:family:v2:${String(key).toLowerCase()}`).digest('hex');

const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item).sort().reduce((sorted, k) => {
          if (item[k] !== undefined) sorted[k] = item[k];
          return sorted;
        }, {})
      : item);

function matches(match, info, stage) {
  if (match.kind) {
    const kinds = [].concat(match.kind).flatMap((k) => (k === 'sync' ? ['push', 'pull'] : [k]));
    if (!kinds.includes(info.kind)) return false;
  }
  if (match.clientId && sanitizeClientId(match.clientId) !== info.clientId) return false;
  if (match.hasPushItems !== undefined && Boolean(match.hasPushItems) !== Boolean(info.hasPushItems)) return false;
  if (stage === 'batch' && match.batch && match.batch !== 'any' && match.batch !== info.batchKind) return false;
  if (stage === 'statement') {
    if ((match.when || 'after') !== info.phase) return false;
    if (match.sql !== undefined && !new RegExp(match.sql, 'i').test(info.sql)) return false;
    if (match.statement !== undefined && Number(match.statement) !== info.statementIndex) return false;
  }
  return true;
}

// 조건이 맞은 규칙 중 이번에 실제로 적용되는 것을 돌려줍니다(skip과 times를 셉니다).
function takeRule(rules, stage, info) {
  for (const rule of rules) {
    if (rule.at !== stage || !matches(rule.match, info, stage)) continue;
    rule.seen += 1;
    if (rule.seen <= rule.skip) continue;
    if (rule.times !== Infinity && rule.fired >= rule.times) continue;
    rule.fired += 1;
    return rule;
  }
  return null;
}

function buildRule(body, kindLabel) {
  const match = body.match || {};
  const statementMatch = match.sql !== undefined || match.statement !== undefined || match.when !== undefined;
  const at = body.at || (match.batch ? 'batch' : (statementMatch ? 'statement' : 'start'));
  if (!['start', 'response', 'batch', 'statement'].includes(at)) throw new Error(`알 수 없는 at: ${at}`);
  if (match.batch && at !== 'batch') throw new Error('match.batch는 at이 batch일 때만 쓸 수 있습니다');
  if (statementMatch && at !== 'statement') throw new Error('match.sql, statement, when은 at이 statement일 때만 쓸 수 있습니다');
  if (match.when !== undefined && !['before', 'after'].includes(match.when)) throw new Error(`알 수 없는 match.when: ${match.when}`);
  if (match.sql !== undefined) new RegExp(match.sql, 'i');
  const rule = {
    id: `${kindLabel}-${nextId++}`,
    match,
    at,
    skip: Number(body.skip) || 0,
    times: body.times === 'always' ? Infinity : (body.times === undefined ? 1 : Number(body.times)),
    seen: 0,
    fired: 0,
  };
  return rule;
}

const publicRule = (rule) => ({ ...rule, times: rule.times === Infinity ? 'always' : rule.times });

function releaseItem(item) {
  const index = held.indexOf(item);
  if (index < 0) return false;
  held.splice(index, 1);
  clearTimeout(item.timer);
  item.resolve();
  return true;
}

function holdPoint(rule, stage, info, record) {
  return new Promise((resolve) => {
    const item = {
      id: `held-${nextId++}`,
      ruleId: rule.id,
      stage,
      kind: info.kind,
      batch: info.batchKind || null,
      clientId: info.clientId,
      seq: record ? record.seq : null,
      since: Date.now(),
      resolve,
      timer: null,
    };
    if (rule.delayMs) item.timer = setTimeout(() => releaseItem(item), rule.delayMs);
    held.push(item);
    if (record) record.held = true;
  });
}

async function applyHolds(stage, info, record) {
  const rule = takeRule(holdRules, stage, info);
  if (!rule) return;
  const started = performance.now();
  await holdPoint(rule, stage, info, record);
  return performance.now() - started;
}

// ────────────── D1 흉내 ──────────────
const d1 = createD1Mock({
  schemaSql,
  async onBatch(ctx, batchKind) {
    const info = { ...ctx.info, batchKind };
    const started = performance.now();
    await applyHolds('batch', info, ctx.record);
    ctx.heldMs += performance.now() - started;
    const fault = takeRule(failRules, 'batch', info);
    if (!fault) return {};
    if (fault.mode === 'beforeCommit') return { failBeforeCommit: true };
    if (fault.mode === 'afterCommit') return { failAfterCommit: true };
    return {};
  },
  // 문장 걸쇠: 걸리는 규칙이 없으면 undefined를 돌려줘 D1 흉내가 기다리지 않는다.
  onStatement(ctx, point) {
    if (!holdRules.some((r) => r.at === 'statement')) return undefined;
    const info = { ...ctx.info, phase: point.phase, sql: point.sql, statementIndex: point.index };
    const rule = takeRule(holdRules, 'statement', info);
    if (!rule) return undefined;
    const started = performance.now();
    return holdPoint(rule, 'statement', info, ctx.record).then(() => { ctx.heldMs += performance.now() - started; });
  },
});
env.DB = d1.db;

// ────────────── 요청 처리 ──────────────
function classify(method, pathname, json) {
  if (pathname === '/api/family/connect') return 'connect';
  if (pathname === '/api/family/token') return 'token';
  if (pathname === '/api/family/sync' && method === 'POST') {
    return json && typeof json === 'object' && json.pull && typeof json.pull === 'object' ? 'pull' : 'push';
  }
  return 'other';
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

function startRecord(req, pathname, body, json) {
  const kind = classify(req.method, pathname, json);
  const pushLogs = Array.isArray(json?.pushLogs) ? json.pushLogs.length : 0;
  const pushDeleted = Array.isArray(json?.pushDeletedIds) ? json.pushDeletedIds.length : 0;
  const pull = json?.pull && typeof json.pull === 'object'
    ? {
        after: [Number(json.pull.afterUpdatedAt) || 0, String(json.pull.afterLogId ?? '')],
        limit: json.pull.limit,
      }
    : null;
  const record = {
    seq: requests.length,
    path: pathname,
    method: req.method,
    kind,
    clientId: sanitizeClientId(req.headers['x-client-id']),
    bodyBytes: body.length,
    pushLogs,
    pushDeleted,
    hasProfile: Boolean(json?.pushProfile),
    pull,
    status: null,
    held: false,
    dropped: false,
    queries: 0,
    rowsRead: 0,
    rowsWritten: 0,
    writtenByTable: {},
    changedByTable: {},
    committed: false,
    logWrites: 0,
    workerMs: 0,
    startedAt: nowMs(),
  };
  requests.push(record);
  return record;
}

function finishRecord(record, ctx, startedAt) {
  record.queries = ctx.queries;
  record.rowsRead = ctx.rowsRead;
  record.rowsWritten = ctx.rowsWritten;
  record.writtenByTable = { ...ctx.writtenByTable };
  record.changedByTable = { ...ctx.changedByTable };
  record.logWrites = ctx.changedByTable.logs || 0;
  record.committed = (ctx.changedByTable.families || 0) > 0 || (ctx.changedByTable.logs || 0) > 0;
  record.workerMs = Math.round((performance.now() - startedAt - ctx.heldMs) * 100) / 100;
}

function sendFault(res, record, fault) {
  if (fault.mode === 'drop') {
    record.dropped = true;
    record.status = 0;
    res.socket?.destroy();
    return;
  }
  const status = Number(fault.status) || 503;
  record.status = status;
  const text = JSON.stringify({ ok: false, error: `harness_injected_${status}` });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

const isHttpFault = (fault) => fault.mode === 'http' || fault.mode === 'http503' || fault.mode === 'drop';

async function handleWorkerRequest(req, res, url) {
  const body = await readBody(req);
  const text = body.toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const record = startRecord(req, url.pathname, body, json);
  const info = {
    kind: record.kind,
    clientId: record.clientId,
    hasPushItems: record.pushLogs + record.pushDeleted > 0,
    path: url.pathname,
  };
  inflight += 1;
  try {
    await applyHolds('start', info, record);
    const startFault = takeRule(failRules.filter(isHttpFault), 'start', info);
    if (startFault) { sendFault(res, record, startFault); return; }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (['host', 'connection', 'transfer-encoding'].includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: hasBody ? body : undefined });
    const ctx = d1.newContext({ info, record });
    const startedAt = performance.now();
    const response = await d1.runInvocation(ctx, () => worker.fetch(request, env));
    const responseText = await response.text();
    finishRecord(record, ctx, startedAt);

    await applyHolds('response', info, record);
    const responseFault = takeRule(failRules.filter(isHttpFault), 'response', info);
    if (responseFault) { sendFault(res, record, responseFault); return; }

    record.status = response.status;
    const outHeaders = {};
    response.headers.forEach((value, name) => { outHeaders[name] = value; });
    res.writeHead(response.status, outHeaders);
    res.end(responseText);
  } catch (error) {
    record.status = record.status ?? 500;
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `harness_server_error: ${error?.message || error}` }));
  } finally {
    inflight -= 1;
  }
}

// ────────────── 제어 엔드포인트 ──────────────
const plain = (row) => (row ? { ...row } : null);

function familyState(key) {
  const id = familyIdOf(key);
  const row = plain(d1.raw.prepare('SELECT * FROM families WHERE id = ?').get(id));
  const deleted = Boolean(d1.raw.prepare('SELECT 1 AS x FROM deleted_families WHERE id = ?').get(id));
  const members = d1.raw.prepare('SELECT client_id, created_at, last_active_at FROM members WHERE family_id = ? ORDER BY client_id')
    .all(id).map((m) => ({ clientId: m.client_id, createdAt: m.created_at, lastActiveAt: m.last_active_at }));
  return {
    exists: Boolean(row),
    deleted,
    token: row ? `${row.updated_at}:${row.last_client_id || ''}` : null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
    lastClientId: row?.last_client_id ?? null,
    pendingDeletionAt: row?.deletion_ready_at ?? null,
    sharedJson: row?.shared_json ?? null,
    profileUpdatedAt: row?.profile_updated_at ?? null,
    members,
  };
}

function logsState(key) {
  const rows = d1.raw.prepare(
    'SELECT log_id, client_updated_at, updated_at, deleted_at, raw_json FROM logs WHERE family_id = ? ORDER BY log_id',
  ).all(familyIdOf(key)).map((r) => ({
    id: r.log_id,
    clientUpdatedAt: r.client_updated_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    raw: r.raw_json,
  }));
  return {
    rows,
    live: rows.filter((r) => r.deletedAt === null).map((r) => [r.id, r.raw]),
    deleted: rows.filter((r) => r.deletedAt !== null).map((r) => r.id),
  };
}

function statsState() {
  const total = { rowsRead: 0, rowsWritten: 0, writtenByTable: {}, queries: 0 };
  for (const r of requests) {
    total.rowsRead += r.rowsRead;
    total.rowsWritten += r.rowsWritten;
    total.queries += r.queries;
    for (const [table, n] of Object.entries(r.writtenByTable)) total.writtenByTable[table] = (total.writtenByTable[table] || 0) + n;
  }
  return { ...total, requestCount: requests.length, inflight };
}

const heldView = () => held.map(({ resolve: _resolve, timer: _timer, ...item }) => item);

function ensureFamily(id, t = nowMs()) {
  d1.raw.prepare('INSERT OR IGNORE INTO families (id, created_at, updated_at, last_client_id) VALUES (?, ?, ?, NULL)').run(id, t, t);
}

function injectState(body) {
  const id = familyIdOf(body.key);
  const serverTime = body.serverTime ?? nowMs();
  if (body.remove || body.gone) {
    d1.raw.prepare('DELETE FROM logs WHERE family_id = ?').run(id);
    d1.raw.prepare('DELETE FROM members WHERE family_id = ?').run(id);
    d1.raw.prepare('DELETE FROM families WHERE id = ?').run(id);
    if (body.gone) d1.raw.prepare('INSERT OR REPLACE INTO deleted_families (id, deleted_at) VALUES (?, ?)').run(id, serverTime);
    d1.invalidateCounts();
    return { injected: body.gone ? 'gone' : 'removed' };
  }
  const logs = [...(body.logs || []), ...(body.log ? [body.log] : [])];
  const tombstones = [...(body.tombstones || []), ...(body.tombstone ? [body.tombstone] : [])];
  ensureFamily(id, serverTime);
  const upsert = d1.raw.prepare(
    'INSERT OR REPLACE INTO logs (family_id, log_id, client_updated_at, updated_at, deleted_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const log of logs) {
    upsert.run(id, log.id, log.updatedAt || log.timestamp || 0, serverTime, null, canonical(log));
  }
  for (const logId of tombstones) {
    upsert.run(id, logId, 0, serverTime, serverTime, canonical({ deleted: true, id: logId }));
  }
  if (body.member) {
    d1.raw.prepare(
      'INSERT OR REPLACE INTO members (family_id, client_id, created_at, last_active_at) VALUES (?, ?, ?, ?)',
    ).run(id, sanitizeClientId(body.member), serverTime, serverTime);
  }
  if (body.family) {
    const columns = {
      sharedJson: 'shared_json',
      profileUpdatedAt: 'profile_updated_at',
      pendingDeletionAt: 'deletion_ready_at',
      updatedAt: 'updated_at',
      lastClientId: 'last_client_id',
      createdAt: 'created_at',
    };
    for (const [field, value] of Object.entries(body.family)) {
      const column = columns[field];
      if (!column) throw new Error(`알 수 없는 family 필드: ${field}`);
      d1.raw.prepare(`UPDATE families SET ${column} = ? WHERE id = ?`).run(value, id);
    }
  }
  d1.invalidateCounts();
  return { injected: { logs: logs.length, tombstones: tombstones.length } };
}

const TABLES = ['families', 'members', 'deleted_families', 'logs'];

function wipeState(body) {
  const scope = body.scope;
  if (scope === 'logs') {
    d1.raw.exec('DELETE FROM logs');
  } else if (scope === 'all') {
    for (const table of TABLES) d1.raw.exec(`DELETE FROM ${table}`);
  } else if (scope === 'snapshot') {
    const data = {};
    for (const table of TABLES) data[table] = d1.raw.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
    snapshots.set(body.name || 'default', data);
  } else if (scope === 'restore') {
    const data = snapshots.get(body.name || 'default');
    if (!data) throw new Error(`저장해 둔 사본이 없습니다: ${body.name || 'default'}`);
    for (const table of TABLES) d1.raw.exec(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      for (const row of data[table]) {
        const names = Object.keys(row);
        d1.raw.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
      }
    }
  } else if (scope === 'reset') {
    for (const table of TABLES) d1.raw.exec(`DELETE FROM ${table}`);
    for (const item of [...held]) releaseItem(item);
    holdRules.length = 0;
    failRules.length = 0;
    requests.length = 0;
    snapshots.clear();
    fakeFirestore.reset();
    clock.fixed = null;
    clock.offset = 0;
    config.maxPushItems = DEFAULT_MAX_PUSH_ITEMS;
    config.maxPageRows = DEFAULT_MAX_PAGE_ROWS;
    applyEnvConfig();
  } else {
    throw new Error(`알 수 없는 wipe scope: ${scope}`);
  }
  d1.invalidateCounts();
  return { wiped: scope };
}

function ruleOps(body, rules, label, extra) {
  const op = body.op || 'add';
  if (op === 'list') return { rules: rules.map(publicRule) };
  if (op === 'clear') {
    const removed = rules.length;
    rules.length = 0;
    return { removed };
  }
  if (op === 'remove') {
    const index = rules.findIndex((r) => r.id === body.ruleId);
    if (index >= 0) rules.splice(index, 1);
    return { removed: index >= 0 ? 1 : 0 };
  }
  if (op === 'add') {
    const rule = buildRule(body, label);
    extra(rule);
    rules.push(rule);
    return { ruleId: rule.id };
  }
  throw new Error(`알 수 없는 op: ${op}`);
}

function control(name, body) {
  switch (name) {
    case 'clock': {
      if (body.real) { clock.fixed = null; clock.offset = 0; }
      if (body.set !== undefined) clock.fixed = Number(body.set);
      if (body.advance !== undefined) {
        if (clock.fixed !== null) clock.fixed += Number(body.advance);
        else clock.offset += Number(body.advance);
      }
      return clockStatus();
    }
    case 'hold': {
      const result = ruleOps(body, holdRules, 'hold', (rule) => { rule.delayMs = Number(body.delayMs) || 0; });
      if (body.op === 'list' || body.op === 'clear' || body.op === 'remove') {
        if (body.op !== 'list') for (const item of [...held]) if (!holdRules.some((r) => r.id === item.ruleId)) releaseItem(item);
        return { ...result, held: heldView() };
      }
      return result;
    }
    case 'release': {
      const released = [];
      for (const item of [...held]) {
        if (body.all || item.id === body.id || item.ruleId === body.ruleId) {
          if (releaseItem(item)) released.push(item.id);
        }
      }
      if (body.ruleId) {
        const index = holdRules.findIndex((r) => r.id === body.ruleId);
        if (index >= 0) holdRules.splice(index, 1);
      }
      return { released };
    }
    case 'fail': {
      return ruleOps(body, failRules, 'fail', (rule) => {
        rule.mode = body.mode;
        rule.status = body.status;
        if (!['beforeCommit', 'afterCommit', 'http', 'http503', 'drop'].includes(rule.mode)) {
          throw new Error(`알 수 없는 fail mode: ${rule.mode}`);
        }
        if ((rule.mode === 'beforeCommit' || rule.mode === 'afterCommit')) {
          rule.at = 'batch';
          if (!rule.match.batch) rule.match = { ...rule.match, batch: 'write' };
        } else if (rule.at === 'batch') {
          throw new Error('http, drop 실패는 at이 start나 response여야 합니다');
        }
      });
    }
    case 'state': {
      switch (body.q) {
        case 'requests': {
          const from = Number(body.from) || 0;
          return { count: requests.length, requests: requests.slice(from) };
        }
        case 'family': return familyState(body.key);
        case 'logs': return logsState(body.key);
        case 'stats': return statsState();
        case 'held': return { held: heldView() };
        case 'config': return { ...config, clock: clockStatus() };
        default: throw new Error(`알 수 없는 state 질의: ${body.q}`);
      }
    }
    case 'fs': return fakeFirestore.control(body);
    case 'inject': return injectState(body);
    case 'wipe': return wipeState(body);
    case 'config': {
      if (body.maxPushItems !== undefined) config.maxPushItems = Number(body.maxPushItems);
      if (body.maxPageRows !== undefined) config.maxPageRows = Number(body.maxPageRows);
      applyEnvConfig();
      return { ...config };
    }
    default: throw new Error(`알 수 없는 제어 엔드포인트: ${name}`);
  }
}

async function handleControl(req, res, url) {
  const name = url.pathname.slice('/__harness/'.length);
  try {
    const text = (await readBody(req)).toString('utf8');
    const body = text ? JSON.parse(text) : {};
    const result = control(name, body);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  }
}

// 기기의 가짜 Firebase SDK 요청. D1 요청 기록과 섞이지 않게 따로 처리합니다.
async function handleFirestoreRpc(req, res) {
  const text = (await readBody(req)).toString('utf8');
  const result = await fakeFirestore.rpc(JSON.parse(text));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const run = url.pathname === '/__fs/rpc' ? handleFirestoreRpc
    : url.pathname.startsWith('/__harness/') ? handleControl : handleWorkerRequest;
  run(req, res, url).catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error?.message || error));
  });
});
server.keepAliveTimeout = 5_000;

const shutdown = () => {
  for (const item of [...held]) releaseItem(item);
  fakeFirestore.release();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// 부모(하네스)가 먼저 죽어도 서버가 남지 않도록 stdin이 닫히면 끝냅니다.
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.resume();

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ harness: 'real-server', port: server.address().port })}\n`);
});
