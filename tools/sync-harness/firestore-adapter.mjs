// 가짜 Firestore 조작 어댑터(07 설계 5.1). 시나리오가 `server.fs`(또는 `harness.fs`)로 씁니다.
// 상태는 서버 프로세스(stubs/fake-firestore-state.mjs)가 갖고, 이 어댑터는 `/__harness/fs` 제어 엔드포인트를 감쌉니다.
// 모든 메서드는 async입니다. 값의 Timestamp는 {__ts: 밀리초}로 오갑니다(`tsMillis`로 풀 수 있음).
//
//   상태:   reset() | seed(key, spec) | snapshot(key) | getDoc(path) | putDoc(path, data, {merge}) | removeFamily(key) | removeDoc(path)
//   집계:   stats(from?) -> {docReads, ruleReads, reads, writes, ops, denied, signIns, terminates, maxInflight, byDevice}
//           opCount() | ops(from?) | writes({from, actor}) | audit(from?) -> {appWrites, forbidden, deletes} | instances()
//   시계:   clock({set|advance|real})
//   주입:   fail({match, code, skip, times}) 오류 | hang(match, opts) 끝나지 않는 호출 | exhaust(match?) resource-exhausted 계속
//           delay(match, delayMs, opts) | offline(on) | clearFaults()
//   걸쇠:   holdNext(match, opts) -> {held, release()} | interleave(match, opts, {call, between}) 호출 하나를 멈추고 between을 돌린 뒤 풀어 줌
//   1.7.9:  legacy179Join(key, {uid, create}) | legacy179Write(key, {uid, logs, deleteIds, profile, serverTime})
//           legacy179Schedule(key, {uid, readyAt}) | legacy179Cancel(key, {uid})
// match: {op: auth|get|list|set|delete|terminate, kind: family|members|logs|profile, device, uid, actor, key, pathIncludes}
//   예) 페이지 읽기만: {op: 'list', kind: 'logs'}, 앱의 쓰기만: {op: 'set', actor: 'app'}
import { firestoreFamilyId, firestoreInviteHash } from './stubs/fake-firestore-state.mjs';

export { firestoreFamilyId, firestoreInviteHash };
export const tsMillis = (value) => (value && typeof value.__ts === 'number' ? value.__ts : null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFirestoreAdapter(control) {
  const fs = (op, body = {}) => control('fs', { op, ...body });
  const rule = (name, body) => control('fs', { op: name, action: 'add', ...body });

  const adapter = {
    familyId: firestoreFamilyId,
    inviteHash: firestoreInviteHash,

    reset: () => fs('reset'),
    seed: (key, spec = {}) => fs('seed', { key, ...spec }),
    snapshot: (key) => fs('snapshot', { key }),
    getDoc: async (path) => (await fs('getDoc', { path })).doc,
    putDoc: (path, data, { merge = false } = {}) => fs('putDoc', { path, data, merge }),
    removeFamily: (key) => fs('removeFamily', { key }),
    removeDoc: (path) => fs('removeDoc', { path }),

    stats: (from = 0) => fs('stats', { from }),
    opCount: async () => (await fs('opCount')).count,
    ops: async (from = 0) => (await fs('ops', { from })).ops,
    writes: async ({ from = 0, actor } = {}) => (await fs('writes', { from, actor })).writes,
    audit: (from = 0) => fs('audit', { from }),
    instances: async () => (await fs('instances')).instances,

    clock: (spec) => fs('clock', spec),

    fail: ({ match = {}, code = 'unavailable', message, skip = 0, times = 1 } = {}) =>
      rule('faults', { match, mode: 'error', code, message, skip, times }),
    hang: (match = {}, { skip = 0, times = 1 } = {}) => rule('faults', { match, mode: 'hang', skip, times }),
    exhaust: (match = {}, { skip = 0, times = 'always' } = {}) =>
      rule('faults', { match, mode: 'error', code: 'resource-exhausted', skip, times }),
    delay: (match = {}, delayMs, { skip = 0, times = 1 } = {}) => rule('faults', { match, mode: 'delay', delayMs, skip, times }),
    offline: (on = true) => fs('offline', { on }),
    clearFaults: () => control('fs', { op: 'faults', action: 'clear' }),

    held: async () => (await fs('held')).held,
    async holdNext(match = {}, { skip = 0, times = 1, delayMs } = {}) {
      const { ruleId } = await rule('holds', { match, skip, times, delayMs });
      return {
        ruleId,
        held: (async () => {
          for (let i = 0; i < 1000; i += 1) {
            const held = (await adapter.held()).filter((h) => h.ruleId === ruleId);
            if (held.length) return held[0];
            await sleep(10);
          }
          throw new Error('걸쇠에 걸린 호출이 10초 안에 오지 않았습니다');
        })(),
        release: () => control('fs', { op: 'release', ruleId }),
      };
    },
    /**
     * 호출 하나를 걸쇠로 멈추고, 그 사이에 between을 돌린 뒤 풀어 줍니다. call은 호출을 시작하는 함수입니다(약속을 돌려줌).
     * 걸쇠를 먼저 걸고 call을 시작하므로, 페이지 읽기 사이에 다른 기기의 쓰기를 끼우는 일을 한 번에 할 수 있습니다.
     * 예) interleave({op:'list', kind:'logs'}, {skip:1}, { call: () => A.send('runMigration'), between: () => fs.legacy179Write(...) })
     */
    async interleave(match, options, { call, between }) {
      const gate = await adapter.holdNext(match, options);
      const pending = call();
      pending.catch(() => undefined);
      try {
        await between(await gate.held);
      } finally {
        await gate.release();
      }
      return pending;
    },
    clearHolds: () => control('fs', { op: 'holds', action: 'clear' }),

    legacy179Join: (key, { uid = 'legacy-B', create = false } = {}) => fs('legacy179', { action: 'join', key, uid, create }),
    legacy179Write: (key, { uid = 'legacy-B', logs = [], deleteIds = [], profile, serverTime } = {}) =>
      fs('legacy179', { action: 'write', key, uid, logs, deleteIds, profile, serverTime }),
    legacy179Schedule: (key, { uid = 'legacy-B', readyAt } = {}) => fs('legacy179', { action: 'schedule', key, uid, readyAt }),
    legacy179Cancel: (key, { uid = 'legacy-B' } = {}) => fs('legacy179', { action: 'cancel', key, uid }),
  };
  return adapter;
}
