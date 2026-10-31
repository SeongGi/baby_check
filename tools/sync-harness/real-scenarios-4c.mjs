// 실제 서버 모드 시나리오 4부 보강: 이전 모듈의 독립 리뷰 지적(A~E, H) 수정을 확인합니다. 시나리오 접두어는 s4c입니다.
//
//  A. 병합 완료 + D1 missing의 가족 문서 다시 읽기가 실패 간격과 할당량 자정 미루기를 지킨다 (실제 서버 + 가짜 Firestore)
//  B. 이어 가기 요청이 더 작은 번호의 대기 요청에 합쳐져도 사슬의 사건 번호가 7단계 번호 이상이다 (러너 + 이전 모듈, 가짜 동기화 함수)
//  C. 7단계가 실패하거나 버려져도 번호를 지우지 않아, 뒤의 평소 요청이 업로드를 마치면 완료가 적히고 ensure는 7단계를 다시 넣는다
//  D. markUploaded가 사건을 받은 시점의 번호만 인정한다 (같은 가짜 세계)
//  E. 병합 직후 병합 전 업로드(U1)의 성공 사건이 d1UploadedAt을 적어 병합 뒤 업로드(U2) 완료를 무시하게 하지 않는다 (같은 가짜 세계)
//  D2. markUploaded가 getMigrationState를 기다리는 사이에 병합이 끼어들어도 d1UploadedAt을 적지 않는다 (두 번째 번호 확인)
//  C6. 이미 넣은 7단계가 끝나기 전에 ensure를 순차로 다시 불러도 forceFullRead 요청이 늘지 않는다 (requestUpload의 'pending')
//  P39. 장부가 6시간 안에 전체 읽기를 마친 기기가 병합한 뒤의 7단계는 forceFullRead라 전체 모드로 돈다 (실제 서버)
//  H. 다시 읽기 결과가 예약 없음이면 promptedPendingDeletionAt을 지운다
// 가짜 세계(`world`)는 앞의 B~E를 시간 순서까지 결정적으로 재현하려고 실제 러너(syncRunner.ts)와 실제 이전 모듈(familyMigration.ts)을
// 그대로 쓰고 저장소, D1, Firestore, 동기화 함수만 가짜로 둡니다(관문과 번호 매기기 포함). 재현 순서는 각 시나리오 주석을 보세요.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-4c.mjs
//       HARNESS_ONLY=A,C1 bash tools/sync-harness/verify.sh scenario real-scenarios-4c.mjs   (일부만)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startRealHarness, make179Storage, auditFirestoreWrites, waitFor, waitMigrationComplete,
} from './real-harness.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const { createFamilyMigrator } = await import(`${SRC}/database/familyMigration.ts`);
const { createSyncRunner } = await import(`${SRC}/database/syncRunner.ts`);

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PREFIX = 's4c';

// ────────────── 시나리오 뼈대 ──────────────
/** 실제 서버와 기기(이름에 s4c 접두어)를 띄워 fn을 돌립니다. 끝나면 불변 조건 2(허용 목록 밖 Firestore 쓰기·삭제 0건)를 판정합니다. */
const scenario = async (id, title, names, fn, options = {}) => {
  if (ONLY && !ONLY.includes(id)) return;
  const started = Date.now();
  let harness = null;
  try {
    const deviceOptions = Object.fromEntries(Object.entries(options.deviceOptions || {}).map(([n, o]) => [`${PREFIX}${n}`, o]));
    harness = await startRealHarness({ devices: names.map((n) => `${PREFIX}${n}`), deviceOptions });
    const d = Object.fromEntries(names.map((n) => [n, harness.devices[`${PREFIX}${n}`]]));
    const { server } = harness;
    await server.adapter.reset();
    await fn({ harness, server, adapter: server.adapter, fs: server.fs, d, ...d });
    await auditFirestoreWrites(harness);
    results.push(true);
    console.log(`PASS [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)\n     ${error?.stack || error}`);
  } finally {
    await harness?.stop().catch(() => undefined);
  }
};

/** 프로세스 안에서 도는 시나리오(가짜 세계). 서버와 기기 프로세스를 띄우지 않습니다. */
const inProcess = async (id, title, fn) => {
  if (ONLY && !ONLY.includes(id)) return;
  const started = Date.now();
  try {
    await fn();
    results.push(true);
    console.log(`PASS [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)\n     ${error?.stack || error}`);
  }
};

