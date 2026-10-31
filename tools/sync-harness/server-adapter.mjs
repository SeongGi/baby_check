// 서버 상태 조회 어댑터(06 설계 2.10). 같은 질의와 조작을 가짜 Worker(같은 프로세스의 state)와
// 실제 서버(/__harness/ 제어 엔드포인트) 두 곳에 똑같이 던질 수 있게 합니다. 모든 메서드는 async입니다.
//
// 요청 목록의 항목(두 구현이 같은 모양으로 돌려줍니다):
//   { kind: 'push'|'pull'|'connect'|'token'|'other', clientId, pushLogs, pushDeleted, pull: {after:[updatedAt, logId], limit}|null,
//     bodyBytes, status, committed, logWrites, ... }
//   committed: 이 요청이 기록이나 아기 정보를 서버에 확정했는가. logWrites: 확정된 기록 행 수.
//   실제 서버는 rowsRead, rowsWritten, writtenByTable, changedByTable, queries, workerMs, held, dropped도 싣습니다.
//
// 어댑터의 조작:
//   reset()                       서버 데이터, 훅, 시계, 한도, 요청 목록을 처음으로
//   requests(from) / requestCount()
//   family(key) -> { exists, deleted, token, pendingDeletionAt, sharedJson, profileUpdatedAt, members }
//   logs(key) -> { rows: [{id, clientUpdatedAt, updatedAt, deletedAt, raw}], live: [[id, raw]], deleted: [id] }
//   ensureFamily / injectLog / injectTombstone / removeFamily / markGone
//   advanceClock(ms) / setLimits({maxPushItems, maxPageRows})
//   holdNext(match, options) -> { held: Promise, release() }   다음 요청을 서버 안에서 멈춤
//   delay(match, delayMs, options) -> { clear() }               조건에 맞는 요청을 delayMs만큼 늦춤
//   failHttp({ status, match, skip, times }) / failCommit({ match, skip, times }) / clearFaults()
//   setOffline(on)                모든 요청이 네트워크 오류로 끝나게 함(가짜는 fetch 예외, 실제는 연결 끊기)
//   quiesce()                     진행 중인 요청이 모두 끝날 때까지 기다림
// match: { kind: 'push'|'pull'|'sync'|'connect', hasPushItems?: boolean, clientId? }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeFake = (r) => ({
  ...r,
  kind: r.kind === 'sync' ? (r.pull ? 'pull' : 'push') : r.kind,
});

const kindsOf = (match) => [].concat(match.kind ?? []).flatMap((k) => (k === 'sync' ? ['push', 'pull'] : [k]));

