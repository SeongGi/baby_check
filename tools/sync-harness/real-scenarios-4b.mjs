// 실제 서버 모드 시나리오 4부 b: 07 설계 5.2의 시나리오 18~34(기기 이름 접두어 s4b). 1~17은 real-scenarios-4a.mjs(s4a)에 있습니다.
// 뼈대는 real-scenarios-3.mjs와 같고, 모든 시나리오는 끝나기 전에 auditFirestoreWrites(불변 조건 2)를 거칩니다.
// 시나리오 25는 이 파일이 돈 시나리오들의 앱 쓰기를 모아 설계 문장대로 따로 판정합니다.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-4b.mjs
//       HARNESS_ONLY=18,20 bash tools/sync-harness/verify.sh scenario real-scenarios-4b.mjs   (일부만)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { auditFirestoreWrites, HARNESS_DIR, make179Storage, startRealHarness, waitFor, waitMigrationComplete } from './real-harness.mjs';
import { runCleanupCheck } from '../firestore-cleanup-check/compare.mjs';
import { d1FamilyId, firestoreFamilyId as cleanupFirestoreId } from '../firestore-cleanup-check/hash.mjs';
import { shouldAlertOnRefresh, shouldCheckDeletionStatus, shouldStartPolling } from '../../src/database/migrationDecision.ts';

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];
const ran = [];
const appWriteLog = [];

// ────────────── 시나리오 뼈대 ──────────────
const scenario = async (id, title, deviceNames, deviceOptions, fn) => {
  if (ONLY && !ONLY.includes(id)) return;
  const started = Date.now();
  let harness = null;
  try {
    harness = await startRealHarness({ devices: deviceNames, deviceOptions });
    const { server, devices } = harness;
    await fn({ harness, server, fs: server.fs, adapter: server.adapter, devices: deviceNames.map((name) => devices[name]) });
    // 불변 조건 2: 앱이 Firestore에 쓴 것이 회원 문서 생성과 pendingDeletionAt: null뿐이고 지운 문서가 0건
    const audit = await auditFirestoreWrites(harness);
    appWriteLog.push(...audit.appWrites.map((w) => ({ scenario: id, ...w })));
    ran.push(id);
    results.push(true);
    console.log(`PASS [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)\n     ${error?.stack || error}`);
  } finally {
    await harness?.stop().catch(() => undefined);
  }
};