// ────────────── 도우미 ──────────────
const hexKey = (tag) => createHash('md5').update(`${PREFIX}:${tag}`).digest('hex');
const sortedIds = (list) => [...list].sort();
const seeds = (n, prefix, base = Date.now() - 10 * DAY, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}${String(i).padStart(4, '0')}`, type: 'formula', amount: 90, timestamp: base + i, updatedAt: base + i, ...extra,
}));
const idsOf = async (device) => sortedIds((await device.send('getLogs')).logs.map((l) => l.id));
const d1Live = async (adapter, key) => sortedIds((await adapter.logs(key)).live.map(([id]) => id));
const stateOf = async (device, syncKey) => (await device.send('migrationState', { syncKey }));
const clientIdOf = async (device) => (await device.send('getSyncClientId')).clientId;
const opsBy = async (fs, device, from = 0) => (await fs.ops(from)).filter((o) => o.device === device.name);
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 기기 시계와 Firestore 시계를 함께 옮깁니다. */
const advance = async (device, fs, ms) => { await device.send('advanceClock', { ms }); await fs.clock({ advance: ms }); };
const nowOf = async (device) => (await device.send('getClock')).now;
const migrationKey = (key) => `@baby_cf_migration_v1:${key}`;
/** 미국 서부(태평양) 시간의 다음 자정(밀리초). 앱 코드를 쓰지 않고 Intl로 따로 구합니다. */
const nextPacificMidnight = (ms) => {
  const day = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  const today = day(ms);
  let lo = ms;
  let hi = ms + 26 * HOUR;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (day(mid) === today) lo = mid; else hi = mid;
  }
  return hi;
};
const newKeyFamily = async (device, key) => {
  const joined = await device.send('join', { key, allowFamilyCreation: true, createBackup: false });
  assert.equal(joined.outcome, 'joined', `가족 만들기 실패: ${JSON.stringify(joined)}`);
};

// ────────────── 가짜 세계 (B~E) ──────────────
const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open, reached: false };
};

/**
 * 실제 러너와 실제 이전 모듈을 묶고 저장소, D1, Firestore, 동기화 함수만 가짜로 둡니다.
 * opts.state: 처음 이전 상태 | opts.d1: 'exists' | 'missing' | opts.family: 가족 문서 | opts.evidence: 1.7.9 근거(기본 참)
 */
const makeWorld = (opts = {}) => {
  const KEY = hexKey(opts.tag ?? 'world');
  const world = {
    KEY,
    now: 1_900_000_000_000,
    d1: opts.d1 ?? 'exists',
    family: opts.family ?? { exists: true, pendingDeletionAt: null, lastChangedAt: 1 },
    firestoreFailure: null,
    firestoreReads: 0,
    ledgerFull: false,
    ledgerGate: null,
    runnerKey: KEY,
    state: { ...(opts.state ?? {}) },
    transition: {},
    transitionGate: null,
    stateGate: null,
    syncCalls: [],
    syncHandlers: [],
    events: [],
  };
  const readLedger = () => (world.ledgerFull
    ? { full: { after: { updatedAt: 0, logId: '' }, uploaded: {}, tombstoned: [] } }
    : { uploaded: {}, tombstoned: [] });
  const storage = {
    getLegacyKeyMarker: async () => ({ checkedAt: 0, keys: (opts.evidence ?? true) ? [KEY] : [] }),
    getMigrationState: async () => {
      // 한 번만 멈추는 문입니다(armed 뒤 첫 호출만). 멈춘 사이에 다른 호출(ensure)은 그대로 지나갑니다.
      const held = world.stateGate;
      if (held) { world.stateGate = null; held.reached = true; await held.promise; }
      return { ...world.state };
    },
    updateMigrationState: async (_key, patch) => {
      await Promise.resolve();
      const next = { ...world.state };
      Object.entries(patch).forEach(([field, value]) => { if (value === undefined) delete next[field]; else next[field] = value; });
      world.state = next;
      return { ...next };
    },
    getTransitionState: async () => {
      if (world.transitionGate) { world.transitionGate.reached = true; await world.transitionGate.promise; }
      return { ...world.transition };
    },
    updateTransitionState: async (_key, patch) => { world.transition = { ...world.transition, ...patch }; return world.transition; },
    ensurePreMigrationBackup: async () => 'saved',
    markPreMigrationBackupSkipped: async () => undefined,
    mergeLegacyFirestoreData: async () => true,
    getProfile: async () => ({ syncKey: KEY }),
    saveProfile: async () => true,
    readSyncLedger: async () => {
      if (world.ledgerGate) { world.ledgerGate.reached = true; await world.ledgerGate.promise; }
      return readLedger();
    },
  };
  const cloud = {
    connectFamily: async (_key, _clientId, allowCreate) => {
      if (world.d1 === 'missing') {
        if (!allowCreate) throw Object.assign(new Error('not found'), { status: 404 });
        world.d1 = 'exists';
      }
      return { ok: true };
    },
    deleteFamilyData: async () => undefined,
    getSyncToken: async () => ({ ok: true }),
    scheduleFamilyDeletion: async () => undefined,
  };
  const firestore = {
    ensureFirestoreMembership: async () => {
      world.firestoreReads += 1;
      if (world.firestoreFailure) throw Object.assign(new Error('firestore'), { code: world.firestoreFailure });
      return 'member';
    },
    readLegacyFamilyDoc: async () => { world.firestoreReads += 1; return world.family; },
    readLegacyLogsPage: async () => { world.firestoreReads += 1; return { logs: [], deletedIds: [], lastId: undefined, done: true, invalidCount: 0 }; },
    readLegacyLogsUpdatedSince: async () => ({ logs: [], deletedIds: [], done: true, invalidCount: 0 }),
    readLegacySharedProfile: async () => null,
    cancelLegacyDeletion: async () => undefined,
    withFirestoreLock: (fn) => fn(),
    withFirestoreTimeout: (fn) => fn(),
    classifyFirestoreError: (error) => (error?.code === 'resource-exhausted' ? 'quota' : error?.code === 'denied' ? 'denied' : 'error'),
  };
  let migrator = null;
  const runner = createSyncRunner({
    // 시나리오가 정한 처리기(syncHandlers)를 차례로 씁니다. 없으면 이어 가기 없이 성공합니다.
    syncWithCloud: async (key, _logs, profile, _backup, _abort, _create, forceFullRead) => {
      const call = { key, forceFullRead: Boolean(forceFullRead), n: world.syncCalls.length + 1 };
      world.syncCalls.push(call);
      const handler = world.syncHandlers.shift();
      const base = { logs: [], profile, success: true, merged: false };
      return handler ? { ...base, ...(await handler(call)) } : base;
    },
    getLogs: async () => [],
    getProfile: async () => ({ syncKey: world.runnerKey }),
    saveProfile: async () => true,
    readProfileAfterPendingWrites: async () => ({ syncKey: world.runnerKey }),
    timeoutMs: 10_000,
    onEvent: (event) => world.events.push({ type: event.type, requestId: event.requestId, continuing: event.result?.continuing }),
    migrationGate: (key) => migrator.migrationGate(key),
  });
  migrator = createFamilyMigrator({
    storage,
    cloud,
    getClientId: async () => 'client-1',
    getRunner: () => runner,
    loadFirestore: async () => firestore,
    askBackupFailure: async () => 'later',
    askLegacyDeletionChoice: async () => 'later',
    notify: () => undefined,
    now: () => world.now,
    setTimer: () => ({}),
    clearTimer: () => undefined,
  });
  Object.assign(world, { runner, migrator });
  /** 시나리오가 끝나면 구독과 타이머를 정리합니다. */
  world.dispose = () => migrator.dispose();
  return world;
};

const UPLOADING = { continuing: true, progressed: true };

// ════════════════════════════════ A. 병합 완료 + missing의 다시 읽기는 실패 간격을 지킨다 ════════════════════════════════
await scenario('A', '병합 완료 + D1 missing: 가족 문서 다시 읽기가 실패하면 간격(30분) 동안 ensure가 여러 번 불려도 Firestore 읽기 0회이고, 할당량 소진이면 태평양 자정 전까지 0회이며 자정 뒤에 다시 읽어 이어받는다', ['A'], async ({ fs, A, adapter }) => {
  const K = hexKey('A');
  await fs.seed(K, { members: ['legacy-B'], logs: seeds(5, 'ga-') });
  await A.send('bootApp');
  // 병합 완료(mergeSource ok)와 D1 missing 상태를 저장소에 직접 만든다(이어받기 전에 끝난 앱, 시나리오 8과 같은 상태).
  const t0 = await nowOf(A);
  await A.send('writeStorage', { key: migrationKey(K), json: { mergeSource: 'ok', mergedAt: t0, baselineChangedAt: 0, firestoreReadAfter: 'ga-0004' } });
  assert.equal((await stateOf(A, K)).state.mergeSource, 'ok');

  // 가족 문서를 다시 읽다 실패한다 → 실패 간격이 적힌다.
  await fs.fail({ match: { op: 'get', kind: 'family', device: A.name }, code: 'unavailable', times: 'always' });
  const first = await A.send('runMigration');
  assert.equal(first.result.status, 'firestore_failed', JSON.stringify(first));
  const failed = (await stateOf(A, K)).state;
  const gap = failed.nextFirestoreAttemptAt - t0;
  assert.ok(gap >= 30 * MINUTE && gap < 31 * MINUTE, `전제: 가벼운 실패 간격(30분)이 적혔다(${gap}ms)`);

  // 간격 안에서 ensure(저장, 앱 복귀, 새로고침이 부르는 것)를 여러 번 부른다 → Firestore 읽기 0회.
  const mark = await fs.opCount();
  for (let i = 0; i < 5; i += 1) {
    const again = await A.send('runMigration');
    assert.equal(again.result.status, 'waiting', `간격 안의 ensure는 대기 결과다: ${JSON.stringify(again.result)}`);
  }
  // 관문이 막은 러너 요청도 ensure를 부른다.
  for (let i = 0; i < 3; i += 1) {
    const gated = await A.send('runnerRequest', { request: { syncKey: K } });
    assert.equal(gated.migrationPending, true);
  }
  await settle(300);
  assert.equal((await opsBy(fs, A, mark)).length, 0, '간격 안에서 Firestore를 한 번도 읽지 않았다');
  assert.equal((await stateOf(A, K)).state.failureCount, failed.failureCount, '간격 안의 ensure는 실패 횟수를 늘리지 않는다');

  // 간격이 지나면 다시 읽는다(영원히 막지 않는다).
  await advance(A, fs, 31 * MINUTE);
  const mark2 = await fs.opCount();
  assert.equal((await A.send('runMigration')).result.status, 'firestore_failed');
  assert.ok((await opsBy(fs, A, mark2)).length >= 1, '간격이 지나면 다시 읽는다');

  // 할당량 소진: 다음 시도는 태평양 시간 자정 + 1분이고 그 전에는 읽지 않는다.
  await fs.clearFaults();
  await fs.exhaust({ device: A.name });
  await advance(A, fs, 61 * MINUTE);
  const quotaRun = await A.send('runMigration');
  assert.equal(quotaRun.result.status, 'firestore_failed', JSON.stringify(quotaRun));
  const midnight = nextPacificMidnight(await nowOf(A)) + MINUTE;
  const quotaState = (await stateOf(A, K)).state;
  assert.equal(quotaState.nextFirestoreAttemptAt, midnight, '다음 시도는 태평양 시간 다음 자정 + 1분이다');
  const mark3 = await fs.opCount();
  for (let i = 0; i < 5; i += 1) assert.equal((await A.send('runMigration')).result.status, 'waiting');
  await advance(A, fs, Math.max(0, midnight - 5 * MINUTE - (await nowOf(A))));
  for (let i = 0; i < 3; i += 1) assert.equal((await A.send('runMigration')).result.status, 'waiting', '자정 전에는 계속 대기한다');
  await settle(300);
  assert.equal((await opsBy(fs, A, mark3)).length, 0, '할당량 소진 뒤 자정 전에는 Firestore 읽기 0회');

  // 자정이 지나고 Firestore가 살아나면 다시 읽어 이어받는다.
  await fs.clearFaults();
  await advance(A, fs, 10 * MINUTE);
  const mark4 = await fs.opCount();
  const adopted = await A.send('runMigration');
  assert.equal(adopted.result.status, 'uploading', JSON.stringify(adopted));
  assert.ok((await opsBy(fs, A, mark4)).some((o) => o.op === 'get' && o.kind === 'family'), '자정 뒤에는 가족 문서를 다시 읽었다');
  await waitMigrationComplete(A, { syncKey: K });
  assert.equal((await stateOf(A, K)).state.mergeSource, 'ok');
  // 저장소 상태를 직접 만들었으므로 기기에는 Firestore 기록이 합쳐져 있지 않다. 여기서는 이어받기까지만 확인한다.
  assert.equal((await adapter.family(K)).exists, true, 'D1 가족을 이어받았다');
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('A') }) } } });

// ════════════════════════════════ B. 합쳐질 때 이어 가기 요청의 번호 ════════════════════════════════
// 재현 순서: R0(전체 모드 새로고침, 번호 1)이 도는 중에 이전 모듈이 7단계 U(번호 2)를 넣는다. R0가 이어 가기 C를 번호 1로 대기열에 넣고(U 뒤),
// U의 이어 가기가 그 C에 합쳐진다. 고치기 전에는 C가 번호 1이라 U의 번호(2)보다 작아 사건이 버려지고 d1UploadedAt이 적히지 않는다.
await inProcess('B', '이어 가기 요청이 번호가 더 작은 대기 요청에 합쳐져도 사슬 번호가 7단계 번호 이상이라 마지막 회차 성공이 d1UploadedAt을 적는다', async () => {
  // 근거 없음: 관문이 R0를 막지 않는다(7단계는 ensure가 직접 넣는다).
  const w = makeWorld({ tag: 'B', evidence: false, state: { mergeSource: 'ok', mergedAt: 1 } });
  try {
    const r0Gate = gate();
    w.syncHandlers.push(async () => { await r0Gate.promise; return UPLOADING; }); // R0: 이어 가기를 남김
    w.syncHandlers.push(async () => UPLOADING); // U: 이어 가기를 남김
    // C: 기본 처리기(이어 가기 없는 성공)
    const r0 = w.runner.request({ syncKey: w.KEY, forceFullRead: true });
    await waitFor(() => w.syncCalls.length === 1, { label: 'R0 시작' });
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    r0Gate.open();
    await r0;
    await waitFor(async () => typeof w.state.d1UploadedAt === 'number', { label: 'd1UploadedAt 기록', timeoutMs: 3_000 });
    const succeeded = w.events.filter((e) => e.type === 'succeeded');
    assert.deepEqual(succeeded.map((e) => [e.requestId, Boolean(e.continuing)]), [[1, true], [2, true], [2, false]],
      `R0(1), U(2), 합쳐진 이어 가기(7단계 번호 2로 올라감): ${JSON.stringify(w.events)}`);
    assert.equal(w.syncCalls.length, 3, '회차는 R0, U, 합쳐진 이어 가기 셋이다');
  } finally { w.dispose(); }
});

await inProcess('B2', '평소 요청끼리의 합치기는 그대로다: 합쳐진 요청은 같은 Promise를 받고, 이어 가기가 아닌 요청은 대기 요청의 번호를 올리지 않는다', async () => {
  const w = makeWorld({ tag: 'B2', state: { mergeSource: 'skipped', mergedAt: 1, d1UploadedAt: 1 } });
  try {
    const gate0 = gate();
    w.syncHandlers.push(async () => { await gate0.promise; return {}; });
    const first = w.runner.request({ syncKey: w.KEY, forceFullRead: true }); // 번호 1, 실행 중
    await waitFor(() => w.syncCalls.length === 1, { label: '첫 요청 시작' });
    const accepted = [];
    const p2 = w.runner.request({ syncKey: w.KEY }, { onAccepted: (id) => accepted.push(id) }); // 번호 2, 대기
    const p3 = w.runner.request({ syncKey: w.KEY }, { onAccepted: (id) => accepted.push(id) }); // 합쳐짐
    assert.equal(p2, p3, '합쳐진 요청은 같은 Promise를 돌려준다');
    assert.deepEqual(accepted, [2, 2], '합쳐진 평소 요청은 처음 받은 요청의 번호를 쓴다');
    gate0.open();
    await Promise.all([first, p2]);
    assert.deepEqual(w.events.filter((e) => e.type === 'succeeded').map((e) => e.requestId), [1, 2]);
  } finally { w.dispose(); }
});

// ════════════════════════════════ C. 실패한 7단계와 평소 요청의 완료 ════════════════════════════════
await inProcess('C1', '7단계가 실패해도 번호를 지우지 않아, 뒤의 평소 요청이 업로드를 마치면(장부에 full 없음) d1UploadedAt이 적힌다', async () => {
  const w = makeWorld({ tag: 'C1', state: { mergeSource: 'ok', mergedAt: 1 } });
  try {
    w.syncHandlers.push(async () => ({ success: false, error: '서버에 연결하지 못했습니다.' })); // U: 실패
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => w.events.some((e) => e.type === 'failed'), { label: '7단계 실패 사건', timeoutMs: 3_000 });
    assert.equal(w.state.d1UploadedAt, undefined);
    // D1이 exists인 키는 관문이 ensure를 부르지 않는다: 평소 동기화만 돈다.
    const normal = await w.runner.request({ syncKey: w.KEY });
    assert.equal(normal.success, true);
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: '평소 요청 성공이 적은 d1UploadedAt', timeoutMs: 3_000 });
    assert.equal(w.syncCalls.filter((c) => c.forceFullRead).length, 1, '7단계는 다시 넣지 않았다(평소 요청이 마쳤다)');
  } finally { w.dispose(); }
});

await inProcess('C2', '7단계가 실패하면 다음 ensure가 pending으로 막히지 않고 7단계를 다시 넣으며, 이어 가기 도중 장부에 full이 남으면 평소 요청의 성공으로 완료하지 않는다', async () => {
  const w = makeWorld({ tag: 'C2', state: { mergeSource: 'ok', mergedAt: 1 } });
  try {
    w.syncHandlers.push(async () => ({ success: false, error: 'x' }));
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => w.events.some((e) => e.type === 'failed'), { label: '실패 사건', timeoutMs: 3_000 });
    // 아직 실패 표시가 없는 진행 중 요청에는 쌓지 않는다는 것도 확인한다: 바로 이어서 두 번 불러도 7단계는 한 번만 더 들어간다.
    w.ledgerFull = true; // 당겨 받기가 끝나지 않았다
    const [r1, r2] = await Promise.all([w.migrator.ensure(w.KEY), w.migrator.ensure(w.KEY)]);
    assert.deepEqual([r1.status, r2.status], ['uploading', 'uploading']);
    await waitFor(() => w.syncCalls.length === 2, { label: '7단계 재요청', timeoutMs: 3_000 });
    await settle(100);
    assert.equal(w.syncCalls.filter((c) => c.forceFullRead).length, 2, '실패한 7단계를 한 번 다시 넣었다');
    assert.equal(w.state.d1UploadedAt, undefined, '장부에 full이 남아 있으면 성공해도 완료로 적지 않는다');
    w.ledgerFull = false;
    await w.runner.request({ syncKey: w.KEY });
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: '완료', timeoutMs: 3_000 });
  } finally { w.dispose(); }
});

await inProcess('C3', '러너가 요청하지 않고 끝낸 7단계(가족 키 불일치)도 번호가 남아 ensure를 막지 않고, 다음 ensure가 7단계를 다시 넣어 마친다', async () => {
  const w = makeWorld({ tag: 'C3', state: { mergeSource: 'ok', mergedAt: 1 } });
  try {
    w.runnerKey = 'other-family'; // 러너가 회차를 시작할 때 저장된 키가 달라 D1에 요청하지 않고 끝난다("Sync is not connected").
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => w.events.some((e) => e.type === 'dropped'), { label: '버려진 요청 사건', timeoutMs: 3_000 });
    assert.equal(w.syncCalls.length, 0, '러너가 동기화 함수를 부르지 않았다');
    w.runnerKey = w.KEY;
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: '다시 넣은 7단계의 완료', timeoutMs: 3_000 });
    assert.deepEqual(w.syncCalls.map((c) => c.forceFullRead), [true], '7단계를 다시 넣어 한 번 돌렸다');
  } finally { w.dispose(); }
});

await inProcess('C4', '가족이 바뀐 사이에 끝난 7단계(회차 도중 키 변경)도 다시 넣을 수 있다', async () => {
  const w = makeWorld({ tag: 'C4', state: { mergeSource: 'ok', mergedAt: 1 } });
  try {
    const hold = gate();
    w.syncHandlers.push(async () => { await hold.promise; w.runnerKey = 'other-family'; return {}; }); // 회차 도중 다른 가족으로 바뀜
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => w.syncCalls.length === 1, { label: '7단계 시작' });
    hold.open();
    await waitFor(() => w.events.some((e) => e.type === 'dropped'), { label: '버려진 요청 사건', timeoutMs: 3_000 });
    assert.equal(w.state.d1UploadedAt, undefined);
    w.runnerKey = w.KEY;
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: '다시 넣은 7단계의 완료', timeoutMs: 3_000 });
    assert.equal(w.syncCalls.filter((c) => c.forceFullRead).length, 2);
  } finally { w.dispose(); }
});

await inProcess('C6', "진행 중인 7단계가 있으면 ensure를 순차로 여러 번 불러도 forceFullRead 요청이 더 들어가지 않는다(pending 판정)", async () => {
  const w = makeWorld({ tag: 'C6', state: { mergeSource: 'ok', mergedAt: 1 } });
  try {
    // 러너 요청 기록: 이전 모듈이 러너에 넣는 요청을 그대로 센다(Promise.all로 겹쳐 부르는 C2와 달리 순차 호출이라 active 합치기로 가려지지 않는다).
    const requested = [];
    const originalRequest = w.runner.request;
    w.runner.request = (request, ...rest) => { requested.push(Boolean(request.forceFullRead)); return originalRequest(request, ...rest); };
    const hold = gate();
    w.syncHandlers.push(async () => { await hold.promise; return {}; }); // 첫 7단계: 러너 회차를 끝내지 못하게 멈춘다
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => w.syncCalls.length === 1, { label: '첫 7단계 시작' });
    assert.deepEqual(requested, [true], '첫 ensure가 7단계 하나를 넣었다');
    // 순차로 다시 부른다(앞의 호출이 끝난 뒤). 진행 중이므로 요청을 쌓지 않는다.
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    }
    assert.deepEqual(requested, [true], '진행 중인 7단계가 있는데 ensure를 순차로 다시 불러 forceFullRead 요청이 더 들어갔다');
    hold.open();
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: '7단계 완료', timeoutMs: 3_000 });
    await settle(150);
    assert.deepEqual(requested, [true], '완료 뒤에도 추가 요청이 없다');
    assert.equal(w.syncCalls.length, 1, '러너 회차는 하나뿐이다');
  } finally { w.dispose(); }
});

await scenario('C5', '실제 서버: 7단계가 서버 오류로 실패해도 뒤의 평소 동기화가 업로드를 마치면 이전이 완료되고 D1에 모든 기록이 있으며, 다음 ensure도 7단계를 다시 넣을 수 있다', ['A', 'B', 'C'], async ({ adapter, fs, A, B, C }) => {
  // (a) 평소 동기화가 마쳐 완료
  {
    const K = hexKey('C5a');
    const famLogs = seeds(40, 'fa-');
    await fs.seed(K, { members: ['legacy-B'], logs: famLogs });
    await B.send('bootApp');
    await newKeyFamily(B, K); // D1에 이미 가족이 있다(상대가 먼저 옮김). A는 근거가 있어 Firestore를 읽는다.
    await A.send('bootApp');
    // 7단계의 첫 서버 요청(당겨 받기)이 서버 오류로 끝난다. 연결 확인(connect)은 지나간다.
    await adapter.failHttp({ status: 500, match: { kind: 'pull', clientId: await clientIdOf(A) }, times: 1 });
    assert.equal((await A.send('runMigration')).result.status, 'uploading');
    await waitFor(async () => (await A.send('runnerEvents')).events.some((e) => e.type === 'failed'), { label: '7단계 실패 사건', timeoutMs: 20_000 });
    let state = await stateOf(A, K);
    assert.equal(state.state.mergeSource, 'ok');
    assert.equal(state.state.d1UploadedAt, undefined, '전제: 7단계가 실패해 아직 완료가 아니다');
    await adapter.clearFaults();
    // D1이 exists라 관문은 ensure를 부르지 않는다. 평소 동기화가 이어 가며 업로드를 마친다.
    for (let i = 0; i < 6 && !(await stateOf(A, K)).complete; i += 1) {
      await A.send('runnerRequest', { request: { syncKey: K }, timeoutMs: 30_000 }, { timeoutMs: 90_000 });
      await settle(200);
    }
    state = await stateOf(A, K);
    assert.equal(state.complete, true, `평소 동기화가 마친 뒤 완료가 적혀야 한다: ${JSON.stringify(state.state)}`);
    assert.deepEqual(await d1Live(adapter, K), sortedIds(famLogs.map((l) => l.id)), 'D1에 모든 기록이 올랐다');
    assert.deepEqual(await idsOf(A), sortedIds(famLogs.map((l) => l.id)), '기록이 줄지 않았다');
  }
  // (b) 실패 뒤 ensure가 7단계를 다시 넣어 완료
  {
    const K = hexKey('C5b');
    const famLogs = seeds(25, 'fb-');
    await fs.seed(K, { members: ['legacy-B'], logs: famLogs });
    await C.send('bootApp');
    await adapter.failHttp({ status: 500, match: { kind: 'pull', clientId: await clientIdOf(C) }, times: 1 });
    await C.send('setProfile', { patch: { syncKey: K } });
    // D1이 missing이라 이어받기가 일어나고 7단계가 실패한다.
    assert.equal((await C.send('runMigration')).result.status, 'uploading');
    await waitFor(async () => (await C.send('runnerEvents')).events.some((e) => e.type === 'failed'), { label: '7단계 실패 사건', timeoutMs: 20_000 });
    await adapter.clearFaults();
    assert.equal((await stateOf(C, K)).complete, false);
    assert.equal((await C.send('runMigration')).result.status, 'uploading', '실패한 7단계는 pending으로 막히지 않고 다시 들어간다');
    await waitMigrationComplete(C, { syncKey: K });
    assert.deepEqual(await d1Live(adapter, K), sortedIds(famLogs.map((l) => l.id)));
  }
}, { deviceOptions: {
  A: { initialStorage: make179Storage({ syncKey: hexKey('C5a') }) },
  C: { initialStorage: make179Storage({ syncKey: hexKey('C5b') }) },
} });

// ════════════════════════════════ D. markUploaded는 사건을 받은 시점의 번호만 인정한다 ════════════════════════════════
// 재현: 7단계 성공 사건이 장부를 읽는 동안(게이트) 다시 병합해 새 7단계가 들어간다. 사건을 받은 번호(옛 업로드)와 지금 번호가 다르면 적지 않는다.
await inProcess('D', '장부를 읽는 사이에 7단계 번호가 바뀌면 옛 업로드(U1)의 성공 사건은 d1UploadedAt을 적지 않고 새 업로드(U2)의 완료만 인정한다', async () => {
  const w = makeWorld({ tag: 'D', d1: 'exists', state: {} });
  try {
    // U1: Firestore가 실패해 병합 없이 올린다(게이트로 멈춤).
    w.firestoreFailure = 'unavailable';
    const hold1 = gate();
    const hold2 = gate();
    w.syncHandlers.push(async () => { await hold1.promise; return {}; });
    w.syncHandlers.push(async () => { await hold2.promise; return {}; });
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => w.syncCalls.length === 1, { label: 'U1 시작' });

    // U1이 성공하면 markUploaded가 장부 읽기에서 멈춘다.
    w.ledgerGate = gate();
    hold1.open();
    await waitFor(() => w.ledgerGate.reached, { label: 'markUploaded가 장부를 읽는 중', timeoutMs: 3_000 });

    // 그 사이에 다시 병합하고 U2를 넣는다(7단계 번호가 바뀐다).
    w.firestoreFailure = null;
    w.now += 31 * MINUTE;
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading');
    await waitFor(() => w.syncCalls.length === 2, { label: 'U2 시작', timeoutMs: 3_000 });
    assert.equal(w.state.mergeSource, 'ok');

    // 장부 읽기가 끝나도 옛 사건은 적지 않는다.
    w.ledgerGate.open();
    await settle(150);
    assert.equal(w.state.d1UploadedAt, undefined, '옛 업로드의 사건으로 d1UploadedAt을 적지 않는다');
    w.ledgerGate = null;
    hold2.open();
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: 'U2 완료', timeoutMs: 3_000 });
  } finally { w.dispose(); }
});

// D2: 위 D는 장부 읽기(첫 번호 확인 앞)에서만 멈춘다. 여기서는 장부 확인을 통과한 뒤 getMigrationState를 기다리는 동안 병합이 끼어든다.
// 병합은 번호와 d1UploadedAt을 지우고(U2를 넣기 전에 멈춘다), 그 뒤 markUploaded가 이어져도 U2가 끝나기 전에는 d1UploadedAt을 적으면 안 된다.
await inProcess('D2', 'markUploaded가 getMigrationState를 기다리는 사이에 병합이 번호를 무효로 하면 옛 업로드(U1)는 d1UploadedAt을 적지 않고 U2 완료만 인정한다', async () => {
  const w = makeWorld({ tag: 'D2', d1: 'exists', state: {} });
  try {
    w.firestoreFailure = 'unavailable';
    const hold1 = gate();
    const hold2 = gate();
    w.syncHandlers.push(async () => { await hold1.promise; return {}; }); // U1
    w.syncHandlers.push(async () => { await hold2.promise; return {}; }); // U2
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading', 'U1을 넣었다(Firestore 실패, 병합 없음)');
    await waitFor(() => w.syncCalls.length === 1, { label: 'U1 시작' });

    // U1 성공 → markUploaded가 장부 읽기에서 멈춘다. 장부 확인을 통과시키되 곧바로 getMigrationState에서 멈추게 문을 걸어 둔다.
    w.ledgerGate = gate();
    hold1.open();
    await waitFor(() => w.ledgerGate.reached, { label: 'markUploaded가 장부를 읽는 중', timeoutMs: 3_000 });
    const stateGate = gate();
    w.stateGate = stateGate;
    const ledgerGate = w.ledgerGate;
    w.ledgerGate = null;
    ledgerGate.open();
    await waitFor(() => stateGate.reached, { label: 'markUploaded가 getMigrationState를 기다리는 중(장부 확인은 통과)', timeoutMs: 3_000 });
    assert.equal(w.state.d1UploadedAt, undefined);

    // 그 사이 병합이 끼어든다: 병합이 번호를 무효로 하고 d1UploadedAt을 지운 뒤 U2를 넣기 전(전환기 상태 읽기)에서 멈춘다.
    w.firestoreFailure = null;
    w.now += 31 * MINUTE;
    w.transitionGate = gate();
    const second = w.migrator.ensure(w.KEY);
    await waitFor(() => w.transitionGate.reached, { label: '병합 직후(U2를 넣기 전)', timeoutMs: 3_000 });
    assert.equal(w.state.mergeSource, 'ok');

    // 멈췄던 markUploaded가 이어진다. 두 번째 번호 확인이 없으면 여기서 d1UploadedAt이 적힌다.
    stateGate.open();
    await settle(150);
    assert.equal(w.state.d1UploadedAt, undefined, 'getMigrationState를 기다리는 사이 번호가 무효가 됐는데 옛 업로드(U1)가 d1UploadedAt을 적었다');

    // U2를 넣고 끝낸다: U2가 끝나기 전에는 완료가 아니고, 끝나면 적힌다.
    w.transitionGate.open();
    assert.equal((await second).status, 'uploading');
    await waitFor(() => w.syncCalls.length === 2, { label: 'U2 시작', timeoutMs: 3_000 });
    await settle(100);
    assert.equal(w.state.d1UploadedAt, undefined, 'U2가 끝나기 전에는 완료가 아니다');
    hold2.open();
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: 'U2 완료', timeoutMs: 3_000 });
  } finally { w.dispose(); }
});

// ════════════════════════════════ E. 병합 직후의 병합 전 업로드 사건 ════════════════════════════════
// 재현 순서: ① Firestore가 실패해 병합 없이 U1이 올라간다(게이트로 멈춤). ② 간격이 지나 다시 읽어 병합한다. 병합이 d1UploadedAt을 지운 뒤
// U2를 넣기 전(전환기 상태 읽기에서 멈춤)에 ③ U1이 성공한다. 고치기 전에는 ③이 d1UploadedAt을 적어 U2가 끝나기 전에 이전이 완료로 보인다.
await inProcess('E', '병합 직후 병합 전 업로드(U1)의 성공 사건은 d1UploadedAt을 적지 않고, 병합 뒤 업로드(U2)가 끝나야 완료가 된다', async () => {
  const w = makeWorld({ tag: 'E', d1: 'exists', state: {} });
  try {
    w.firestoreFailure = 'unavailable';
    const hold1 = gate();
    const hold2 = gate();
    w.syncHandlers.push(async () => { await hold1.promise; return {}; }); // U1
    w.syncHandlers.push(async () => { await hold2.promise; return {}; }); // U2
    assert.equal((await w.migrator.ensure(w.KEY)).status, 'uploading', 'U1을 넣었다(Firestore 실패, 병합 없음)');
    await waitFor(() => w.syncCalls.length === 1, { label: 'U1 시작' });
    assert.equal(w.state.mergeSource, undefined);

    // 간격이 지나고 Firestore가 살아난다. 병합 뒤 전환기 상태 읽기에서 멈춘다.
    w.firestoreFailure = null;
    w.now += 31 * MINUTE;
    w.transitionGate = gate();
    const second = w.migrator.ensure(w.KEY);
    await waitFor(() => w.transitionGate.reached, { label: '병합 직후(U2를 넣기 전)', timeoutMs: 3_000 });
    assert.equal(w.state.mergeSource, 'ok');
    assert.equal(w.state.d1UploadedAt, undefined);

    // ③ 이 틈에 U1이 성공한다.
    hold1.open();
    await settle(150);
    assert.equal(w.state.d1UploadedAt, undefined, 'U1의 성공 사건이 d1UploadedAt을 적으면 U2 완료가 무시된다');

    // U2를 넣고 끝낸다.
    w.transitionGate.open();
    assert.equal((await second).status, 'uploading');
    await waitFor(() => w.syncCalls.length === 2, { label: 'U2 시작', timeoutMs: 3_000 });
    await settle(100);
    assert.equal(w.state.d1UploadedAt, undefined, 'U2가 끝나기 전에는 완료가 아니다');
    hold2.open();
    await waitFor(() => typeof w.state.d1UploadedAt === 'number', { label: 'U2 완료', timeoutMs: 3_000 });
  } finally { w.dispose(); }
});

// ════════════════════════════════ P39. 병합 뒤 7단계는 forceFullRead다 (변이 표 39행) ════════════════════════════════
// 시나리오 30(4b)은 장부가 없거나 시계를 6시간 넘게 옮겨 평소 요청도 전체 모드라 forceFullRead를 빼도 통과한다. 여기서는 장부가 1시간 전에
// 전체 읽기를 마쳤고(6시간 이내), 평소 요청이 증분 모드임을 먼저 확인한 뒤, 병합 직후의 7단계 회차가 전체 당겨 받기(after 0)로 시작하는지 판정한다.
const isFullPull = (r) => Boolean(r.pull) && r.pull.after[0] === 0 && r.pull.after[1] === '';
await scenario('P39', '병합 뒤 7단계: 장부가 6시간 안에 전체 읽기를 마친 기기도 병합 직후 7단계는 전체 모드로 돌고 병합한 기록이 D1에 오른다', ['A'], async ({ harness, adapter, fs, A }) => {
  const K = hexKey('P39');
  const famLogs = seeds(20, 'fp-');
  await fs.seed(K, { members: ['legacy-X'], logs: famLogs });
  await adapter.ensureFamily(K);
  for (const l of seeds(3, 'd1only-', 1_700_000_000_000)) await adapter.injectLog(K, l);
  await A.send('bootApp');
  const id = await clientIdOf(A);
  await A.send('setTiming', { requestTimeoutMs: 8_000 });
  await A.send('runnerReset', { timeoutMs: 20_000 });
  const syncOf = async (from) => (await adapter.requests(from)).filter((r) => r.clientId === id && (r.kind === 'push' || r.kind === 'pull'));

  // 1) Firestore가 막힌 채 병합 전 7단계가 돈다: 전체 읽기를 마쳐 장부에 lastFullReadAt이 적힌다.
  await fs.offline(true);
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  const s1 = await waitFor(async () => { const s = await stateOf(A, K); return typeof s.state.d1UploadedAt === 'number' ? s : null; }, { label: '병합 전 업로드 완료', timeoutMs: 20_000 });
  assert.equal(s1.state.mergeSource, undefined, '전제: 아직 병합하지 않았다');
  assert.ok((await syncOf(0)).some(isFullPull), '전제: 병합 전 7단계가 전체 읽기를 마쳤다');

  // 2) 1시간 뒤(6시간 이내): 평소 요청은 증분 모드다 - 이 전제가 깨지면 forceFullRead 없이도 전체 모드가 되어 판정이 무의미하다.
  await harness.advanceClocks(HOUR);
  const markPlain = await adapter.requestCount();
  await A.send('runnerRequest', { request: { syncKey: K }, timeoutMs: 30_000 }, { timeoutMs: 60_000 });
  const plain = await syncOf(markPlain);
  assert.ok(plain.some((r) => r.pull), '전제: 평소 요청이 당겨 받기를 했다');
  assert.ok(!plain.some(isFullPull), `전제: 장부가 6시간 안이라 평소 요청은 전체 모드가 아니다: ${JSON.stringify(plain.map((r) => r.pull))}`);
  assert.deepEqual((await stateOf(A, K)).state.mergeSource, undefined, '전제: 평소 요청이 병합을 일으키지 않았다');

  // 3) Firestore가 살아나고 병합한다. 병합 직후의 7단계 회차를 판정한다.
  await fs.offline(false);
  const mark = await adapter.requestCount();
  const run = await A.send('runMigration', {}, { timeoutMs: 60_000 });
  assert.equal(run.result.status, 'uploading', JSON.stringify(run));
  const done = await waitMigrationComplete(A, { syncKey: K, timeoutMs: 30_000 });
  assert.equal(done.state.mergeSource, 'ok');
  const after = await syncOf(mark);
  const firstPull = after.find((r) => r.pull);
  assert.ok(firstPull && isFullPull(firstPull), `병합 뒤 7단계의 첫 당겨 받기가 전체 모드(after 0)가 아니다(forceFullRead 누락): ${JSON.stringify(after.map((r) => r.pull?.after ?? null))}`);
  assert.deepEqual(await d1Live(adapter, K), sortedIds([...famLogs.map((l) => l.id), ...seeds(3, 'd1only-').map((l) => l.id), ...seeds(3, 'loc-').map((l) => l.id)]), '병합한 기록이 D1에 올랐다(기기 기록, D1 기록 포함)');
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('P39'), logs: seeds(3, 'loc-', 1_700_000_100_000) }) } } });

// ════════════════════════════════ H. 예약이 없어지면 이미 물어본 예약 값을 지운다 ════════════════════════════════
await scenario('H', '병합 완료 + D1 missing의 다시 읽기에서 예약이 없어졌으면(null) promptedPendingDeletionAt을 지우고 이어받는다', ['A'], async ({ fs, A, adapter }) => {
  const K = hexKey('H');
  await fs.seed(K, { members: ['legacy-B'], logs: seeds(3, 'gh-') });
  await A.send('bootApp');
  const t0 = await nowOf(A);
  const oldValue = t0 + 7 * DAY;
  // 이미 물어본 예약 값이 있고 병합은 끝났다. 상대는 그 사이 예약을 취소했다(가족 문서는 pendingDeletionAt이 없다).
  await A.send('writeStorage', { key: migrationKey(K), json: { mergeSource: 'ok', mergedAt: t0, baselineChangedAt: 0, firestoreReadAfter: 'gh-0002', promptedPendingDeletionAt: oldValue } });
  const run = await A.send('runMigration');
  assert.equal(run.result.status, 'uploading', JSON.stringify(run));
  await waitMigrationComplete(A, { syncKey: K });
  const done = (await stateOf(A, K)).state;
  assert.equal(done.promptedPendingDeletionAt, undefined, '예약이 없어졌으므로 이미 물어본 예약 값을 지운다');
  assert.equal((await adapter.family(K)).exists, true);
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('H') }) } } });

await inProcess('H2', '가짜 세계에서도 같다: 다시 읽기가 예약 없음이면 값을 지우고, 예약이 있으면 지우지 않는다', async () => {
  const cancelled = makeWorld({ tag: 'H2a', d1: 'missing', state: { mergeSource: 'ok', mergedAt: 1, promptedPendingDeletionAt: 123 } });
  try {
    assert.equal((await cancelled.migrator.ensure(cancelled.KEY)).status, 'uploading');
    assert.equal(cancelled.state.promptedPendingDeletionAt, undefined);
  } finally { cancelled.dispose(); }
  const pending = makeWorld({ tag: 'H2b', d1: 'missing', state: { mergeSource: 'ok', mergedAt: 1, promptedPendingDeletionAt: 123 }, family: { exists: true, pendingDeletionAt: 123, lastChangedAt: 1 } });
  try {
    assert.equal((await pending.migrator.ensure(pending.KEY)).status, 'pending_deletion');
    assert.equal(pending.state.promptedPendingDeletionAt, 123, '예약이 그대로면 값을 지우지 않는다');
  } finally { pending.dispose(); }
});

// ════════════════════════════════ 집계 ════════════════════════════════
const failed = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오 4부 보강(s4c): ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
