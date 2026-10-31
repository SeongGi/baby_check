// 가짜 Firestore의 서버 쪽입니다(07 설계 5.1). real-server.mjs 프로세스가 이 상태를 갖고, 기기 프로세스의 가짜 SDK
// (stubs/fake-firestore.mjs)가 HTTP로 질의합니다. 그래서 두 기기가 같은 Firestore를 봅니다.
//
// 흉내 내는 것: firestore.rules(tools/rules-check/rules.test.mjs가 에뮬레이터로 확인하는 가정 8가지와 같은 동작),
// 문서 읽기 수와 규칙 평가 읽기 수 집계, 앱 쓰기 목록, 끝나지 않는 호출과 오류 주입, 걸쇠(hold), terminate와 재생성,
// 시계 주입, 1.7.9 기기의 쓰기(legacy179*).
//
// 값의 부호화: Timestamp는 {__ts: 밀리초}, 서버 시각 자리표시자는 {__serverTs: true}로 오갑니다.
//
// 제어 엔드포인트(POST /__harness/fs, 본문 {op, ...}):
//   reset | clock {set|advance|real} | seed {key, family?, members?, logs?, tombstones?, profile?, docs?, serverTime?}
//   snapshot {key} | getDoc {path} | putDoc {path, data, merge?} | removeFamily {key} | removeDoc {path}
//   stats {from?} | ops {from?} | opCount | writes {from?, actor?} | audit {from?} | instances | offline {on}
//   faults {action:'add'|'list'|'remove'|'clear', match, mode:'error'|'hang'|'delay', code?, message?, delayMs?, skip?, times?}
//   holds {action:'add'|'list'|'remove'|'clear', match, delayMs?, skip?, times?} | release {id|ruleId|all}
//   legacy179 {action:'join'|'write'|'schedule'|'cancel', key, uid, ...}
// match: {op: auth|get|list|set|delete|terminate, kind: family|members|logs|profile, device, uid, actor, key, pathIncludes}
import { createHash } from 'node:crypto';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
/** Firestore는 1.7.9와 같이 키를 대소문자 그대로 해시합니다. */
export const firestoreFamilyId = (key) => sha(`babycheck:family:v2:${key}`);
export const firestoreInviteHash = (key) => sha(`babycheck:invite:v2:${key}`);

const isTs = (v) => v !== null && typeof v === 'object' && typeof v.__ts === 'number';
const ts = (ms) => ({ __ts: ms });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resolveServer = (v, t) => {
  if (Array.isArray(v)) return v.map((x) => resolveServer(x, t));
  if (v && typeof v === 'object') {
    if (v.__serverTs) return ts(t);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveServer(x, t)]));
  }
  return v;
};

/** families/<f>[/members|logs|profile[/<id>]] 만 규칙이 있습니다. 나머지는 모두 거부입니다. */
const parse = (path) => {
  const s = path.split('/');
  if (s[0] !== 'families' || s.length > 4 || s.length < 2) return { kind: 'other' };
  if (s.length === 2) return { kind: 'family', f: s[1], doc: true };
  if (!['members', 'logs', 'profile'].includes(s[2])) return { kind: 'other' };
  return s.length === 3 ? { kind: s[2], f: s[1], collection: true } : { kind: s[2], f: s[1], id: s[3], doc: true };
};

const fail = (code, message) => ({ error: { code, message: message || code } });