export function createFakeAdapter(state) {
  let clockOffset = 0;
  const rules = [];

  const infoOf = (body, request) => ({
    kind: body.pull ? 'pull' : 'push',
    clientId: request.clientId,
    hasPushItems: (body.pushLogs?.length || 0) + (body.pushDeletedIds?.length || 0) > 0,
  });
  const ruleMatches = (rule, info) => {
    const kinds = kindsOf(rule.match);
    if (kinds.length && !kinds.includes(info.kind)) return false;
    if (rule.match.hasPushItems !== undefined && Boolean(rule.match.hasPushItems) !== info.hasPushItems) return false;
    if (rule.match.clientId && rule.match.clientId !== info.clientId) return false;
    return true;
  };

  const install = () => {
    state.onRequest = async (body, request) => {
      const info = infoOf(body, request);
      for (const rule of rules) {
        if (!ruleMatches(rule, info)) continue;
        rule.seen += 1;
        if (rule.seen <= rule.skip) continue;
        if (rule.times !== Infinity && rule.fired >= rule.times) continue;
        rule.fired += 1;
        if (rule.type === 'fail') return { status: rule.status };
        await rule.onHit();
      }
      return undefined;
    };
  };

  const addRule = (rule) => {
    rules.push({ seen: 0, fired: 0, skip: 0, times: 1, ...rule, times: rule.times === 'always' ? Infinity : (rule.times ?? 1) });
    install();
    return rules[rules.length - 1];
  };

  const rowsOf = (key) => {
    const map = state.logs.get(key) || new Map();
    return [...map.entries()]
      .map(([id, row]) => ({ id, clientUpdatedAt: row.clientUpdatedAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt, raw: row.rawJson }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  return {
    kind: 'fake',
    state,
    async reset() {
      state.reset();
      state.failNextSync = null;
      state.rejectAllPushes = false;
      state.tamperSyncResponse = null;
      state.maxPushItems = 400;
      state.maxPageRows = 500;
      state.beforeRead = null;
      state.beforeTransaction = null;
      state.beforeCommit = null;
      state.onRequest = null;
      state.offline = false;
      state.clock = null;
      clockOffset = 0;
      rules.length = 0;
    },
    async requests(from = 0) { return state.requests.slice(from).map(normalizeFake); },
    async requestCount() { return state.requests.length; },
    async family(key) {
      const f = state.families.get(key);
      return {
        exists: Boolean(f),
        deleted: state.deleted.has(key),
        token: f ? `${f.updatedAt}:${f.lastClientId || ''}` : null,
        pendingDeletionAt: f?.pendingDeletionAt ?? null,
        sharedJson: f?.sharedJson ?? null,
        profileUpdatedAt: f?.profileUpdatedAt ?? null,
        members: [],
      };
    },
    async logs(key) {
      const rows = rowsOf(key);
      return {
        rows,
        live: rows.filter((r) => r.deletedAt === null).map((r) => [r.id, r.raw]),
        deleted: rows.filter((r) => r.deletedAt !== null).map((r) => r.id),
      };
    },
    async ensureFamily(key) { state.ensureFamily(key); },
    async injectLog(key, log, serverTime) { state.injectLog(key, log, serverTime); },
    async injectTombstone(key, id, serverTime) { state.injectTombstone(key, id, serverTime); },
    async removeFamily(key) { state.families.delete(key); state.logs.delete(key); },
    async markGone(key) { state.families.delete(key); state.logs.delete(key); state.deleted.add(key); },
    async advanceClock(ms) {
      clockOffset += ms;
      state.clock = () => Date.now() + clockOffset;
    },
    async setLimits({ maxPushItems, maxPageRows } = {}) {
      if (maxPushItems !== undefined) state.maxPushItems = maxPushItems;
      if (maxPageRows !== undefined) state.maxPageRows = maxPageRows;
    },
    async holdNext(match, options = {}) {
      let markHeld;
      let open;
      const held = new Promise((resolve) => { markHeld = resolve; });
      const gate = new Promise((resolve) => { open = resolve; });
      addRule({ type: 'hold', match, ...options, onHit: async () => { markHeld(); await gate; } });
      return { held, async release() { open(); } };
    },
    async delay(match, delayMs, options = {}) {
      const rule = addRule({ type: 'hold', match, times: 'always', ...options, onHit: () => sleep(delayMs) });
      return { async clear() { rules.splice(rules.indexOf(rule), 1); } };
    },
    async failHttp({ status = 503, match = { kind: 'sync' }, skip = 0, times = 1 } = {}) {
      addRule({ type: 'fail', status, match, skip, times });
    },
    async failCommit() {
      state.beforeCommit = () => { throw new Error('injected commit failure'); };
    },
    async clearFaults() {
      state.beforeCommit = null;
      for (let i = rules.length - 1; i >= 0; i -= 1) if (rules[i].type === 'fail') rules.splice(i, 1);
    },
    async setOffline(on) { state.offline = on; },
    async quiesce() {},
  };
}

export function createRealAdapter(control) {
  const post = (name, body = {}) => control(name, body);
  const state = (q, extra = {}) => post('state', { q, ...extra });

  const waitUntil = async (predicate, what, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`시간 안에 ${what}`);
      await sleep(5);
    }
  };

  const adapter = {
    kind: 'real',
    control: post,
    async reset() {
      await adapter.quiesce();
      await post('wipe', { scope: 'reset' });
    },
    async requests(from = 0) { return (await state('requests', { from })).requests; },
    async requestCount() { return (await state('requests', { from: 1e9 })).count; },
    family: (key) => state('family', { key }),
    logs: (key) => state('logs', { key }),
    stats: () => state('stats'),
    async ensureFamily(key) { await post('inject', { key, ensureFamily: true }); },
    async injectLog(key, log, serverTime) { await post('inject', { key, log, serverTime }); },
    async injectTombstone(key, id, serverTime) { await post('inject', { key, tombstone: id, serverTime }); },
    async removeFamily(key) { await post('inject', { key, remove: true }); },
    async markGone(key) { await post('inject', { key, gone: true }); },
    async advanceClock(ms) { await post('clock', { advance: ms }); },
    async setLimits(limits = {}) { await post('config', limits); },
    async holdNext(match, options = {}) {
      const { ruleId } = await post('hold', { op: 'add', match, ...options });
      return {
        ruleId,
        held: waitUntil(async () => (await state('held')).held.some((h) => h.ruleId === ruleId), '서버가 요청을 멈추지 않았습니다'),
        async release() { await post('release', { ruleId }); },
      };
    },
    async delay(match, delayMs, options = {}) {
      const { ruleId } = await post('hold', { op: 'add', match, delayMs, times: 'always', ...options });
      return { ruleId, async clear() { await post('release', { ruleId }); } };
    },
    async failHttp({ status = 503, match = { kind: 'sync' }, skip = 0, times = 1 } = {}) {
      await post('fail', { op: 'add', mode: 'http', status, match, skip, times });
    },
    async failCommit({ match, skip = 0, times = 'always' } = {}) {
      await post('fail', { op: 'add', mode: 'beforeCommit', match: match || { batch: 'write' }, skip, times });
    },
    async clearFaults() { await post('fail', { op: 'clear' }); },
    async setOffline(on) {
      if (on) await post('fail', { op: 'add', mode: 'drop', match: {}, times: 'always' });
      else await post('fail', { op: 'clear' });
    },
    async quiesce() {
      const idle = async () => (await state('stats')).inflight === 0;
      try {
        await waitUntil(idle, '서버의 진행 중인 요청이 끝나지 않았습니다', 3_000);
      } catch {
        // 멈춰 있는 요청이 남았다면 풀어 주고 한 번 더 기다립니다.
        await post('release', { all: true });
        await waitUntil(idle, '서버의 진행 중인 요청이 끝나지 않았습니다', 15_000);
      }
    },
  };
  return adapter;
}