// ────────────── 도우미 ──────────────
const MARKER = '@baby_cf_legacy_key_v1';
const BACKUP = '@baby_pre_cloudflare_backup_v1';
const META = '@baby_pre_cloudflare_backup_meta_v1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const track = (promise) => { promise.catch(() => undefined); return promise; };
/** 서버 정규식(16~64자 [A-Za-z0-9_-])을 통과하는 32자 키. tag로 시나리오마다 다르게 만듭니다. */
const keyOf = (tag) => tag + createHash('sha256').update(tag).digest('hex').slice(0, 32 - tag.length);
const logOf = (id, extra = {}) => ({ id, type: 'formula', amount: 100, timestamp: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra });
const logsOf = (n, prefix, base = 1_700_000_000_000) => Array.from({ length: n }, (_, i) => logOf(`${prefix}-${String(i).padStart(4, '0')}`, { timestamp: base + i, updatedAt: base + i }));
const idsOf = async (device) => (await device.send('getLogs')).logs.map((l) => l.id).sort();
const stateOf = (device, syncKey) => device.send('migrationState', { syncKey });
const clientIdOf = async (device) => (await device.send('getSyncClientId')).clientId;
const d1Live = async (adapter, key) => (await adapter.logs(key)).live.map(([id]) => id).sort();
const storageItems = async (device, keys) => (await device.send('readStorage', { keys })).items;
const choicesOf = (device) => device.send('choiceLog');
const noticeCodes = async (device) => (await choicesOf(device)).notices.map((n) => n.code);
const isFullPull = (r) => Boolean(r.pull) && r.pull.after[0] === 0 && r.pull.after[1] === '';
/** 불변 조건 1: 기기 기록은 합치기만 하고 줄지 않는다(Firestore 삭제 표식이 가리킨 기록은 예외로 지정). */
const assertKept = async (device, before, label, except = []) => {
  const now = new Set(await idsOf(device));
  const lost = before.filter((id) => !now.has(id) && !except.includes(id));
  assert.deepEqual(lost, [], `${label}: 기기 기록이 줄었다 ${JSON.stringify(lost.slice(0, 5))}`);
};
const has179 = (opts) => ({ initialStorage: make179Storage(opts) });
const pendingChoice = (device, kind) => waitFor(async () => (await choicesOf(device)).pending.find((p) => p.kind === kind), { label: `${device.name}의 ${kind} 선택 화면` });
const fetchDelete = (server, key, body = { legacyDeletion: true }) => fetch(`${server.url}/api/family/delete`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': 's4b-direct', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));

// ════════════════════════════════ 18. 직전 백업 보존 ════════════════════════════════
const K18a = keyOf('s18a');
const K18b = keyOf('s18b');
await scenario('18', '직전 백업 보존: 두 번째 이전 시도가 백업을 덮어쓰지 않고, 백업 저장 실패는 사용자가 고르기 전까지 이전을 시작하지 않는다', ['s4bA', 's4bB'], {
  s4bA: has179({ syncKey: K18a, logs: logsOf(5, 'a-own', 5_000_000) }),
  s4bB: has179({ syncKey: K18b, logs: logsOf(3, 'b-own', 6_000_000) }),
}, async ({ harness, fs, adapter, devices: [A, B] }) => {
  await fs.seed(K18a, { members: ['legacy-X'], logs: logsOf(6, 'fa', 2_000_000) });
  await fs.seed(K18b, { members: ['legacy-X'], logs: logsOf(4, 'fb', 3_000_000) });
  await A.send('bootApp');
  await B.send('bootApp');
  const aBefore = await idsOf(A);
  const bBefore = await idsOf(B);

  // 첫 시도: Firestore를 끊어 이전이 끝나지 않게 한다. 백업은 이때 만들어진다.
  await fs.offline(true);
  assert.equal((await A.send('runMigration')).result.status, 'firestore_failed');
  const backup1 = await storageItems(A, [BACKUP, META]);
  const parsed1 = JSON.parse(backup1[BACKUP]);
  assert.deepEqual(parsed1.logs.map((l) => l.id).sort(), aBefore, '백업에는 이전 직전의 기록이 그대로 들어 있다');
  assert.equal(JSON.parse(backup1[META]).logCount, 5);

  // 사이에 기록이 더 늘고, Firestore가 살아난 뒤의 두 번째 시도가 같은 백업을 그대로 둔다.
  await A.send('addLog', { log: { type: 'formula', amount: 33, timestamp: 9_999_000 } });
  await fs.offline(false);
  await harness.advanceClocks(31 * MIN);
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(A, { timeoutMs: 30_000 });
  const backup2 = await storageItems(A, [BACKUP, META]);
  assert.equal(backup2[BACKUP], backup1[BACKUP], '두 번째 이전 시도가 백업 값을 덮어썼다');
  assert.equal(backup2[META], backup1[META], '두 번째 이전 시도가 백업 표지를 바꿨다');
  assert.ok((await idsOf(A)).length >= aBefore.length + 1 + 6, '두 번째 시도는 Firestore 기록과 새 기록을 합쳤다(백업과 달라졌다)');
  await assertKept(A, aBefore, 'A');

  // 백업 저장 실패: 사용자가 고르기 전까지 D1과 Firestore에 아무 요청도 없고 이전 상태도 비어 있다.
  await B.send('injectStorageFault', { mode: 'reject', keys: [BACKUP], times: 'always' });
  await B.send('setChoiceAnswers', { backupFailure: [{ hold: true }] });
  const reqMark = await adapter.requestCount();
  const fsMark = await fs.opCount();
  const pending = track(B.send('runMigration'));
  await pendingChoice(B, 'backupFailure');
  await sleep(300);
  assert.equal(await adapter.requestCount(), reqMark, '선택 전에 D1 요청이 나갔다');
  assert.equal(await fs.opCount(), fsMark, '선택 전에 Firestore 요청이 나갔다');
  assert.deepEqual((await stateOf(B)).state, {}, '선택 전에 이전 상태가 적혔다');
  await B.send('answerChoice', { kind: 'backupFailure', answer: 'later' });
  assert.equal((await pending).result.status, 'backup_pending');
  // 같은 실행에서 다시 불러도 묻지 않고 시작하지 않는다.
  assert.equal((await B.send('runMigration')).result.status, 'backup_pending');
  assert.equal((await choicesOf(B)).backupFailure.length, 1, '같은 실행에서 다시 물었다');
  assert.equal(await adapter.requestCount(), reqMark);
  assert.equal(await fs.opCount(), fsMark);
  // 앱을 다시 열면 한 번 더 묻고, 이번엔 "백업 없이 계속"을 고른다.
  await B.send('migratorReset');
  await B.send('setChoiceAnswers', { backupFailure: ['continue'] });
  assert.equal((await B.send('runMigration')).result.status, 'uploading');
  assert.equal((await choicesOf(B)).backupFailure.length, 2);
  await waitMigrationComplete(B, { timeoutMs: 30_000 });
  const after = await stateOf(B);
  assert.equal(after.hasBackupValue, false);
  assert.equal(typeof after.backupMeta?.skippedAt, 'number');
  await assertKept(B, bBefore, 'B');
});

// ════════════════════════════════ 19. 혼자 쓰기와 근거 표식 ════════════════════════════════
const K19 = keyOf('s19');
await scenario('19', '혼자 쓰기와 근거 표식: 스키마 2 저장소를 처음 실행하면 표식이 적히고, 키 없이 기록을 바꾸고 다시 열어도 Cloudflare와 Firestore 요청이 0회이며 모듈도 불러오지 않는다', ['s4bA', 's4bB', 's4bC'], {
  s4bA: has179({ logs: [logOf('solo-1'), logOf('solo-2', { timestamp: 1_700_000_001_000, updatedAt: 1_700_000_001_000 })] }),
  s4bB: has179({ syncKey: K19, logs: [logOf('b-1')] }),
}, async ({ adapter, fs, devices: [A, B, C] }) => {
  for (const device of [A, B, C]) assert.equal((await storageItems(device, [MARKER]))[MARKER], null, `${device.name}: 첫 실행 전에는 표식이 없다`);
  const [markA, markB, markC] = [(await A.send('bootApp')).marker, (await B.send('bootApp')).marker, (await C.send('bootApp')).marker];
  assert.deepEqual(markA.keys, [], '혼자 쓰던 기기의 표식');
  assert.deepEqual(markB.keys, [K19], '스키마 2(1.7.9) 기기에도 표식이 적히고 프로필 키가 담긴다(조기 반환 앞)');
  assert.deepEqual(markC.keys, [], '새로 설치한 기기의 표식');
  for (const m of [markA, markB, markC]) assert.equal(typeof m.checkedAt, 'number');

  // 키 없이 기록 추가·수정·삭제, 다시 열기
  const added = (await A.send('addLog', { log: { type: 'formula', amount: 70, timestamp: 1_700_000_005_000 } })).saved;
  assert.ok(added?.id);
  assert.equal((await A.send('updateLog', { log: { ...added, amount: 71 } })).ok, true);
  assert.equal((await A.send('deleteLog', { id: 'solo-1' })).ok, true);
  assert.equal((await A.send('runMigration')).skipped, true, '키가 없으면 이전 모듈을 부르지 않는다');
  assert.equal((await A.send('syncWithCloud')).success, false);
  await A.restart();
  assert.deepEqual((await A.send('bootApp')).marker, markA, '다시 열어도 표식을 다시 계산하지 않는다');
  await A.send('migratorReset');
  assert.equal((await A.send('runMigration')).skipped, true);
  await C.send('addLog', { log: { type: 'formula', amount: 10, timestamp: 1_700_000_006_000 } });
  assert.equal((await C.send('runMigration')).skipped, true);

  const finalIds = await idsOf(A);
  assert.deepEqual(finalIds.filter((id) => id !== added.id), ['solo-2'], '혼자 쓰기 기록은 추가·수정·삭제 결과 그대로다');
  assert.equal((await A.send('getLogs')).logs.find((l) => l.id === added.id).amount, 71);
  assert.equal(await adapter.requestCount(), 0, 'Cloudflare 요청이 나갔다');
  assert.equal(await fs.opCount(), 0, 'Firestore 요청이 나갔다');
  for (const device of [A, B, C]) {
    const loads = await device.send('moduleLoads');
    assert.deepEqual([loads.firestoreImportLoaded, loads.firebaseLoaded], [false, false], `${device.name}이 Firestore 모듈을 불러왔다 ${JSON.stringify(loads.loads)}`);
  }
});

// ════════════════════════════════ 20. 업로드 완료 판정 ════════════════════════════════
const K20a = keyOf('s20a');
const K20b = keyOf('s20b');
/** 7단계 완료 표시(d1UploadedAt)가 마지막 이어 가기 회차의 성공 사건 뒤에만 적히는지 표본으로 감시합니다. `afterId`보다 큰 번호의 첫 요청이 7단계입니다. */
const watchUploadMarking = (device, afterId) => {
  const violations = [];
  let stop = false;
  const task = track((async () => {
    while (!stop) {
      const st = await stateOf(device);
      if (typeof st.state.d1UploadedAt === 'number') {
        const events = (await device.send('runnerEvents')).events;
        const later = events.filter((e) => e.requestId > afterId);
        const parent = later.length ? Math.min(...later.map((e) => e.requestId)) : null;
        const finished = parent !== null && events.some((e) => e.type === 'succeeded' && e.requestId === parent && !e.result.continuing);
        if (!finished) violations.push(`마지막 이어 가기 회차 전에 d1UploadedAt이 적혔다(7단계 번호 ${parent})`);
      }
      await sleep(15);
    }
  })());
  return { violations, async finish() { stop = true; await task; } };
};
await scenario('20', '업로드 완료 판정: 7단계가 이어 가기 회차 여러 개에 걸치면 마지막 회차 뒤에만 d1UploadedAt이 적히고, 7단계 요청을 넣기 전에 시작한 회차의 사건으로는 적지 않는다', ['s4bA', 's4bB'], {
  s4bA: has179({ syncKey: K20a, logs: logsOf(3, 'loc', 4_000_000) }),
  s4bB: has179({ syncKey: K20b, logs: logsOf(3, 'locb', 4_000_000) }),
}, async ({ adapter, fs, devices: [A, B] }) => {
  await adapter.setLimits({ maxPushItems: 100 });
  await adapter.delay({ kind: 'push', hasPushItems: true }, 100); // 회차마다 올리기가 느려져 7단계가 여러 이어 가기 회차로 나뉜다
  await A.send('bootApp');
  await B.send('bootApp');

  // (1) 기록 2,400건 가족의 이전: 7단계가 이어 가기 회차 여러 개에 걸친다.
  await fs.seed(K20a, { members: ['legacy-X'], logs: logsOf(2400, 'fs', 1_000_000) });
  const aBefore = await idsOf(A);
  const watchA = watchUploadMarking(A, 0);
  assert.equal((await A.send('runMigration', {}, { timeoutMs: 90_000 })).result.status, 'uploading');
  const doneA = await waitMigrationComplete(A, { timeoutMs: 90_000 });
  await watchA.finish();
  assert.deepEqual(watchA.violations, []);
  const eventsA = (await A.send('runnerEvents')).events;
  const uploadId = eventsA[0].requestId;
  const roundsA = eventsA.filter((e) => e.type === 'succeeded');
  assert.ok(roundsA.length >= 3, `7단계가 이어 가기 회차 여러 개에 걸쳐야 한다(실제 ${roundsA.length}회)`);
  assert.ok(roundsA.every((e) => e.requestId === uploadId), '이어 가기 회차는 부모의 requestId를 물려받는다');
  assert.deepEqual(roundsA.slice(0, -1).map((e) => e.result.continuing), roundsA.slice(0, -1).map(() => true), '마지막 앞의 회차는 모두 continuing');
  assert.ok(!roundsA.at(-1).result.continuing, '마지막 회차는 continuing이 아니다');
  assert.ok(doneA.state.d1UploadedAt >= roundsA.at(-1).at, 'd1UploadedAt은 마지막 이어 가기 회차 뒤에 적힌다');
  const liveA = await d1Live(adapter, K20a);
  assert.equal(liveA.length, 2400 + 3, 'D1에 기록이 모두 올라 있다');
  assert.deepEqual(await idsOf(A), liveA);
  await assertKept(A, aBefore, 'A');

  // (2) 7단계 요청을 넣기 전에 시작한 평소 요청 R0의 성공 사건으로는 적지 않는다(D1은 이미 exists, 장부는 이미 있는 기기).
  await fs.seed(K20b, { members: ['legacy-X'], logs: logsOf(300, 'fsb', 1_000_000) });
  await adapter.ensureFamily(K20b);
  for (const l of logsOf(3, 'd1only', 3_000_000)) await adapter.injectLog(K20b, l);
  await B.send('setTiming', { requestTimeoutMs: 20_000 }); // 멈춘 D1 요청이 요청 상한(1초)에 걸려 죽지 않게
  for (let i = 0; i < 6; i += 1) { // 장부를 만들어 두어 R0가 이어 가기 없이 끝나게 한다(연결 회차는 관문을 거치지 않는다)
    const warm = await B.send('runnerRequest', { request: { syncKey: K20b, connecting: true }, timeoutMs: 30_000 });
    assert.equal(warm.success, true, warm.error);
    if (!warm.continuing) break;
  }
  assert.ok(!(await B.send('readLedger')).ledger?.full, '전제: 장부의 전체 모드가 끝났다');
  await B.send('runnerRequest', { request: { syncKey: K20b }, timeoutMs: 30_000 }); // 관문이 아직 막으므로 migrationPending
  await B.send('migratorReset'); // 앱을 다시 연다(메모리 d1Status 비움). 이후의 번호는 새로 시작한다.
  const idB = await clientIdOf(B);
  const bBefore = await idsOf(B);
  const fsGate = await fs.holdNext({ op: 'list', kind: 'logs' });
  const migrationB = track(B.send('runMigration', {}, { timeoutMs: 90_000 }));
  await fsGate.held;
  const mid = await stateOf(B);
  assert.equal(mid.d1Status, 'exists');
  assert.equal(mid.gate, 'proceed');
  await B.send('addLog', { log: { type: 'formula', amount: 8, timestamp: 1_700_000_200_000 } }); // R0가 올릴 것이 있어야 D1 요청이 나간다
  const d1Gate = await adapter.holdNext({ kind: 'sync', clientId: idB });
  const r0 = track(B.send('runnerRequest', { request: { syncKey: K20b }, timeoutMs: 30_000 }, { timeoutMs: 90_000 }));
  await d1Gate.held;
  await fsGate.release();
  await waitFor(async () => typeof (await stateOf(B)).state.mergedAt === 'number', { label: '병합 완료', timeoutMs: 30_000 });
  await sleep(200); // 7단계 요청이 R0 뒤 대기열에 들어간다
  assert.equal((await stateOf(B)).state.d1UploadedAt, undefined);
  const r0Id = (await B.send('runnerEvents')).events.find((e) => e.type === 'started').requestId;
  const watchB = watchUploadMarking(B, r0Id);
  await d1Gate.release();
  assert.equal((await r0).success, true, 'R0(7단계 전에 시작한 평소 요청)는 성공해야 한다');
  await migrationB;
  const doneB = await waitMigrationComplete(B, { timeoutMs: 90_000 });
  await watchB.finish();
  assert.deepEqual(watchB.violations, []);
  const eventsB = (await B.send('runnerEvents')).events;
  const r0Done = eventsB.find((e) => e.type === 'succeeded' && e.requestId === r0Id);
  assert.ok(r0Done && !r0Done.result.continuing, '전제: R0는 이어 가기 없이 성공했다(이 사건은 번호가 작아 걸러져야 한다)');
  const uploadIdB = Math.min(...eventsB.filter((e) => e.requestId > r0Id).map((e) => e.requestId));
  const lastB = eventsB.filter((e) => e.type === 'succeeded' && e.requestId === uploadIdB).at(-1);
  assert.ok(lastB && !lastB.result.continuing);
  assert.ok(r0Done.at <= lastB.at && doneB.state.d1UploadedAt >= lastB.at, 'd1UploadedAt은 R0가 아니라 7단계의 마지막 회차 뒤에 적힌다');
  const liveB = await d1Live(adapter, K20b);
  assert.equal(liveB.length, 300 + 3 + 3 + 1, 'D1에 기록이 모두 올라 있다');
  assert.deepEqual(await idsOf(B), liveB);
  await assertKept(B, bBefore, 'B');
});

// ════════════════════════════════ 21. 근거 있는 키로 다시 합류 ════════════════════════════════
const K21a = keyOf('s21a');
const K21b = keyOf('s21b');
await scenario('21', '근거 있는 키로 다시 합류: 옛 장부의 키로 표식이 적히고, 합류는 관문에 막히지 않으며 Firestore 기록을 읽고 전환기가 생긴다(D1 missing은 legacyJoin, exists는 2.4)', ['s4bA', 's4bC'], {
  s4bA: has179({ legacyLedgerKey: K21a, logs: logsOf(2, 'a-own', 5_000_000) }),
  s4bC: has179({ syncKey: K21b, logs: logsOf(2, 'c-own', 6_000_000) }),
}, async ({ adapter, fs, devices: [A, C] }) => {
  await fs.seed(K21a, { members: ['legacy-B'], logs: logsOf(5, 'fa', 2_000_000) });
  await fs.seed(K21b, { members: ['legacy-B'], logs: logsOf(5, 'fb', 3_000_000) });
  await adapter.ensureFamily(K21b); // 상대가 이미 옮긴 가족
  for (const l of logsOf(2, 'd1b', 4_000_000)) await adapter.injectLog(K21b, l);

  // (1) 프로필 키 없음, 옛 장부의 familyKey만 K → 표식에 K. D1 missing → legacyJoin.
  assert.deepEqual((await A.send('bootApp')).marker.keys, [K21a], '옛 장부의 familyKey가 표식에 적힌다');
  const aBefore = await idsOf(A);
  const joinedA = await A.send('join', { key: K21a });
  assert.equal(joinedA.outcome, 'joined', JSON.stringify(joinedA));
  const sA = await stateOf(A, K21a);
  assert.equal(sA.d1Status, 'exists', '합류 성공 직후 d1Status가 exists로 적힌다');
  assert.equal(sA.gate, 'proceed', '합류가 관문에 막히지 않는다');
  assert.equal(typeof sA.state.legacyJoinedAt, 'number');
  const doneA = await waitMigrationComplete(A, { syncKey: K21a, timeoutMs: 30_000 });
  assert.equal(doneA.state.mergeSource, 'ok', '근거 있는 합류는 1.8.0 합류(skipped)가 아니라 Firestore를 읽는다');
  assert.equal(typeof doneA.transition.seenFamilyChangedAt, 'number', '전환기가 생긴다');
  assert.equal((await A.send('getProfile')).profile.syncKey, K21a);
  const idsA = await idsOf(A);
  assert.ok(logsOf(5, 'fa', 2_000_000).every((l) => idsA.includes(l.id)), 'Firestore 기록이 합쳐졌다');
  assert.deepEqual(await d1Live(adapter, K21a), idsA);
  await assertKept(A, aBefore, 'A');

  // (2) 사용자가 연결을 해제했다가 다시 연결. D1 exists → 2.4.
  assert.deepEqual((await C.send('bootApp')).marker.keys, [K21b]);
  const cBefore = await idsOf(C);
  await C.send('setProfile', { patch: { syncKey: null } });
  assert.ok(!(await C.send('getProfile')).profile.syncKey, '전제: 연결이 해제됐다');
  const joinedC = await C.send('join', { key: K21b });
  assert.equal(joinedC.outcome, 'joined', JSON.stringify(joinedC));
  assert.equal((await stateOf(C, K21b)).d1Status, 'exists');
  const doneC = await waitMigrationComplete(C, { syncKey: K21b, timeoutMs: 30_000 });
  assert.equal(doneC.state.mergeSource, 'ok');
  assert.equal(typeof doneC.transition.seenFamilyChangedAt, 'number');
  const idsC = await idsOf(C);
  assert.ok(logsOf(5, 'fb', 3_000_000).every((l) => idsC.includes(l.id)) && idsC.includes('d1b-0000'), 'Firestore와 D1 기록이 모두 합쳐졌다');
  assert.deepEqual(await d1Live(adapter, K21b), idsC);
  await assertKept(C, cBefore, 'C');
});

// ════════════════════════════════ 22. legacyJoin 끊김 ════════════════════════════════
const K22a = keyOf('s22a');
const K22b = keyOf('s22b');
await scenario('22', 'legacyJoin 끊김: D1 생성 직후 연결 회차 실패 뒤 재합류, 키 저장 직후 강제 종료 뒤 재시작 모두 Firestore를 읽어 합치고 전환기가 생긴다(skipped 아님)', ['s4bA', 's4bB'], {}, async ({ adapter, fs, devices: [A, B] }) => {
  await fs.seed(K22a, { members: ['legacy-X'], logs: logsOf(4, 'fa', 2_000_000) });
  await fs.seed(K22b, { members: ['legacy-X'], logs: logsOf(4, 'fb', 3_000_000) });
  await A.send('bootApp');
  await B.send('bootApp');

  // (a) 연결 회차의 연결 요청이 셋째(404, legacyJoin의 D1 생성, 다시 넣은 연결 회차)인데 그 셋째를 503으로 실패시킨다.
  await A.send('addLog', { log: { type: 'formula', amount: 1, timestamp: 1_700_000_000_500 } });
  const aBefore = await idsOf(A);
  await adapter.failHttp({ status: 503, match: { kind: 'connect' }, skip: 2, times: 1 });
  const first = await A.send('join', { key: K22a });
  assert.equal(first.outcome, 'failed', JSON.stringify(first));
  assert.equal((await adapter.family(K22a)).exists, true, '전제: legacyJoin이 D1 가족을 만들었다');
  const s1 = await stateOf(A, K22a);
  assert.equal(typeof s1.state.legacyJoinedAt, 'number', 'D1 가족을 만들기 전에 legacyJoinedAt이 적혀 있다');
  assert.equal(s1.state.mergedAt, undefined);
  assert.ok(!(await A.send('getProfile')).profile.syncKey, '전제: 키가 저장되지 않았다');
  assert.deepEqual(await idsOf(A), aBefore, '실패한 합류의 Firestore 기록이 기기에 섞이지 않았다');
  const second = await A.send('join', { key: K22a });
  assert.equal(second.outcome, 'joined', JSON.stringify(second));
  const doneA = await waitMigrationComplete(A, { syncKey: K22a, timeoutMs: 30_000 });
  assert.equal(doneA.state.mergeSource, 'ok', 'skipped로 적히면 안 된다');
  assert.equal(typeof doneA.transition.seenFamilyChangedAt, 'number');
  const idsAfterA = await idsOf(A);
  assert.ok(logsOf(4, 'fa', 2_000_000).every((l) => (idsAfterA).includes(l.id)), 'Firestore 기록이 합쳐졌다');
  assert.deepEqual(await d1Live(adapter, K22a), await idsOf(A));
  await assertKept(A, aBefore, 'A');

  // (b) 키 저장 직후(프로필 쓰기 직후) 강제 종료 → 다시 띄움
  await B.send('injectStorageFault', { mode: 'exit', nth: 1, keys: ['@baby_profile'] });
  await track(B.send('join', { key: K22b })).catch(() => undefined);
  await waitFor(() => !B.alive, { label: 'B의 강제 종료' });
  await B.restart();
  await B.send('bootApp');
  assert.equal((await B.send('getProfile')).profile.syncKey, K22b, '전제: 키 저장 직후에 종료됐다');
  const s2 = await stateOf(B, K22b);
  assert.equal(typeof s2.state.legacyJoinedAt, 'number');
  assert.equal(s2.state.mergedAt, undefined);
  assert.equal((await B.send('runMigration')).result.status, 'uploading');
  const doneB = await waitMigrationComplete(B, { syncKey: K22b, timeoutMs: 30_000 });
  assert.equal(doneB.state.mergeSource, 'ok', 'skipped로 적히면 안 된다');
  assert.equal(typeof doneB.transition.seenFamilyChangedAt, 'number');
  assert.ok((await idsOf(B)).includes('fb-0000'));
  assert.deepEqual(await d1Live(adapter, K22b), await idsOf(B));
});

// ════════════════════════════════ 23. 오프라인 시작 뒤 재개 ════════════════════════════════
const K23 = keyOf('s23');
await scenario('23', '오프라인 시작 뒤 재개: 관문 paused에서 평소 D1 요청 0회, 경고창 없음, 네트워크 복귀 뒤 다음 저장에서 재시작 없이 d1Status가 정해지고 이전이 이어진다', ['s4bA'], {
  s4bA: has179({ syncKey: K23, logs: logsOf(2, 'loc', 4_000_000) }),
}, async ({ adapter, fs, devices: [A] }) => {
  await fs.seed(K23, { members: ['legacy-X'], logs: logsOf(8, 'fs', 2_000_000) });
  await A.send('bootApp');
  const before = await idsOf(A);

  // 병합까지 끝나고 7단계가 끝나지 않은 상태를 실제로 만든다(7단계의 D1 요청을 503으로 실패시킴).
  await adapter.failHttp({ status: 503, match: { kind: 'sync' }, times: 'always' });
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitFor(async () => (await A.send('runnerEvents')).events.some((e) => e.type === 'failed'), { label: '7단계 실패' });
  const s0 = await stateOf(A);
  assert.equal(s0.state.mergeSource, 'ok');
  assert.equal(typeof s0.state.mergedAt, 'number');
  assert.equal(s0.state.d1UploadedAt, undefined);
  await adapter.clearFaults();

  // 앱을 다시 열고(메모리 d1Status 비움) 오프라인으로 시작
  await A.send('migratorReset');
  await adapter.setOffline(true);
  const mark = await adapter.requestCount();
  const paused = await stateOf(A);
  assert.equal(paused.gate, 'paused');
  assert.equal(paused.d1Status, null);
  const refresh = await A.send('runnerRequest', { request: { syncKey: K23 }, timeoutMs: 20_000 });
  assert.equal(refresh.success, false);
  assert.equal(refresh.migrationPending, true, '관문이 이전 준비 중으로 막았다');
  assert.equal(refresh.error, undefined, '오류로 표시하지 않는다');
  assert.equal(shouldAlertOnRefresh(refresh), false, '당겨서 새로고침은 migrationPending에 경고창을 띄우지 않는다');
  assert.equal(shouldAlertOnRefresh({ success: false, error: 'x' }), true, '전제: 진짜 실패에는 경고창이 뜬다');
  assert.equal(shouldStartPolling(paused.gate), false);
  assert.equal(shouldCheckDeletionStatus(paused.gate), false);
  await sleep(300);
  const during = (await adapter.requests(mark)).filter((r) => ['push', 'pull', 'token'].includes(r.kind));
  assert.equal(during.length, 0, `관문이 막은 동안 평소 D1 요청(push/pull/token)이 나갔다 ${during.length}건`);
  assert.equal((await stateOf(A)).d1Status, null, '오프라인이라 d1Status는 아직 모른다');

  // 네트워크 복귀 → 재시작 없이 다음 저장(+동기화 요청)에서 관문이 ensure를 다시 불러 이어진다.
  await adapter.setOffline(false);
  await A.send('addLog', { log: { type: 'formula', amount: 12, timestamp: 1_700_000_009_000 } });
  await A.send('runnerRequest', { request: { syncKey: K23 }, timeoutMs: 20_000 });
  await waitFor(async () => (await stateOf(A)).d1Status === 'exists', { label: '재시작 없이 d1Status 결정' });
  const done = await waitMigrationComplete(A, { timeoutMs: 30_000 });
  assert.equal(done.gate, 'proceed');
  assert.equal(shouldStartPolling(done.gate), true);
  assert.equal(shouldCheckDeletionStatus(done.gate), true);
  const ok = await A.send('runnerRequest', { request: { syncKey: K23 }, timeoutMs: 20_000 });
  assert.equal(ok.success, true, ok.error);
  assert.deepEqual(await d1Live(adapter, K23), await idsOf(A));
  await assertKept(A, before, 'A');
});

// ════════════════════════════════ 24. 삭제에 따르기의 경쟁과 오래된 선택 ════════════════════════════════
const K24a = keyOf('s24a');
const K24b = keyOf('s24b');
await scenario('24', '삭제에 따르기의 경쟁: (a) 상대가 취소하면 서버에 보내지 않고 2.4로, (b) 다른 기기가 이어받아 409면 연결을 해제하지 않고 같은 화면이 반복되지 않는다, 서버는 한 문장으로 판정', ['s4bA', 's4bB', 's4bC'], {
  s4bA: has179({ syncKey: K24a, logs: logsOf(2, 'a-own', 5_000_000) }),
  s4bB: has179({ syncKey: K24b, logs: logsOf(2, 'b-own', 6_000_000) }),
}, async ({ server, adapter, fs, devices: [A, B, C] }) => {
  const pda = Date.now() + 3 * 24 * HOUR;
  await fs.seed(K24a, { members: ['legacy-B'], logs: logsOf(4, 'fa', 2_000_000), family: { pendingDeletionAt: pda } });
  await fs.seed(K24b, { members: ['legacy-B'], logs: logsOf(4, 'fb', 3_000_000), family: { pendingDeletionAt: pda } });
  await A.send('bootApp');
  await B.send('bootApp');
  const aBefore = await idsOf(A);
  const bBefore = await idsOf(B);

  // (a) 선택 화면이 떠 있는 사이 상대(1.7.9)가 예약을 취소
  await A.send('setChoiceAnswers', { legacyDeletion: [{ hold: true }] });
  const runA = track(A.send('runMigration', {}, { timeoutMs: 60_000 }));
  const promptA = await pendingChoice(A, 'legacyDeletion');
  assert.equal(promptA.context, 'missing');
  assert.equal(promptA.pendingDeletionAt, pda);
  assert.deepEqual(promptA.options, ['cancelRequest', 'followDeletion', 'later']);
  const markA = await adapter.requestCount();
  await fs.legacy179Cancel(K24a, { uid: 'legacy-B' });
  await A.send('answerChoice', { kind: 'legacyDeletion', answer: 'followDeletion' });
  const resA = await runA;
  const reqsA = await adapter.requests(markA);
  assert.equal(reqsA.filter((r) => r.kind === 'other').length, 0, '취소된 뒤에는 서버에 삭제 요청(delete/schedule)을 보내지 않는다');
  assert.ok((await noticeCodes(A)).includes('deletionCancelledElsewhere'));
  assert.equal(resA.result.status, 'uploading', '2.4로 돌아가 이어받는다');
  const doneA = await waitMigrationComplete(A, { timeoutMs: 30_000 });
  assert.equal(doneA.state.mergeSource, 'ok');
  assert.equal((await A.send('getProfile')).profile.syncKey, K24a, '연결이 유지된다');
  const famA = await adapter.family(K24a);
  assert.deepEqual([famA.exists, famA.deleted], [true, false]);
  assert.equal((await choicesOf(A)).legacyDeletion.length, 1);
  await assertKept(A, aBefore, 'A');

  // (b) 선택 화면이 떠 있는 사이 다른 기기가 이어받아 D1 가족을 만든다 → 409
  await B.send('setChoiceAnswers', { legacyDeletion: [{ hold: true }] });
  const runB = track(B.send('runMigration', {}, { timeoutMs: 60_000 }));
  const promptB = await pendingChoice(B, 'legacyDeletion');
  assert.equal(promptB.context, 'missing');
  const created = await C.send('runnerRequest', { request: { syncKey: K24b, allowFamilyCreation: true, connecting: true }, timeoutMs: 20_000 });
  assert.equal(created.success, true, created.error);
  const markB = await adapter.requestCount();
  await B.send('answerChoice', { kind: 'legacyDeletion', answer: 'followDeletion' });
  const resB = await runB;
  const reqsB = await adapter.requests(markB);
  assert.ok(reqsB.some((r) => r.path === '/api/family/delete' && r.status === 409), `서버가 409를 돌려주지 않았다 ${JSON.stringify(reqsB.map((r) => [r.path, r.status]))}`);
  assert.equal((await B.send('getProfile')).profile.syncKey, K24b, '409에는 연결을 해제하지 않는다');
  const famB = await adapter.family(K24b);
  assert.deepEqual([famB.exists, famB.deleted], [true, false], 'deleted_families가 비어 있고 살아 있는 가족이 그대로다');
  assert.ok((await noticeCodes(B)).includes('alreadyMigrated'));
  const sB = await stateOf(B);
  assert.equal(sB.state.promptedPendingDeletionAt, pda, '409 뒤 이 화면의 예약 값을 적는다');
  assert.equal(typeof sB.state.legacyDeletionNoticeAt, 'number');
  assert.equal(resB.result.status, 'uploading', '다시 실행한 2.4는 exists + pending_deletion이어도 같은 화면을 다시 띄우지 않고 업로드로 간다');
  assert.equal((await choicesOf(B)).legacyDeletion.length, 1, '같은 선택 화면이 반복됐다');
  await assertKept(B, bBefore, 'B');

  // (c) 서버 단위: 한 문장 판정. 없으면 기록(ok)·다시 하면 410, 가족이 있으면 409(기록 안 붙음), 생성과 겹쳐도 살아 있는 가족에 기록이 붙지 않는다.
  const [S1, S2, S3, S4] = ['s24c1', 's24c2', 's24c3', 's24c4'].map(keyOf);
  const r1 = await fetchDelete(server, S1);
  assert.equal(r1.status, 200);
  assert.equal((await fetchDelete(server, S1)).status, 410);
  assert.deepEqual([(await adapter.family(S1)).exists, (await adapter.family(S1)).deleted], [false, true]);
  await adapter.ensureFamily(S2);
  assert.equal((await fetchDelete(server, S2)).status, 409);
  assert.deepEqual([(await adapter.family(S2)).exists, (await adapter.family(S2)).deleted], [true, false]);
  // 삭제 요청이 서버 앞에서 멈춘 사이 가족이 생긴다 → 409, 가족은 그대로
  const gate4 = await adapter.holdNext({ kind: 'other' });
  const held4 = track(fetchDelete(server, S4));
  await gate4.held;
  await adapter.ensureFamily(S4);
  await gate4.release();
  assert.equal((await held4).status, 409);
  assert.deepEqual([(await adapter.family(S4)).exists, (await adapter.family(S4)).deleted], [true, false]);
  // 가족 생성(connect)이 쓰기 배치 직전에 멈춘 사이 삭제 기록이 먼저 확정된다 → 생성은 410, 살아 있는 가족과 삭제 기록이 함께 있는 일은 없다
  const gate3 = await adapter.holdNext({ kind: 'connect', batch: 'write' });
  const connecting = track(fetch(`${server.url}/api/family/connect`, {
    method: 'POST', headers: { Authorization: `Bearer ${S3}`, 'X-Client-Id': 's4b-direct', 'Content-Type': 'application/json' }, body: JSON.stringify({ allowCreate: true }),
  }).then((res) => res.status));
  await gate3.held;
  assert.equal((await fetchDelete(server, S3)).status, 200);
  await gate3.release();
  assert.equal(await connecting, 410);
  const fam3 = await adapter.family(S3);
  assert.deepEqual([fam3.exists, fam3.deleted], [false, true]);
  // 코드 검사(약함): 문장 사이에 끼어들 수단이 하네스에 없으므로, legacyDeletion 분기가 가족을 미리 읽지 않고 한 문장(WHERE NOT EXISTS)으로 쓰는지 소스로 확인한다.
  const src = readFileSync(path.join(HARNESS_DIR, '../../server/src/index.ts'), 'utf8');
  const blockStart = src.indexOf('body.legacyDeletion === true');
  const block = src.slice(blockStart, src.indexOf('SELECT deletion_ready_at FROM families', blockStart));
  const insertAt = block.indexOf('INSERT OR IGNORE INTO deleted_families');
  assert.ok(insertAt > 0, 'legacyDeletion 분기를 찾지 못했다');
  assert.ok(!/FROM families/.test(block.slice(0, insertAt)), 'legacyDeletion이 기록 앞에서 가족 행을 따로 읽는다(두 문장)');
  assert.ok(/INSERT OR IGNORE INTO deleted_families[\s\S]*?WHERE NOT EXISTS \(SELECT 1 FROM families WHERE id = \?1\)/.test(block), '삭제 기록 문장에 WHERE NOT EXISTS(families)가 없다');
});

// ════════════════════════════════ 26. 대문자 섞인 키 ════════════════════════════════
const K26 = 'Ab26CdEfGhIjKlMnOpQrStUvWxYz0123';
await scenario('26', '대문자 섞인 키: Firestore는 원래 키의 해시로, D1은 소문자 키의 해시로 찾고 기록이 모두 옮겨진다', ['s4bA'], {
  s4bA: has179({ syncKey: K26, logs: logsOf(2, 'loc', 4_000_000) }),
}, async ({ adapter, fs, devices: [A] }) => {
  assert.ok(K26 !== K26.toLowerCase() && /^[A-Za-z0-9_-]{16,64}$/.test(K26));
  await fs.seed(K26, { members: ['legacy-X'], logs: logsOf(7, 'fs', 2_000_000) });
  await A.send('bootApp');
  const before = await idsOf(A);
  const opMark = await fs.opCount();
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  const done = await waitMigrationComplete(A, { timeoutMs: 30_000 });
  assert.equal(done.state.mergeSource, 'ok');
  const lowerId = createHash('sha256').update(`babycheck:family:v2:${K26.toLowerCase()}`).digest('hex');
  const exactId = fs.familyId(K26);
  assert.notEqual(exactId, lowerId);
  const paths = (await fs.ops(opMark)).map((o) => o.path || '').filter(Boolean);
  assert.ok(paths.some((p) => p.includes(exactId)), 'Firestore는 원래 키의 해시로 읽었다');
  assert.ok(!paths.some((p) => p.includes(lowerId)), 'Firestore를 소문자 키의 해시로 읽었다');
  const fam = await adapter.family(K26);
  assert.equal(fam.exists, true, 'D1 가족이 생겼다');
  assert.deepEqual((await adapter.family(K26.toLowerCase())).exists, true, 'D1은 소문자 키 기준(대소문자 상관없이 같은 가족)');
  assert.equal(fam.members.length >= 1, true);
  const expected = [...before, ...logsOf(7, 'fs', 2_000_000).map((l) => l.id)].sort();
  assert.deepEqual(await d1Live(adapter, K26), expected, '기록이 모두 옮겨졌다');
  assert.deepEqual(await idsOf(A), expected);
  assert.equal((await fs.stats(opMark)).denied, 0);
});

// ════════════════════════════════ 27. 형식이 깨진 Firestore 기록 ════════════════════════════════
const K27 = keyOf('s27');
await scenario('27', '형식이 깨진 Firestore 기록: payload.id 불일치, timestamp 없음 등이 섞여도 나머지가 합쳐지고 기기 저장소가 정상으로 읽힌다', ['s4bA'], {
  s4bA: has179({ syncKey: K27, logs: logsOf(2, 'loc', 4_000_000) }),
}, async ({ adapter, fs, devices: [A] }) => {
  const base = `families/${fs.familyId(K27)}/logs`;
  const doc = (id, payload, extra = {}) => ({ path: `${base}/${id}`, data: { payload, deleted: false, updatedAt: { __ts: Date.now() }, updatedBy: 'seed', ...extra } });
  const good = logsOf(6, 'good', 2_000_000);
  await fs.seed(K27, {
    members: ['legacy-X'], logs: good,
    docs: [
      doc('bad-id-doc', { id: 'mismatch-payload-id', type: 'formula', timestamp: 5, updatedAt: 5 }),
      doc('bad-no-ts', { id: 'bad-no-ts', type: 'formula' }),
      doc('bad-str-ts', { id: 'bad-str-ts', type: 'formula', timestamp: 'abc' }),
      doc('bad-type', { id: 'bad-type', type: 7, timestamp: 9 }),
      { path: `${base}/bad-no-payload`, data: { deleted: false, updatedAt: { __ts: Date.now() }, updatedBy: 'seed' } },
    ],
  });
  await A.send('bootApp');
  const before = await idsOf(A);
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  const done = await waitMigrationComplete(A, { timeoutMs: 30_000 });
  assert.equal(done.state.mergeSource, 'ok');
  assert.match(done.state.lastError || '', /5건/, '건너뛴 기록의 개수가 lastError에 남는다');
  const ids = await idsOf(A);
  assert.deepEqual(ids, [...before, ...good.map((l) => l.id)].sort(), '정상 기록만 합쳐졌다');
  for (const bad of ['mismatch-payload-id', 'bad-id-doc', 'bad-no-ts', 'bad-str-ts', 'bad-type', 'bad-no-payload']) assert.ok(!ids.includes(bad), `깨진 기록 ${bad}이 기기에 들어왔다`);
  // 기기 저장소가 정상으로 읽힌다: 읽기와 쓰기가 모두 되고, 프로필도 읽힌다.
  assert.equal((await A.send('peekLogs')).logs.length, ids.length);
  assert.ok((await A.send('addLog', { log: { type: 'formula', amount: 5, timestamp: 1_700_000_090_000 } })).saved);
  assert.equal((await A.send('getProfile')).profile.syncKey, K27);
  assert.deepEqual((await d1Live(adapter, K27)).filter((id) => !id.startsWith('s4b')).length, ids.length, 'D1에도 정상 기록만 오른다(새 기록 하나 전)');
  await assertKept(A, before, 'A');
});

// ════════════════════════════════ 28. 운영자 정리 전 점검 스크립트 ════════════════════════════════
const K28a = keyOf('s28a');
const K28b = keyOf('s28b');
const K28c = keyOf('s28c');
await scenario('28', '운영자 정리 전 점검: Firestore에만 있는 기록·더 새 수정본·삭제 표식은 실패, D1에 오른 뒤 통과, deleted_families는 deleted, 키 없는 가족은 unpaired', ['s4bA'], {
  s4bA: has179({ syncKey: K28a, logs: logsOf(2, 'loc', 4_000_000) }),
}, async ({ adapter, fs, devices: [A] }) => {
  await fs.seed(K28a, { members: ['legacy-B'], logs: logsOf(6, 'f', 2_000_000) });
  await fs.seed(K28b, { members: ['legacy-B'], logs: logsOf(2, 'g', 2_000_000) });
  await fs.seed(K28c, { members: ['legacy-B'], logs: logsOf(2, 'h', 2_000_000) });
  await adapter.markGone(K28b);
  // 실제 서버 프로세스의 D1(어댑터의 state 조회)과 가짜 Firestore(snapshot)를 compare.mjs의 입력 형식으로 바꾼다.
  const known = [K28a, K28b, K28c];
  const fsIdToKey = new Map();
  const d1IdToKey = new Map();
  for (const k of known) { fsIdToKey.set(await cleanupFirestoreId(k), k); d1IdToKey.set(await d1FamilyId(k), k); }
  const source = {
    firestoreFamilyId: cleanupFirestoreId,
    d1FamilyId,
    listFirestoreFamilyIds: async () => [...fsIdToKey.keys()].sort(),
    readFirestoreLogs: async (id) => {
      const snap = await fs.snapshot(fsIdToKey.get(id));
      return [
        ...snap.live.map(([logId, payload]) => ({ id: logId, deleted: false, updatedAt: payload.updatedAt || payload.timestamp || 0 })),
        ...snap.deleted.map((logId) => ({ id: logId, deleted: true, updatedAt: 0 })),
      ];
    },
    isD1FamilyDeleted: async (id) => (await adapter.family(d1IdToKey.get(id))).deleted,
    readD1Rows: async (id) => (await adapter.logs(d1IdToKey.get(id))).rows.map((r) => ({ id: r.id, deleted: r.deletedAt !== null, clientUpdatedAt: r.clientUpdatedAt })),
  };
  const run = () => runCleanupCheck({ keys: [K28a, K28b], source });
  const statusOf = (report, key) => report.families.find((f) => fsIdToKey.get(f.firestoreFamilyId) === key);
  const expectBase = (report) => {
    assert.equal(statusOf(report, K28b).status, 'deleted', 'deleted_families 가족은 deleted로 따로 보고하고 실패로 세지 않는다');
    assert.equal(statusOf(report, K28c).status, 'unpaired', '키를 주지 않은 가족은 unpaired로 실패로 세지 않는다');
  };
  const syncUp = async () => {
    assert.equal((await A.send('transitionTick', { force: true })).status, 'merged');
    const res = await A.send('runnerRequest', { request: { syncKey: K28a }, timeoutMs: 20_000 });
    assert.equal(res.success, true, res.error);
  };

  await A.send('bootApp');
  const before = await idsOf(A);
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(A, { timeoutMs: 30_000 });
  let report = await run();
  assert.equal(report.failedCount, 0, JSON.stringify(report));
  assert.equal(statusOf(report, K28a).status, 'ok', '이전 직후에는 통과한다');
  expectBase(report);

  // (1) Firestore에만 있는 기록 하나 → 실패, D1에 오른 뒤 → 통과
  await fs.legacy179Write(K28a, { uid: 'legacy-B', logs: [logOf('only-fs', { timestamp: 2_500_000, updatedAt: 2_500_000 })] });
  report = await run();
  assert.equal(report.failedCount, 1);
  assert.deepEqual(statusOf(report, K28a).diff, { missing: ['only-fs'], staleUpdates: [], tombstoneMissing: [] });
  expectBase(report);
  await syncUp();
  report = await run();
  assert.equal(report.failedCount, 0, JSON.stringify(report));

  // (2) Firestore에만 더 새 수정본(payload.updatedAt > D1 client_updated_at) → 실패, D1에 오른 뒤 통과
  await fs.legacy179Write(K28a, { uid: 'legacy-B', logs: [logOf('f-0000', { timestamp: 2_000_000, updatedAt: 9_000_000, amount: 123 })] });
  report = await run();
  assert.equal(report.failedCount, 1);
  assert.deepEqual(statusOf(report, K28a).diff, { missing: [], staleUpdates: ['f-0000'], tombstoneMissing: [] });
  await syncUp();
  report = await run();
  assert.equal(report.failedCount, 0, JSON.stringify(report));

  // (3) Firestore의 삭제 표식이 D1에 없으면(살아 있음) 실패, D1에 삭제 표식이 오른 뒤 통과
  await fs.legacy179Write(K28a, { uid: 'legacy-B', deleteIds: ['f-0001'] });
  report = await run();
  assert.equal(report.failedCount, 1);
  assert.deepEqual(statusOf(report, K28a).diff, { missing: [], staleUpdates: [], tombstoneMissing: ['f-0001'] });
  await syncUp();
  report = await run();
  assert.equal(report.failedCount, 0, JSON.stringify(report));
  expectBase(report);
  await assertKept(A, before, 'A', ['f-0001']);
});

// ════════════════════════════════ 29. 회원 문서만 남은 가족 ════════════════════════════════
const K29a = keyOf('s29a');
const K29b = keyOf('s29b');
await scenario('29', '회원 문서만 남은 가족: absent 안내만 보이고 연결이 유지되며 이어받지 않는다(간격 뒤 재시도). 병합 뒤 다시 읽기의 absent는 absent 행, 거부는 2.5로 가고 이어받지 않는다', ['s4bA', 's4bB'], {
  s4bA: has179({ syncKey: K29a, logs: logsOf(2, 'a-own', 5_000_000) }),
  s4bB: has179({ syncKey: K29b, logs: logsOf(2, 'b-own', 6_000_000) }),
}, async ({ harness, adapter, fs, devices: [A, B] }) => {
  const absentMessage = (await A.send('migrationMessages')).messages.absent;
  await A.send('bootApp');
  await B.send('bootApp');
  const aBefore = await idsOf(A);
  const bBefore = await idsOf(B);

  // (1) 이 기기의 회원 문서는 있고 가족 문서는 없다. D1 missing.
  await A.send('firestoreUid', { uid: 'member-29a' });
  await fs.seed(K29a, { family: null, members: ['member-29a'] });
  const r1 = await A.send('runMigration');
  assert.equal(r1.result.status, 'firestore_absent');
  assert.equal(r1.result.message, absentMessage);
  const s1 = await stateOf(A);
  assert.equal(s1.state.lastError, absentMessage);
  assert.equal(typeof s1.state.nextFirestoreAttemptAt, 'number', '실패 간격이 적혔다');
  assert.equal(s1.state.mergeSource, undefined);
  assert.equal((await A.send('getProfile')).profile.syncKey, K29a, '연결이 유지된다');
  const fam = await adapter.family(K29a);
  assert.deepEqual([fam.exists, fam.deleted], [false, false], '이어받지 않았다');
  assert.deepEqual((await choicesOf(A)).notices.map((n) => [n.level, n.code, n.message]), [['error', 'firestore_absent', absentMessage]], '안내는 absent 문구 하나뿐');
  // 간격 안에는 Firestore를 다시 읽지 않고(waiting), 간격 뒤에는 다시 시도해 가족 문서가 생겼으면 이어받는다.
  const opMark = await fs.opCount();
  assert.equal((await A.send('runMigration')).result.status, 'waiting');
  assert.equal(await fs.opCount(), opMark, '간격 안에 Firestore를 읽었다');
  await fs.seed(K29a, { members: ['member-29a', 'legacy-B'], logs: logsOf(3, 'fa', 2_000_000) });
  await harness.advanceClocks(31 * MIN);
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(A, { timeoutMs: 30_000 });
  assert.equal((await adapter.family(K29a)).exists, true);
  await assertKept(A, aBefore, 'A');

  // (2) 병합까지 끝났고 D1 이어받기가 끊긴 뒤(missing + mergeSource ok)의 다시 읽기
  await fs.seed(K29b, { members: ['legacy-B'], logs: logsOf(3, 'fb', 3_000_000) });
  await adapter.failHttp({ status: 503, match: { kind: 'connect' }, skip: 1, times: 1 }); // 첫 확인(404)은 통과, 이어받기 연결만 실패
  const r2 = await B.send('runMigration');
  assert.equal(r2.result.status, 'd1_error', JSON.stringify(r2));
  const s2 = await stateOf(B);
  assert.equal(s2.state.mergeSource, 'ok');
  assert.equal(s2.d1Status, 'missing');
  const familyPath = `families/${fs.familyId(K29b)}`;
  const savedFamily = await fs.getDoc(familyPath);
  await fs.removeDoc(familyPath); // 회원 문서는 남고 가족 문서가 사라진다
  const r3 = await B.send('runMigration');
  assert.equal(r3.result.status, 'firestore_absent', `가족 문서 없음은 absent 행으로 간다 ${JSON.stringify(r3)}`);
  assert.equal((await adapter.family(K29b)).exists, false);
  await fs.putDoc(familyPath, savedFamily);
  await fs.fail({ match: { op: 'get', kind: 'family' }, code: 'permission-denied', times: 1 });
  const r4 = await B.send('runMigration');
  assert.equal(r4.result.status, 'firestore_denied', `거부는 2.5로 간다 ${JSON.stringify(r4)}`);
  assert.equal((await adapter.family(K29b)).exists, false, '거부를 이어받기로 보면 안 된다');
  const s4 = await stateOf(B);
  assert.equal(typeof s4.state.blockedSince, 'number');
  assert.equal((await B.send('getProfile')).profile.syncKey, K29b, '연결이 유지된다');
  await fs.clearFaults();
  assert.equal((await B.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(B, { timeoutMs: 30_000 });
  assert.equal((await adapter.family(K29b)).exists, true, '가족 문서가 돌아오면 이어받는다');
  await assertKept(B, bBefore, 'B');
});

// ════════════════════════════════ 30. 병합 전 업로드 ════════════════════════════════
const K30 = keyOf('s30');
await scenario('30', '병합 전 업로드: exists + Firestore 실패면 d1UploadedAt만 적히고 다시 열어도 forceFullRead가 반복되지 않으며, 뒤에 병합하면 d1UploadedAt이 지워지고 7단계가 한 번 더 돈 뒤에만 완료된다', ['s4bA'], {
  s4bA: has179({ syncKey: K30, logs: logsOf(3, 'loc', 4_000_000) }),
}, async ({ harness, adapter, fs, devices: [A] }) => {
  const idA = await clientIdOf(A);
  await fs.seed(K30, { members: ['legacy-X'], logs: logsOf(30, 'fa', 2_000_000) });
  await adapter.ensureFamily(K30);
  for (const l of logsOf(3, 'd1only', 3_000_000)) await adapter.injectLog(K30, l);
  await A.send('bootApp');
  await A.send('setTiming', { requestTimeoutMs: 8_000 });
  await A.send('runnerReset', { timeoutMs: 20_000 });
  const mark = await adapter.requestCount();
  const before = await idsOf(A);
  const syncRequests = async () => (await adapter.requests(mark)).filter((r) => r.clientId === idA && (r.kind === 'push' || r.kind === 'pull'));

  await fs.offline(true);
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  const s1 = await waitFor(async () => { const s = await stateOf(A); return typeof s.state.d1UploadedAt === 'number' ? s : null; }, { label: '병합 전 업로드 완료', timeoutMs: 20_000 });
  assert.equal(s1.state.mergeSource, undefined);
  assert.equal(s1.state.mergedAt, undefined);
  assert.equal(s1.complete, false, 'd1UploadedAt만 적혔고 이전은 아직 완료가 아니다');
  const full1 = (await syncRequests()).filter(isFullPull).length;
  const total1 = (await syncRequests()).length;
  assert.ok(full1 >= 1, '전제: 7단계(forceFullRead)가 한 번은 돌았다');
  assert.ok(!(await idsOf(A)).some((id) => id.startsWith('fa-')), '병합 전이라 Firestore 기록이 기기에 없다');

  // 앱을 다시 열어도(두 번) Firestore가 계속 실패하면 7단계가 반복되지 않는다.
  for (let i = 0; i < 2; i += 1) {
    await A.send('migratorReset');
    await harness.advanceClocks(3 * HOUR);
    const again = await A.send('runMigration');
    assert.equal(again.result.status, 'waiting', JSON.stringify(again));
    await sleep(300);
    assert.equal((await syncRequests()).length, total1, `다시 열었을 때 D1 동기화 요청이 또 나갔다(${i + 1}번째)`);
  }

  // Firestore가 살아나면 병합하고, d1UploadedAt이 지워진 채 7단계가 한 번 더 돈다. 그 7단계를 D1 앞에서 멈추고 확인한다.
  await fs.offline(false);
  await harness.advanceClocks(6 * HOUR);
  const gate = await adapter.holdNext({ kind: 'sync', clientId: idA });
  const pending = track(A.send('runMigration', {}, { timeoutMs: 60_000 }));
  await gate.held;
  const mid = await stateOf(A);
  assert.equal(mid.state.mergeSource, 'ok');
  assert.equal(typeof mid.state.mergedAt, 'number');
  assert.equal(mid.state.d1UploadedAt, undefined, '병합 성공 때 d1UploadedAt을 지우지 않았다');
  assert.equal(mid.complete, false);
  assert.ok(!(await d1Live(adapter, K30)).some((id) => id.startsWith('fa-')), '전제: 병합한 기록이 아직 D1에 없다');
  await gate.release();
  await pending;
  const done = await waitMigrationComplete(A, { timeoutMs: 30_000 });
  assert.ok((await d1Live(adapter, K30)).filter((id) => id.startsWith('fa-')).length === 30, '병합한 기록이 D1에 오른 뒤에 완료다');
  assert.ok((await syncRequests()).filter(isFullPull).length >= full1 + 1, '병합 뒤 7단계(전체 모드)가 한 번 더 돌았다');
  assert.equal(done.state.mergeSource, 'ok');
  await assertKept(A, before, 'A');
});

// ════════════════════════════════ 31. deleted 뒤 연결 해제 ════════════════════════════════
const K31 = keyOf('s31');
await scenario('31', 'deleted 뒤 연결 해제: 근거 있는 기기를 시작했는데 D1이 410이면 아무것도 하지 않아도 이전 모듈이 넣은 평소 요청 하나로 연결이 해제되고 기록은 남는다', ['s4bA'], {
  s4bA: has179({ syncKey: K31, logs: logsOf(4, 'loc', 4_000_000) }),
}, async ({ adapter, fs, devices: [A] }) => {
  await fs.seed(K31, { members: ['legacy-X'], logs: logsOf(3, 'fa', 2_000_000) });
  await adapter.markGone(K31);
  await A.send('bootApp');
  const before = await idsOf(A);
  const mark = await adapter.requestCount();
  const result = await A.send('runMigration');
  assert.equal(result.result.status, 'deleted');
  // 이후 아무것도 하지 않는다. 이전 모듈이 넣은 평소 요청 하나가 410을 받아 연결을 끊는다.
  await waitFor(async () => !(await A.send('getProfile')).profile.syncKey, { label: '410 회차의 연결 해제', timeoutMs: 15_000 });
  const events = (await A.send('runnerEvents')).events;
  assert.equal(events.filter((e) => e.type === 'disconnected').length, 1);
  assert.equal(events.filter((e) => e.type === 'started').length, 1, '이전 모듈이 넣은 평소 요청은 하나다');
  const reqs = await adapter.requests(mark);
  assert.ok(reqs.length >= 2 && reqs.every((r) => r.status === 410), `D1 요청이 모두 410이어야 한다 ${JSON.stringify(reqs.map((r) => [r.kind, r.status]))}`);
  assert.equal(reqs.filter((r) => r.kind === 'push' || r.kind === 'pull').length, 0);
  assert.equal(await fs.opCount(), 0, 'deleted이면 Firestore를 읽지 않는다');
  const fam = await adapter.family(K31);
  assert.deepEqual([fam.exists, fam.deleted], [false, true], 'D1에 가족이 다시 생기지 않았다');
  assert.equal((await stateOf(A, K31)).state.mergeSource, undefined);
  await assertKept(A, before, 'A');
});

// ════════════════════════════════ 32. 관문 교착 없음 ════════════════════════════════
const K32 = keyOf('s32');
await scenario('32', '관문 교착 없음: 이전이 도는 동안 저장과 당겨서 새로고침이 이어져 관문과 ensure가 여러 번 불려도 모든 요청이 상한 안에 끝나고 d1UploadedAt이 적힌다', ['s4bA'], {
  s4bA: has179({ syncKey: K32, logs: logsOf(3, 'loc', 4_000_000) }),
}, async ({ adapter, fs, devices: [A] }) => {
  await fs.seed(K32, { members: ['legacy-X'], logs: logsOf(40, 'fa', 2_000_000) });
  await A.send('bootApp');
  const before = await idsOf(A);
  await fs.delay({ op: 'get', kind: 'family' }, 1_500, { times: 'always' }); // ensure가 1.5초 넘게 도는 동안 요청이 쌓이게
  await adapter.delay({ kind: 'sync' }, 80);
  const timed = async (promise) => { const at = Date.now(); const result = await promise; return { ms: Date.now() - at, result }; };
  const migration = track(A.send('runMigration', {}, { timeoutMs: 60_000 }));
  const calls = [];
  for (let i = 0; i < 14; i += 1) {
    await A.send('addLog', { log: { type: 'formula', amount: i, timestamp: 1_700_000_100_000 + i } });
    calls.push(track(timed(A.send('runnerRequest', { request: { syncKey: K32 }, timeoutMs: 6_000 }, { timeoutMs: 20_000 }))));
    await sleep(70);
  }
  const outcomes = await Promise.all(calls); // 교착이면 여기서 20초 상한에 걸려 거부된다
  assert.ok(Math.max(...outcomes.map((o) => o.ms)) < 7_000, '요청이 러너 상한 안에 끝나지 않았다');
  const pendingOnes = outcomes.filter((o) => o.result.migrationPending === true);
  assert.ok(pendingOnes.length >= 8, `전제: 이전 중에는 관문이 막았다(${pendingOnes.length}건)`);
  // 관문은 ensure를 기다리지 않고 저장소와 메모리 값만으로 곧바로 답한다. 기다리면 러너 대기열이 ensure(1.5초 이상)만큼 막힌다.
  assert.ok(Math.max(...pendingOnes.map((o) => o.ms)) < 800, `관문이 ensure를 기다렸다(가장 느린 migrationPending 응답 ${Math.max(...pendingOnes.map((o) => o.ms))}ms)`);
  await migration;
  const done = await waitMigrationComplete(A, { timeoutMs: 30_000 });
  assert.equal(typeof done.state.d1UploadedAt, 'number');
  const final = await A.send('runnerRequest', { request: { syncKey: K32 }, timeoutMs: 20_000 });
  assert.equal(final.success, true, final.error);
  const live = await d1Live(adapter, K32);
  assert.ok(logsOf(40, 'fa', 2_000_000).every((l) => live.includes(l.id)));
  assert.deepEqual(live, await idsOf(A));
  await assertKept(A, before, 'A');
});

// ════════════════════════════════ 33. 합류 중 예약과 410 ════════════════════════════════
const K33a = keyOf('s33a');
const K33b = keyOf('s33b');
const K33c = keyOf('s33c');
await scenario('33', '합류 중 예약과 410: 선택지는 둘뿐이고 어느 쪽도 deleted_families를 쓰지 않는다, 합류 취소는 키를 저장하지 않는다, legacyJoin 3단계 410은 "이 가족은 삭제되었습니다"로 끝나고 키를 저장하지 않는다', ['s4bA', 's4bB', 's4bC'], {}, async ({ adapter, fs, devices: [A, B, C] }) => {
  const pda = Date.now() + 3 * 24 * HOUR;
  await fs.seed(K33a, { members: ['legacy-X'], logs: logsOf(3, 'fa', 2_000_000), family: { pendingDeletionAt: pda } });
  await fs.seed(K33b, { members: ['legacy-X'], logs: logsOf(3, 'fb', 3_000_000), family: { pendingDeletionAt: pda } });
  await fs.seed(K33c, { members: ['legacy-X'], logs: logsOf(3, 'fc', 4_000_000) });
  for (const device of [A, B, C]) await device.send('bootApp');
  const deletedMessage = (await A.send('migrationMessages')).messages.joinDeleted;
  const noDeletionRecords = async (key) => { const f = await adapter.family(key); assert.deepEqual([f.exists, f.deleted], [f.exists, false], 'deleted_families에 기록이 생겼다'); return f; };
  for (const device of [A, B]) await device.send('addLog', { log: { type: 'formula', amount: 1, timestamp: 1_700_000_000_500 } });
  const aBefore = await idsOf(A);
  const bBefore = await idsOf(B);

  // (1) 합류 취소: 키를 저장하지 않고 Firestore 기록도 섞이지 않는다.
  await A.send('setChoiceAnswers', { legacyDeletion: ['cancelJoin'] });
  const joinA = await A.send('join', { key: K33a });
  assert.equal(joinA.outcome, 'cancelled', JSON.stringify(joinA));
  const promptA = (await choicesOf(A)).legacyDeletion;
  assert.equal(promptA.length, 1);
  assert.equal(promptA[0].context, 'joining');
  assert.deepEqual(promptA[0].options, ['cancelRequest', 'cancelJoin'], '합류 중 선택지는 둘뿐이다');
  assert.ok(!(await A.send('getProfile')).profile.syncKey, '합류 취소는 키를 저장하지 않는다');
  assert.equal((await noDeletionRecords(K33a)).exists, false, 'D1 가족도 만들지 않았다');
  assert.deepEqual(await idsOf(A), aBefore, '그 가족의 기록이 기기에 섞이지 않았다');
  assert.equal(typeof (await fs.snapshot(K33a)).family.pendingDeletionAt?.__ts, 'number', 'Firestore 예약은 그대로다');

  // (2) 요청 취소하고 합류: Firestore 예약을 null로 쓰고 합류를 이어 간다. deleted_families는 비어 있다.
  await B.send('setChoiceAnswers', { legacyDeletion: ['cancelRequest'] });
  const joinB = await B.send('join', { key: K33b });
  assert.equal(joinB.outcome, 'joined', JSON.stringify(joinB));
  const promptB = (await choicesOf(B)).legacyDeletion;
  assert.deepEqual([promptB.length, promptB[0].context, promptB[0].options], [1, 'joining', ['cancelRequest', 'cancelJoin']]);
  assert.equal((await fs.snapshot(K33b)).family.pendingDeletionAt, null, 'Firestore 예약이 null로 취소됐다');
  assert.equal((await noDeletionRecords(K33b)).exists, true);
  assert.equal((await B.send('getProfile')).profile.syncKey, K33b);
  await waitMigrationComplete(B, { syncKey: K33b, timeoutMs: 30_000 });
  await assertKept(B, bBefore, 'B');

  // (3) legacyJoin 3단계(D1 가족 생성)에서 410: 두 번째 연결 요청을 멈춘 사이 삭제 기록이 생긴다.
  const cBefore = await idsOf(C);
  const gate = await adapter.holdNext({ kind: 'connect' }, { skip: 1 });
  const joinC = track(C.send('join', { key: K33c }));
  await gate.held;
  await adapter.markGone(K33c);
  await gate.release();
  const resultC = await joinC;
  assert.equal(resultC.outcome, 'deleted', JSON.stringify(resultC));
  assert.equal(resultC.message, deletedMessage);
  assert.ok(!(await C.send('getProfile')).profile.syncKey, '410이면 키를 저장하지 않는다');
  const famC = await adapter.family(K33c);
  assert.deepEqual([famC.exists, famC.deleted], [false, true]);
  assert.deepEqual(await idsOf(C), cBefore, '기록이 섞이지 않았다');
  assert.equal((await stateOf(C, K33c)).state.mergedAt, undefined);
  await assertKept(A, aBefore, 'A');
});

// ════════════════════════════════ 34. 백업 표지 ════════════════════════════════
const K34a = keyOf('s34a');
const K34b = keyOf('s34b');
const K34c = keyOf('s34c');
await scenario('34', '백업 표지: 관문이 여러 번 멈춰도 백업 값을 다시 읽지 않고, "백업 없이 계속" 뒤에는 다시 묻지 않으며, 표식 비우기 뒤에는 표식이 다시 계산되지 않는다', ['s4bA', 's4bB', 's4bC'], {
  s4bA: has179({ syncKey: K34a, logs: logsOf(4, 'a-own', 5_000_000) }),
  s4bB: has179({ syncKey: K34b, logs: logsOf(3, 'b-own', 6_000_000) }),
  s4bC: has179({ syncKey: K34c, logs: logsOf(2, 'c-own', 7_000_000) }),
}, async ({ fs, devices: [A, B, C] }) => {
  await fs.seed(K34a, { members: ['legacy-X'], logs: logsOf(3, 'fa', 2_000_000) });
  await fs.seed(K34b, { members: ['legacy-X'], logs: logsOf(3, 'fb', 3_000_000) });
  for (const device of [A, B, C]) await device.send('bootApp');
  const aBefore = await idsOf(A);
  const bBefore = await idsOf(B);

  // (1) 백업을 만든 뒤 관문이 여러 번 멈춰(ensure가 반복) 표지만 읽는다. Firestore를 끊어 이전이 끝나지 않게 한다.
  await fs.offline(true);
  assert.equal((await A.send('runMigration')).result.status, 'firestore_failed');
  assert.equal((await stateOf(A)).hasBackupValue, true);
  await A.send('storageReads', { clear: true });
  for (let i = 0; i < 4; i += 1) assert.equal((await A.send('runMigration')).result.status, 'waiting');
  for (let i = 0; i < 3; i += 1) {
    const r = await A.send('runnerRequest', { request: { syncKey: K34a }, timeoutMs: 20_000 });
    assert.equal(r.migrationPending, true);
    await sleep(150);
  }
  const reads = (await A.send('storageReads')).reads;
  assert.ok((reads[META] || 0) >= 4, `전제: ensure가 표지를 읽었다(${reads[META] || 0}회)`);
  assert.equal(reads[BACKUP] || 0, 0, `백업 값(수 MB)을 다시 읽었다(${reads[BACKUP]}회)`);

  // (2) "백업 없이 계속"을 고른 뒤에는 다시 묻지 않는다(백업 저장은 계속 실패하도록 둔다).
  await B.send('injectStorageFault', { mode: 'reject', keys: [BACKUP], times: 'always' });
  await B.send('setChoiceAnswers', { backupFailure: ['continue'] });
  assert.equal((await B.send('runMigration')).result.status, 'firestore_failed');
  assert.equal((await choicesOf(B)).backupFailure.length, 1);
  assert.equal(typeof (await stateOf(B)).backupMeta?.skippedAt, 'number');
  for (let i = 0; i < 2; i += 1) {
    await B.send('migratorReset'); // 앱을 다시 연다
    assert.equal((await B.send('runMigration')).result.status !== 'backup_pending', true);
  }
  assert.equal((await choicesOf(B)).backupFailure.length, 1, '"백업 없이 계속"을 고른 뒤에 다시 물었다');
  assert.equal((await stateOf(B)).hasBackupValue, false);

  // (3) 개발 메뉴의 표식 비우기: 키를 지우지 않고 빈 keys로 덮어쓰므로 다시 실행해도 다시 계산되지 않는다.
  const first = (await C.send('migrationState')).marker;
  assert.deepEqual(first.keys, [K34c]);
  const cleared = (await C.send('clearLegacyMarker')).marker;
  assert.deepEqual(cleared.keys, []);
  await C.restart();
  const rebooted = (await C.send('bootApp')).marker;
  assert.deepEqual(rebooted, cleared, '비운 표식이 다시 계산됐다');
  assert.equal(JSON.parse((await storageItems(C, [MARKER]))[MARKER]).keys.length, 0);
  await C.send('migratorReset');
  await C.send('runMigration');
  assert.deepEqual((await C.send('migrationState')).marker.keys, [], '다시 실행한 뒤에도 keys가 빈 배열이다');
  await assertKept(A, aBefore, 'A');
  await assertKept(B, bBefore, 'B');
});

// ════════════════════════════════ 25. 불변 조건 2의 쓰기 목록 ════════════════════════════════
// 시나리오마다 서버가 따로 뜨므로 각 시나리오가 끝나기 전에 auditFirestoreWrites를 거쳤고(위 뼈대),
// 여기서는 그 앱 쓰기 전부를 모아 서버의 분류와 별개로 다시 판정한다: 회원 문서 생성과 pendingDeletionAt: null뿐, 지운 문서 0건.
if (!ONLY || ONLY.includes('25')) {
  const started = Date.now();
  try {
    assert.ok(ran.length > 0, '모아 판정할 시나리오가 없다');
    const violations = appWriteLog.filter((w) => {
      if (w.kind === 'delete') return true;
      const fields = [...w.fields].sort().join(',');
      const member = /^families\/[0-9a-f]{64}\/members\/([^/]+)$/.exec(w.path);
      if (member) return !(member[1] === w.uid && fields === 'inviteHash,joinedAt');
      if (/^families\/[0-9a-f]{64}$/.test(w.path)) return !(fields === 'pendingDeletionAt' && w.data?.pendingDeletionAt === null);
      return true;
    });
    assert.deepEqual(violations.map((w) => [w.scenario, w.kind, w.path, w.fields]), [], '허용 목록 밖의 앱 쓰기');
    assert.ok(appWriteLog.some((w) => /\/members\//.test(w.path)), '전제: 회원 문서 생성 쓰기가 모였다');
    if (ran.includes('33')) assert.ok(appWriteLog.some((w) => w.fields.join() === 'pendingDeletionAt'), '전제: 삭제 예약 취소 쓰기가 모였다(33)');
    results.push(true);
    console.log(`PASS [25] 불변 조건 2의 쓰기 목록: 시나리오 ${ran.join(',')}의 앱 쓰기 ${appWriteLog.length}건이 회원 문서 생성과 pendingDeletionAt: null뿐이고 삭제 0건 (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL [25] 불변 조건 2의 쓰기 목록\n     ${error?.stack || error}`);
  }
}

// ════════════════════════════════ 집계 ════════════════════════════════
const failed = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오 4부 b: ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