export function createFakeFirestore() {
  const docs = new Map();
  const ops = [];
  const writeLog = [];
  const instances = new Map();
  const inflight = new Map();
  const faultRules = [];
  const holdRules = [];
  const held = [];
  const clock = { fixed: null, offset: 0 };
  let lastT = 0;
  let nextId = 1;
  let offline = false;

  const now = () => (clock.fixed !== null ? clock.fixed : Date.now() + clock.offset);
  const serverTime = (override) => {
    if (override !== undefined) return override;
    lastT = Math.max(lastT + 1, now());
    return lastT;
  };

  // ── 규칙 ──
  const newRead = () => {
    const seen = new Set();
    return { n: 0, read(path) { if (!seen.has(path)) { seen.add(path); this.n += 1; } return docs.get(path); } };
  };

  /** firestore.rules를 그대로 옮긴 판정. exists()/get()은 요청마다 문서 하나를 한 번씩만 셉니다. */
  function authorize(uid, method, info, resource, request, rr) {
    const member = () => !!uid && rr.read(`families/${info.f}/members/${uid}`) !== undefined;
    const unlocked = () => {
      const p = rr.read(`families/${info.f}`)?.pendingDeletionAt;
      return isTs(p) && now() > p.__ts;
    };
    const pda = (data) => data?.pendingDeletionAt ?? null;
    switch (info.kind) {
      case 'family':
        if (method === 'create') return !!uid && typeof request.inviteHash === 'string' && request.schemaVersion === 3;
        if (method === 'get') return member();
        if (method === 'update') {
          return member() && same(request.inviteHash, resource.inviteHash) && same(request.createdAt, resource.createdAt)
            && (!('pendingDeletionAt' in request) || same(pda(request), pda(resource)) || pda(request) === null
              || (isTs(pda(request)) && pda(request).__ts > now() + 50 * 60_000));
        }
        if (method === 'delete') return member() && isTs(pda(resource)) && now() > pda(resource).__ts;
        return false;
      case 'members':
        if (method === 'create') {
          if (!uid || info.id !== uid) return false;
          const family = rr.read(`families/${info.f}`);
          return !!family && typeof family.inviteHash === 'string' && typeof request.inviteHash === 'string'
            && request.inviteHash === family.inviteHash;
        }
        if (method === 'get') return !!uid && info.id === uid;
        if (method === 'update') return member() && info.id === uid;
        if (method === 'delete') return member() && unlocked();
        return false;
      case 'logs':
        if (method === 'get' || method === 'list' || method === 'create') return member();
        if (method === 'update') return member() && !(resource.deleted === true && request.deleted !== true);
        if (method === 'delete') return member() && unlocked();
        return false;
      case 'profile':
        return member();
      default:
        return false;
    }
  }

  // ── 기록 ──
  const newEntry = (body, extra = {}) => {
    const info = parse(body.path || 'x');
    const entry = {
      seq: ops.length, device: body.device || 'harness', uid: body.uid ?? null, actor: body.actor || 'harness',
      op: body.op, path: body.path ?? null, kind: info.kind, allowed: true, code: null,
      docReads: 0, ruleReads: 0, returned: 0, writes: 0, inflight: 0, fault: null, at: now(), ...extra,
    };
    ops.push(entry);
    return entry;
  };

  const noteWrite = (entry, w, allowed) => writeLog.push({
    seq: entry.seq, device: entry.device, uid: entry.uid, actor: entry.actor, path: w.path, kind: w.kind,
    merge: !!w.merge, fields: w.data ? Object.keys(w.data) : [], data: w.data ?? null, allowed,
  });

  /** 쓰기 묶음을 한 번에 판정하고(하나라도 거부면 아무것도 쓰지 않음) 적용합니다. 트랜잭션과 같은 성질입니다. */
  function applyWriteSet(entry, uid, writes, T) {
    const plans = [];
    for (const w of writes) {
      const info = parse(w.path);
      const existing = docs.get(w.path);
      const rr = newRead();
      let allowed;
      let next;
      if (w.kind === 'delete') {
        allowed = !!info.doc && authorize(uid, 'delete', info, existing ?? {}, null, rr);
      } else {
        const incoming = resolveServer(w.data, T);
        next = w.merge && existing ? { ...existing, ...incoming } : incoming;
        allowed = !!info.doc && authorize(uid, existing ? 'update' : 'create', info, existing ?? {}, next, rr);
      }
      entry.ruleReads += rr.n;
      plans.push({ w, allowed, next });
    }
    const denied = plans.find((p) => !p.allowed);
    plans.forEach((p) => noteWrite(entry, p.w, !denied));
    if (denied) { entry.allowed = false; entry.code = 'permission-denied'; entry.docReads += 1; return fail('permission-denied', 'Missing or insufficient permissions.'); }
    for (const p of plans) {
      if (p.w.kind === 'delete') docs.delete(p.w.path);
      else docs.set(p.w.path, p.next);
      entry.writes += 1;
    }
    return { ok: true };
  }

  // ── 읽기 ──
  function readOp(entry, body) {
    const info = parse(body.path);
    const rr = newRead();
    if (body.op === 'get') {
      const existing = docs.get(body.path);
      const ok = !!info.doc && authorize(body.uid, 'get', info, existing ?? {}, null, rr);
      entry.ruleReads = rr.n;
      entry.docReads = 1;
      if (!ok) { entry.allowed = false; entry.code = 'permission-denied'; return fail('permission-denied', 'Missing or insufficient permissions.'); }
      entry.returned = existing ? 1 : 0;
      return { exists: !!existing, id: body.path.split('/').at(-1), data: existing ?? null };
    }
    const ok = !!info.collection && authorize(body.uid, 'list', info, {}, null, rr);
    entry.ruleReads = rr.n;
    entry.docReads = 1;
    if (!ok) { entry.allowed = false; entry.code = 'permission-denied'; return fail('permission-denied', 'Missing or insufficient permissions.'); }
    const q = body.query || {};
    const prefix = `${body.path}/`;
    let list = [...docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, data]) => ({ id: p.slice(prefix.length), data }));
    for (const w of q.where || []) {
      list = list.filter(({ data }) => {
        const v = data[w.field];
        if (!isTs(v) || !isTs(w.value)) return false;
        return w.cmp === '>=' ? v.__ts >= w.value.__ts : w.cmp === '>' ? v.__ts > w.value.__ts
          : w.cmp === '<=' ? v.__ts <= w.value.__ts : w.cmp === '<' ? v.__ts < w.value.__ts : v.__ts === w.value.__ts;
      });
    }
    const byField = (q.where?.length && !q.orderBy) ? q.where[0].field : null;
    list.sort((a, b) => {
      if (byField) { const d = a.data[byField].__ts - b.data[byField].__ts; if (d) return d; }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    if (q.startAfter !== undefined) list = list.filter((d) => d.id > q.startAfter);
    if (q.limit !== undefined) list = list.slice(0, q.limit);
    entry.docReads = Math.max(1, list.length);
    entry.returned = list.length;
    return { docs: list };
  }

  // ── 오류 주입과 걸쇠 ──
  const matches = (match, info) => {
    if (match.op && ![].concat(match.op).includes(info.op)) return false;
    if (match.kind && ![].concat(match.kind).includes(info.kind)) return false;
    for (const f of ['device', 'uid', 'actor']) if (match[f] && match[f] !== info[f]) return false;
    if (match.key && !(info.path || '').includes(firestoreFamilyId(match.key))) return false;
    if (match.pathIncludes && !(info.path || '').includes(match.pathIncludes)) return false;
    return true;
  };
  const take = (rules, info) => {
    for (const rule of rules) {
      if (!matches(rule.match, info)) continue;
      rule.seen += 1;
      if (rule.seen <= rule.skip) continue;
      if (rule.times !== Infinity && rule.fired >= rule.times) continue;
      rule.fired += 1;
      return rule;
    }
    return null;
  };
  const addRule = (rules, body, extra = {}) => {
    const rule = {
      id: `fs-rule-${nextId++}`, match: body.match || {}, skip: Number(body.skip) || 0, seen: 0, fired: 0,
      times: body.times === 'always' ? Infinity : (body.times === undefined ? 1 : Number(body.times)), ...extra,
    };
    rules.push(rule);
    return { ruleId: rule.id };
  };
  const ruleOps = (rules, body, build) => {
    const action = body.action || 'add';
    if (action === 'list') return { rules: rules.map((r) => ({ ...r, times: r.times === Infinity ? 'always' : r.times })) };
    if (action === 'clear') { const removed = rules.length; rules.length = 0; return { removed }; }
    if (action === 'remove') { const i = rules.findIndex((r) => r.id === body.ruleId); if (i >= 0) rules.splice(i, 1); return { removed: i >= 0 ? 1 : 0 }; }
    return addRule(rules, body, build(body));
  };
  const heldView = () => held.map(({ resolve: _r, timer: _t, ...item }) => item);
  const releaseItem = (item) => {
    const i = held.indexOf(item);
    if (i < 0) return false;
    held.splice(i, 1);
    clearTimeout(item.timer);
    item.resolve();
    return true;
  };

  // ── 기기 쪽 SDK의 요청 ──
  async function rpc(body) {
    const entry = newEntry(body);
    const device = entry.device;
    const count = (inflight.get(device) || 0) + 1;
    inflight.set(device, count);
    entry.inflight = count;
    try {
      if (body.instance) {
        if (!instances.has(body.instance)) instances.set(body.instance, { device, firstSeq: entry.seq, terminated: false });
        if (instances.get(body.instance).terminated && body.op !== 'terminate') {
          entry.allowed = false; entry.code = 'failed-precondition';
          return fail('failed-precondition', 'The client has already been terminated.');
        }
      }
      const info = { op: body.op, kind: entry.kind, path: body.path, device, uid: body.uid, actor: entry.actor };
      const hold = take(holdRules, info);
      if (hold) {
        await new Promise((resolve) => {
          const item = { id: `fs-held-${nextId++}`, ruleId: hold.id, op: body.op, kind: entry.kind, path: body.path, device, seq: entry.seq, resolve, timer: null };
          if (hold.delayMs) item.timer = setTimeout(() => releaseItem(item), hold.delayMs);
          held.push(item);
        });
      }
      const fault = take(faultRules, info);
      if (offline || fault?.mode === 'error') {
        const code = offline ? 'unavailable' : fault.code || 'unavailable';
        entry.allowed = false; entry.code = code; entry.fault = offline ? 'offline' : 'error';
        return fail(code, offline ? 'offline' : fault.message || code);
      }
      if (fault?.mode === 'hang') { entry.fault = 'hang'; entry.allowed = false; entry.code = 'hang'; return { hang: true }; }
      if (fault?.mode === 'delay') { entry.fault = 'delay'; await sleep(fault.delayMs || 0); }

      switch (body.op) {
        case 'auth': return { uid: body.uid };
        case 'get': case 'list': return readOp(entry, body);
        case 'set': return applyWriteSet(entry, body.uid, [{ path: body.path, kind: 'set', data: body.data, merge: body.merge }], serverTime());
        case 'delete': return applyWriteSet(entry, body.uid, [{ path: body.path, kind: 'delete' }], serverTime());
        case 'terminate': if (instances.has(body.instance)) instances.get(body.instance).terminated = true; return { ok: true };
        default: return fail('invalid-argument', `알 수 없는 op: ${body.op}`);
      }
    } finally {
      inflight.set(device, (inflight.get(device) || 1) - 1);
    }
  }

  // ── 1.7.9 기기 흉내 (7d4753b sync.ts) ──
  const legacyCtx = (uid, op) => newEntry({ op, uid, device: `legacy179:${uid}`, actor: 'legacy179', path: null });

  function legacyJoin({ key, uid, create = false }) {
    const familyPath = `families/${firestoreFamilyId(key)}`;
    const entry = legacyCtx(uid, 'legacy179.join');
    const hash = firestoreInviteHash(key);
    if (docs.has(`${familyPath}/members/${uid}`)) return { joined: true, existing: true };
    if (create) {
      // 1.7.9 createFamilyConnection: 새 가족 만들기에서만 가족 문서를 만듭니다(이미 있으면 거부되어 무시).
      applyWriteSet(entry, uid, [{ path: familyPath, kind: 'set', data: { inviteHash: hash, schemaVersion: 3, createdAt: { __serverTs: true } } }], serverTime());
    }
    const result = applyWriteSet(entry, uid, [{ path: `${familyPath}/members/${uid}`, kind: 'set', merge: true, data: { inviteHash: hash, joinedAt: { __serverTs: true } } }], serverTime());
    if (result.error) throw new Error(`legacy179 join 거부: ${result.error.code}`);
    return { joined: true, existing: false };
  }

  /** 기록 쓰기와 lastChangedAt 갱신은 한 트랜잭션, 시각은 서버 시각, 삭제 표식에도 updatedAt(1.7.9 sync.ts:266-326, 613-635). */
  function legacyWrite({ key, uid, logs = [], deleteIds = [], profile, serverTime: override }) {
    const familyPath = `families/${firestoreFamilyId(key)}`;
    const entry = legacyCtx(uid, 'legacy179.write');
    const T = serverTime(override);
    const writes = [];
    for (const log of logs) {
      const path = `${familyPath}/logs/${log.id}`;
      const current = docs.get(path);
      if (current?.deleted === true) continue;
      const remote = current?.payload;
      const lu = log.updatedAt || log.timestamp || 0;
      const ru = remote?.updatedAt || remote?.timestamp || 0;
      if (remote && !(lu > ru || (lu === ru && JSON.stringify(log) > JSON.stringify(remote)))) continue;
      writes.push({ path, kind: 'set', data: { payload: log, deleted: false, updatedAt: { __serverTs: true }, updatedBy: uid } });
    }
    for (const id of deleteIds) {
      const path = `${familyPath}/logs/${id}`;
      if (docs.get(path)?.deleted === true) continue;
      writes.push({ path, kind: 'set', merge: true, data: { deleted: true, deletedAt: { __serverTs: true }, updatedAt: { __serverTs: true }, updatedBy: uid } });
    }
    if (profile) {
      writes.push({
        path: `${familyPath}/profile/shared`, kind: 'set',
        data: { ...profile, updatedAt: profile.updatedAt ?? now(), serverUpdatedAt: { __serverTs: true }, updatedBy: uid },
      });
    }
    if (writes.length > 0) {
      writes.push({ path: familyPath, kind: 'set', merge: true, data: { schemaVersion: 3, lastChangedAt: { __serverTs: true }, lastChangedBy: uid } });
      const result = applyWriteSet(entry, uid, writes, T);
      if (result.error) throw new Error(`legacy179 write 거부: ${result.error.code}`);
    }
    return { serverTime: T, written: writes.length > 0 ? writes.length - 1 : 0 };
  }

  /** 예약은 pendingDeletionAt만 쓰고 lastChangedAt은 바꾸지 않습니다(1.7.9 sync.ts:704). 규칙이 50분 뒤 이후만 받습니다. */
  function legacySchedule({ key, uid, readyAt }) {
    const entry = legacyCtx(uid, 'legacy179.schedule');
    const at = readyAt ?? now() + 60 * 60_000;
    const result = applyWriteSet(entry, uid, [{ path: `families/${firestoreFamilyId(key)}`, kind: 'set', merge: true, data: { pendingDeletionAt: ts(at) } }], serverTime());
    if (result.error) throw new Error(`legacy179 schedule 거부: ${result.error.code}`);
    return { readyAt: at };
  }

  function legacyCancel({ key, uid }) {
    const entry = legacyCtx(uid, 'legacy179.cancel');
    const result = applyWriteSet(entry, uid, [{ path: `families/${firestoreFamilyId(key)}`, kind: 'set', merge: true, data: { pendingDeletionAt: null } }], serverTime());
    if (result.error) throw new Error(`legacy179 cancel 거부: ${result.error.code}`);
    return { cancelled: true };
  }

  // ── 제어 ──
  function seed(body) {
    const T = serverTime(body.serverTime);
    const familyId = firestoreFamilyId(body.key);
    const base = `families/${familyId}`;
    const fam = body.family;
    if (fam !== null && fam !== false) {
      const spec = fam || {};
      const data = { schemaVersion: spec.schemaVersion ?? 3, createdAt: ts(spec.createdAt ?? T - 86_400_000) };
      if (spec.inviteHash !== 'omit') data.inviteHash = spec.inviteHash && spec.inviteHash !== 'match' ? spec.inviteHash : firestoreInviteHash(body.key);
      if (spec.lastChangedAt !== 'omit') { data.lastChangedAt = ts(spec.lastChangedAt ?? T); data.lastChangedBy = 'seed'; }
      if (spec.pendingDeletionAt === null) data.pendingDeletionAt = null;
      else if (typeof spec.pendingDeletionAt === 'number') data.pendingDeletionAt = ts(spec.pendingDeletionAt);
      docs.set(base, { ...data, ...(spec.extra || {}) });
    }
    for (const uid of body.members || []) docs.set(`${base}/members/${uid}`, { inviteHash: firestoreInviteHash(body.key), joinedAt: ts(T) });
    for (const log of body.logs || []) {
      const { fsUpdatedAt, ...payload } = log;
      docs.set(`${base}/logs/${payload.id}`, { payload, deleted: false, updatedAt: ts(fsUpdatedAt ?? body.updatedAt ?? T), updatedBy: 'seed' });
    }
    for (const item of body.tombstones || []) {
      const id = typeof item === 'string' ? item : item.id;
      docs.set(`${base}/logs/${id}`, { deleted: true, deletedAt: ts(T), updatedAt: ts(item.fsUpdatedAt ?? body.updatedAt ?? T), updatedBy: 'seed' });
    }
    if (body.profile) docs.set(`${base}/profile/shared`, { ...body.profile, serverUpdatedAt: ts(T), updatedBy: 'seed' });
    for (const d of body.docs || []) docs.set(d.path, d.data);
    return { familyId, inviteHash: firestoreInviteHash(body.key), serverTime: T };
  }

  function snapshot(key) {
    const base = `families/${firestoreFamilyId(key)}`;
    const children = (kind) => [...docs.entries()].filter(([p]) => p.startsWith(`${base}/${kind}/`)).map(([p, data]) => ({ id: p.split('/').at(-1), data }));
    const logs = children('logs');
    return {
      family: docs.get(base) ?? null,
      members: children('members').map((m) => m.id),
      live: logs.filter((l) => l.data.deleted !== true).map((l) => [l.id, l.data.payload]),
      deleted: logs.filter((l) => l.data.deleted === true).map((l) => l.id),
      profile: docs.get(`${base}/profile/shared`) ?? null,
    };
  }

  const sumEntries = (from) => {
    const total = { docReads: 0, ruleReads: 0, writes: 0, ops: 0, denied: 0, signIns: 0, terminates: 0, maxInflight: 0, byDevice: {} };
    for (const e of ops.slice(from)) {
      const d = (total.byDevice[e.device] ||= { docReads: 0, ruleReads: 0, writes: 0, ops: 0, maxInflight: 0 });
      for (const t of [total, d]) {
        t.docReads += e.docReads; t.ruleReads += e.ruleReads; t.writes += e.writes; t.ops += 1;
        t.maxInflight = Math.max(t.maxInflight, e.inflight);
      }
      if (e.op === 'auth') total.signIns += 1;
      if (e.op === 'terminate') total.terminates += 1;
      if (!e.allowed && e.code === 'permission-denied') total.denied += 1;
    }
    for (const t of [total, ...Object.values(total.byDevice)]) t.reads = t.docReads + t.ruleReads;
    return total;
  };

  /** 불변 조건 2: 앱(actor app)의 쓰기는 회원 문서 생성과 pendingDeletionAt: null뿐이어야 합니다. 거부된 시도도 셉니다. */
  const appWriteAllowed = (w) => {
    const info = parse(w.path);
    if (w.kind === 'delete') return false;
    if (info.kind === 'members' && info.id === w.uid && sameSet(w.fields, ['inviteHash', 'joinedAt'])) return true;
    return info.kind === 'family' && sameSet(w.fields, ['pendingDeletionAt']) && w.data.pendingDeletionAt === null;
  };

  function reset() {
    docs.clear(); ops.length = 0; writeLog.length = 0; instances.clear(); inflight.clear();
    faultRules.length = 0; holdRules.length = 0;
    for (const item of [...held]) releaseItem(item);
    clock.fixed = null; clock.offset = 0; lastT = 0; offline = false;
  }

  function control(body) {
    switch (body.op) {
      case 'reset': reset(); return { reset: true };
      case 'clock':
        if (body.real) { clock.fixed = null; clock.offset = 0; lastT = 0; }
        if (body.set !== undefined) { clock.fixed = Number(body.set); lastT = 0; }
        if (body.advance !== undefined) { if (clock.fixed !== null) clock.fixed += Number(body.advance); else clock.offset += Number(body.advance); }
        return { now: now(), mode: clock.fixed !== null ? 'fixed' : 'real', offsetMs: clock.offset };
      case 'seed': return seed(body);
      case 'snapshot': return snapshot(body.key);
      case 'getDoc': return { doc: docs.get(body.path) ?? null };
      case 'putDoc': {
        const T = serverTime();
        const data = resolveServer(body.data, T);
        docs.set(body.path, body.merge ? { ...(docs.get(body.path) || {}), ...data } : data);
        return { ok: true };
      }
      case 'removeDoc': return { removed: docs.delete(body.path) };
      case 'removeFamily': {
        const base = `families/${firestoreFamilyId(body.key)}`;
        let removed = 0;
        for (const p of [...docs.keys()]) if (p === base || p.startsWith(`${base}/`)) { docs.delete(p); removed += 1; }
        return { removed };
      }
      case 'stats': return sumEntries(Number(body.from) || 0);
      case 'ops': return { count: ops.length, ops: ops.slice(Number(body.from) || 0) };
      case 'opCount': return { count: ops.length };
      case 'writes': {
        const list = writeLog.filter((w) => (!body.actor || w.actor === body.actor) && w.seq >= (Number(body.from) || 0));
        return { count: writeLog.length, writes: list };
      }
      case 'audit': {
        const from = Number(body.from) || 0;
        const appWrites = writeLog.filter((w) => w.actor === 'app' && w.seq >= from);
        return {
          appWrites,
          forbidden: appWrites.filter((w) => !appWriteAllowed(w)),
          deletes: appWrites.filter((w) => w.kind === 'delete'),
        };
      }
      case 'instances': return { instances: [...instances.entries()].map(([id, v]) => ({ id, ...v })) };
      case 'offline': offline = !!body.on; return { offline };
      case 'faults': return ruleOps(faultRules, body, (b) => {
        if (!['error', 'hang', 'delay'].includes(b.mode)) throw new Error(`알 수 없는 fault mode: ${b.mode}`);
        return { mode: b.mode, code: b.code, message: b.message, delayMs: Number(b.delayMs) || 0 };
      });
      case 'holds': {
        const result = ruleOps(holdRules, body, (b) => ({ delayMs: Number(b.delayMs) || 0 }));
        if (body.action === 'list') return { ...result, held: heldView() };
        if (body.action === 'clear' || body.action === 'remove') for (const item of [...held]) if (!holdRules.some((r) => r.id === item.ruleId)) releaseItem(item);
        return result;
      }
      case 'held': return { held: heldView() };
      case 'release': {
        const released = [];
        for (const item of [...held]) {
          if (body.all || item.id === body.id || item.ruleId === body.ruleId) if (releaseItem(item)) released.push(item.id);
        }
        if (body.ruleId) { const i = holdRules.findIndex((r) => r.id === body.ruleId); if (i >= 0) holdRules.splice(i, 1); }
        return { released };
      }
      case 'legacy179': {
        const actions = { join: legacyJoin, write: legacyWrite, schedule: legacySchedule, cancel: legacyCancel };
        if (!actions[body.action]) throw new Error(`알 수 없는 legacy179 action: ${body.action}`);
        return actions[body.action](body);
      }
      default: throw new Error(`알 수 없는 fs 제어: ${body.op}`);
    }
  }

  return { rpc, control, reset, release: () => { for (const item of [...held]) releaseItem(item); } };
}
