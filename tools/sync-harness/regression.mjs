import assert from 'node:assert/strict';
import AsyncStorage from './stubs/async-storage.mjs';
import * as storage from '../../src/database/storage.ts';
import { syncWithCloud, parseFamilySyncId, deleteFamilyCloudData, scheduleFamilyDeletion, cancelFamilyDeletion } from '../../src/database/sync.ts';
import { withSyncDeadline } from '../../src/database/syncDeadline.ts';
import { createSyncRunner } from '../../src/database/syncRunner.ts';
import { setSyncTimingForTests } from '../../src/database/cloudClient.ts';
import { setCustomWorkerUrl } from '../../src/database/cloudConfig.ts';
import { createFakeAdapter } from './server-adapter.mjs';

// 두 모드로 도는 회귀 검사입니다(06 설계 5.1 시나리오 15).
//  - 가짜 Worker 모드(기본, HARNESS_FAKE_CLOUD=1): 같은 프로세스의 stubs/fake-worker.mjs 위에서 돕니다.
//  - 실제 서버 모드(HARNESS_REAL_WORKER=1): 실제 Worker 코드를 띄운 서버 프로세스(real-server.mjs)에 이 프로세스가
//    기기 하나로서 HTTP로 요청합니다. 서버 상태는 server-adapter.mjs의 어댑터로 묻고 조작합니다.
// 설계가 일부러 바꾼 동작(Firestore식 내부 상태 검사)은 아래처럼 바꿨습니다.
//  - 쓰기마다 가족 알림 문서가 같은 트랜잭션에 있다 -> 쓰기가 있는 요청마다 변경 토큰이 바뀐다
//  - constraints.length 로 전체/증분 구별 -> 요청 목록의 pull.after 가 (0, '') 인지로 구별
//  - 밀린 기록 때문에 lastFullReadAt === 0 -> 같은 회차의 분류 응답으로 수렴하고 다음 회차는 증분
//  - 옛 장부 키 -> 새 장부 키 @baby_sync_ledger_cf_v1 (옛 키는 값이 그대로인지만 본다)
//  - state.docs.set / beforeRead / beforeTransaction / beforeCommit -> 어댑터의 inject*, holdNext, failCommit
//  - pendingDeletionAt 직접 수정 -> 어댑터의 시계 진행(냉각 기간 경과)
//  - state.failNextSync / state.offline -> 어댑터의 failHttp / setOffline
// 가짜 Worker 모드에서만 도는 검사(서버의 응답이나 분류를 바꿔치기해야 해서 실제 Worker 코드로는 만들 수 없습니다):
//  - 시나리오 18 진전 없음 중단: 서버 분류가 항상 "받아들이지 않음"이 되도록 state.rejectAllPushes 로 조작한다
//  - 시나리오 17의 응답 조작: 같은 sharedUpdatedAt 의 불완전한 remoteProfile 을 state.tamperSyncResponse 로 끼워 넣는다
//  - 시나리오 6-a 의 빈 문자열 아기 이름 응답 조작(같은 방식)
// 시나리오 17은 실제 서버에서 판정할 수 있는 부분(shared_json NULL 이면 remoteProfile 없음, 일부 항목만 있는 pushProfile 거부 등)을
// real-scenarios-2.mjs 에서 맡고, 18은 실제 Worker 코드로 만들 수 없어 여기(가짜 Worker 모드)에서만 판정합니다.
const REAL = process.env.HARNESS_REAL_WORKER === '1';
let srv;
let realHarness = null;
if (REAL) {
  const { startRealHarness } = await import('./real-harness.mjs');
  realHarness = await startRealHarness({ devices: [] });
  setCustomWorkerUrl(realHarness.server.url);
  srv = realHarness.server.adapter;
  console.log(`실제 서버 모드: ${realHarness.server.url}`);
} else {
  const { state: fakeState } = await import('./stubs/fake-cloud.mjs');
  srv = createFakeAdapter(fakeState);
}
const FAKE_ONLY = !REAL;

const LEDGER_KEY = '@baby_sync_ledger_cf_v1';
const LEGACY_LEDGER_KEY = '@baby_sync_ledger_v1';
const isSync = r => r.kind === 'push' || r.kind === 'pull';
const syncRequests = async (from = 0) => (await srv.requests(from)).filter(isSync);
const isFullPull = r => r.pull && r.pull.after[0] === 0 && r.pull.after[1] === '';
const readLedger = async () => JSON.parse(await AsyncStorage.getItem(LEDGER_KEY));
const tokenOf = async key => (await srv.family(key)).token;
const pushedTotal = reqs => reqs.reduce((n, r) => n + r.pushLogs, 0);
const committedCount = async (from = 0) => (await syncRequests(from)).filter(r => r.committed).length;
const logRowsWritten = async (from = 0) => (await syncRequests(from)).reduce((n, r) => n + r.logWrites, 0);
const liveLogs = async key => (await srv.logs(key)).live;
const deletedIds = async key => (await srv.logs(key)).deleted;
// 실제 서버 모드에서 요청마다 기록된 쿼리 수, Worker 처리 시간, 본문 크기를 reset 직전마다 모아 마지막에 요약합니다.
const observed = { requests: 0, maxQueries: 0, maxWorkerMs: 0, maxBodyBytes: 0, maxRowsRead: 0, maxRowsWritten: 0, serverErrors: 0 };
const observe = async () => {
  if (!REAL) return;
  for (const r of await srv.requests()) {
    observed.requests += 1;
    observed.maxQueries = Math.max(observed.maxQueries, r.queries || 0);
    observed.maxWorkerMs = Math.max(observed.maxWorkerMs, r.workerMs || 0);
    observed.maxBodyBytes = Math.max(observed.maxBodyBytes, r.bodyBytes || 0);
    observed.maxRowsRead = Math.max(observed.maxRowsRead, r.rowsRead || 0);
    observed.maxRowsWritten = Math.max(observed.maxRowsWritten, r.rowsWritten || 0);
    if (r.status >= 500) observed.serverErrors += 1;
  }
};
const reset = async () => { await observe(); await AsyncStorage.clear(); await srv.reset(); };
const waitFor = async (predicate, what, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`시간 안에 ${what}`);
    await new Promise(res => setTimeout(res, 20));
  }
};

const stalledToken = { aborted: false };
const stalled = withSyncDeadline(new Promise(() => {}), stalledToken, () => 'timeout', 5);
const queuedRetry = stalled.then(() => withSyncDeadline(Promise.resolve('retried'), { aborted: false }, () => 'timeout', 50));
assert.equal(await stalled, 'timeout');
assert.equal(stalledToken.aborted, true);
assert.equal(await queuedRetry, 'retried');
console.log('PASS 응답이 영원히 없어도 시간 초과 뒤 대기 중인 재시도 실행');


const key = 'a'.repeat(32);
await reset();
await AsyncStorage.setItem(LEGACY_LEDGER_KEY, 'legacy-ledger-untouched');
await storage.saveProfile({ ...await storage.getProfile(), syncKey: key, name: '테스트 아기' });
const first = await storage.addLog({ type: 'formula', amount: 100, timestamp: 1000 });
const sync = async token => syncWithCloud(key, await storage.getLogs(), await storage.getProfile(), false, token);
let result = await sync();
assert.equal(result.success, true);
assert.ok(await committedCount() >= 1);
assert.ok((await tokenOf(key)).endsWith(':' + (await (await import('../../src/database/sync.ts')).getSyncClientId())), '쓰기가 있으면 변경 토큰에 쓴 기기가 남는다');
console.log('PASS 기록·프로필 변경과 함께 변경 토큰이 바뀐다');

let mark = await srv.requestCount();
const tokenBefore = await tokenOf(key);
assert.equal((await sync()).success, true);
assert.equal(await committedCount(mark), 0);
assert.equal(await tokenOf(key), tokenBefore, '변경이 없으면 토큰도 그대로');
console.log('PASS 변경 없는 동기화는 서버 쓰기 0회, 토큰 그대로');

// 서버 응답을 기다리는 동안 삭제한 기록은 다음 묶음을 고를 때 다시 읽혀 같은 회차에 전파된다.
await storage.addLog({ type: 'formula', amount: 55, timestamp: 1500 });
{
  const gate = await srv.holdNext({ kind: 'push' });
  const pending = sync();
  await gate.held;
  await storage.deleteLog(first.id);
  await gate.release();
  assert.equal((await pending).success, true);
}
assert.ok((await deletedIds(key)).includes(first.id));
console.log('PASS 서버 응답 중 삭제한 기록도 같은 회차에 삭제 전파');

const beforeOffline = await storage.getLogs();
await srv.setOffline(true);
result = await sync();
assert.equal(result.success, false);
assert.deepEqual(await storage.getLogs(), beforeOffline);
await srv.setOffline(false);
assert.equal((await sync()).success, true);
console.log('PASS 오프라인에서 성공 오표시 없이 로컬 보존, 재연결 시 성공');

const token = { aborted: false };
mark = await srv.requestCount();
{
  const gate = await srv.holdNext({ kind: 'sync' });
  const pending = sync(token);
  await gate.held;
  token.aborted = true;
  await gate.release();
  assert.equal((await pending).success, false);
}
assert.equal(await committedCount(mark), 0);
console.log('PASS 중단된 서버 응답은 저장·업로드하지 않음');

const localProfile = await storage.getProfile();
const saved = await storage.saveSyncedDataWithoutLoss(
  [{ id: 'late', type: 'formula', amount: 99, timestamp: 9 }], localProfile, key, { aborted: true },
);
assert.equal(saved.success, false);
assert.ok(!(await storage.getLogs()).some(log => log.id === 'late'));
console.log('PASS 저장 큐 안에서도 취소 여부 재확인');

await storage.saveProfile({ ...localProfile, syncKey: 'b'.repeat(32) });
assert.equal((await storage.saveSyncedDataWithoutLoss([], localProfile, key)).success, false);
assert.equal((await storage.getProfile()).syncKey, 'b'.repeat(32));
console.log('PASS 가족 전환 뒤 이전 가족 응답 폐기');

assert.equal(parseFamilySyncId('https://wrong.example/invite'), null);
assert.equal(parseFamilySyncId('abc def'), null);
assert.equal(parseFamilySyncId(`babycheck://family/${key}`), key);
console.log('PASS 잘못된 주소를 임의 가족 키로 변환하지 않음');

await storage.saveProfile({ ...await storage.getProfile(), syncKey: key });
await storage.addLog({ type: 'formula', amount: 180, timestamp: 2000 });
const remoteBeforeFailure = JSON.stringify([await liveLogs(key), await deletedIds(key)]);
await srv.failCommit();
assert.equal((await sync()).success, false);
assert.equal(JSON.stringify([await liveLogs(key), await deletedIds(key)]), remoteBeforeFailure);
assert.ok((await storage.getLogs()).some(log => log.amount === 180));
await srv.clearFaults();
assert.equal((await sync()).success, true);
assert.ok((await liveLogs(key)).some(([, raw]) => raw.includes('"amount":180')));
console.log('PASS 커밋 실패 시 서버 행 미반영, 로컬 기록 재전송 성공');

// ────────────── 증분 동기화 ──────────────
const deltaKey = 'd'.repeat(32);
await reset();
await AsyncStorage.setItem(LEGACY_LEDGER_KEY, 'legacy-ledger-untouched');
await storage.saveProfile({ ...await storage.getProfile(), syncKey: deltaKey, name: '증분 아기' });
const deltaSync = async (force = false) =>
  syncWithCloud(deltaKey, await storage.getLogs(), await storage.getProfile(), false, undefined, true, force);

for (let i = 0; i < 40; i += 1) {
  await storage.addLog({ type: 'formula', amount: 100 + i, timestamp: 1_000 + i });
}
// 1회차: 빈 가족에 40건이 올라가고 전체 모드(커서 없음)로 증분 커서가 잡힌다.
mark = await srv.requestCount();
assert.equal((await deltaSync()).success, true);
assert.ok((await syncRequests(mark)).some(isFullPull), '커서가 없는 회차는 전체 모드로 당겨 받는다');
assert.equal(pushedTotal(await syncRequests(mark)), 40);
assert.equal((await liveLogs(deltaKey)).length, 40);

// 2회차: 이전 회차에서 잡힌 커서로 증분 당겨 받기를 쓴다.
mark = await srv.requestCount();
assert.equal((await deltaSync()).success, true);
assert.ok((await syncRequests(mark)).every(r => !isFullPull(r)), '두 번째 동기화는 증분이어야 한다');
assert.ok((await syncRequests(mark)).some(r => r.pull), '증분 당겨 받기를 한다');
assert.equal(pushedTotal(await syncRequests(mark)), 0);
assert.equal(await committedCount(mark), 0, '변경이 없으면 증분 동기화도 쓰기가 없어야 한다');
console.log('PASS 증분 동기화는 증분 당겨 받기를 쓰고 쓰기가 0회다');

mark = await srv.requestCount();
await storage.addLog({ type: 'urine', wetness: 'medium', color: 'normal', timestamp: 5_000 });
assert.equal((await deltaSync()).success, true);
assert.equal(pushedTotal(await syncRequests(mark)), 1, '새 기록 1건만 올라가야 한다');
assert.equal(await logRowsWritten(mark), 1);
console.log('PASS 증분 모드에서 기존 기록을 다시 올리지 않는다 (쓰기 1회)');

// 상대 기기가 남긴 변경은 증분 응답에 포함되어야 한다.
await srv.injectLog(deltaKey, { id: 'from-partner', type: 'formula', amount: 222, timestamp: 9_000, updatedAt: Date.now() + 1000 }, Date.now() + 1000);
assert.equal((await deltaSync()).success, true);
assert.ok((await storage.getLogs()).some(log => log.id === 'from-partner'), '상대 기기 기록이 증분으로 들어와야 한다');
console.log('PASS 상대 기기의 새 기록이 증분 읽기로 들어온다');

await srv.injectLog(deltaKey, { id: 'partner-deleted', type: 'formula', amount: 5, timestamp: 9_500 }, Date.now() + 2000);
assert.equal((await deltaSync()).success, true);
assert.ok((await storage.getLogs()).some(log => log.id === 'partner-deleted'));
await srv.injectTombstone(deltaKey, 'partner-deleted', Date.now() + 3000);
assert.equal((await deltaSync()).success, true);
assert.ok(!(await storage.getLogs()).some(log => log.id === 'partner-deleted'), '상대가 지운 기록은 증분으로 사라져야 한다');
console.log('PASS 상대 기기의 삭제가 증분 읽기로 전파된다');

const mine = (await storage.getLogs()).find(log => log.type === 'urine');
await storage.deleteLog(mine.id);
assert.equal((await deltaSync()).success, true);
assert.ok((await deletedIds(deltaKey)).includes(mine.id));
assert.ok((await srv.logs(deltaKey)).rows.find(r => r.id === mine.id).updatedAt > 0,
  '삭제 표식에 updatedAt 이 없으면 상대 기기가 증분 질의로 삭제를 못 받는다');
console.log('PASS 삭제 표식에 updatedAt 을 남겨 상대가 증분으로 받을 수 있다');

mark = await srv.requestCount();
assert.equal((await deltaSync()).success, true);
assert.equal(await committedCount(mark), 0, '이미 올린 삭제 표식을 다시 쓰면 안 된다');
console.log('PASS 이미 전파된 삭제를 반복해서 다시 쓰지 않는다');

// 장부가 사라져도(앱 재설치·저장소 손상) 전체 모드로 안전하게 되돌아가야 한다.
await AsyncStorage.removeItem(LEDGER_KEY);
mark = await srv.requestCount();
assert.equal((await deltaSync()).success, true);
assert.ok((await syncRequests(mark)).some(isFullPull), '장부가 없으면 전체 모드여야 한다');
assert.ok((await storage.getLogs()).some(log => log.id === 'from-partner'));
assert.equal(await AsyncStorage.getItem(LEGACY_LEDGER_KEY), 'legacy-ledger-untouched', '옛 장부 키는 읽지도 지우지도 않는다');
console.log('PASS 장부가 사라지면 전체 모드로 되돌아가고 기록은 그대로다 (옛 키는 그대로)');

// 장부가 깨지거나 다른 가족 것이어도 전체 모드이고 기록은 줄지 않는다.
const countBeforeCorrupt = (await storage.getLogs()).length;
await AsyncStorage.setItem(LEDGER_KEY, '{broken');
mark = await srv.requestCount();
assert.equal((await deltaSync()).success, true);
assert.ok((await syncRequests(mark)).some(isFullPull));
await AsyncStorage.setItem(LEDGER_KEY, JSON.stringify({ ...(await readLedger()), familyKey: 'other' }));
mark = await srv.requestCount();
assert.equal((await deltaSync()).success, true);
assert.ok((await syncRequests(mark)).some(isFullPull));
assert.equal((await storage.getLogs()).length, countBeforeCorrupt);
console.log('PASS 깨진 장부와 다른 가족 장부는 전체 모드로 돌고 기록이 줄지 않는다');

// 파트너가 서버에서 삭제한 기록은 장부를 잃고 전체 모드로 돌아도 부활하지 않는다.
const resKey = 't'.repeat(32);
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: resKey, name: '묘비명 테스트' });
const tLog = await storage.addLog({ type: 'formula', amount: 150, timestamp: 3000 });
assert.equal((await syncWithCloud(resKey, await storage.getLogs(), await storage.getProfile())).success, true);
await srv.injectTombstone(resKey, tLog.id, Date.now() + 5000);
await AsyncStorage.removeItem(LEDGER_KEY);
assert.equal((await syncWithCloud(resKey, await storage.getLogs(), await storage.getProfile(), false, undefined, true, true)).success, true);
assert.ok(!(await storage.getLogs()).some(l => l.id === tLog.id), '서버의 삭제 표식 때문에 삭제된 기록이 부활하지 않아야 한다');
assert.ok((await storage.getProfile()).deletedLogIds.includes(tLog.id), '로컬 tombstone에 기록 id가 보존되어야 한다');
console.log('PASS 전체 모드에서도 파트너가 지운 기록이 부활하지 않음');

// 복구 후 deltaKey 환경 복원
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: deltaKey, name: '증분 아기' });
await srv.injectLog(deltaKey, { id: 'from-partner', type: 'formula', amount: 222, timestamp: 9_000, updatedAt: Date.now() + 1000 }, Date.now() + 1000);
await storage.addLog({ id: 'from-partner', type: 'formula', amount: 222, timestamp: 9_000 });
assert.equal((await deltaSync()).success, true);

// 당겨서 새로고침은 증분을 건너뛰고 전체를 대조한다.
mark = await srv.requestCount();
assert.equal((await deltaSync(true)).success, true);
assert.ok((await syncRequests(mark)).some(isFullPull), '강제 새로고침은 전체 모드여야 한다');
console.log('PASS 당겨서 새로고침은 전체 대조로 동작한다');

// 서버가 더 최신이면 밀린 기록은 장부에 "올렸다"고 적히지 않고, 같은 회차의 분류 응답으로 서버 값에 수렴한다.
const racer = (await storage.getLogs()).find(log => log.id === 'from-partner');
await storage.updateLog({ ...racer, amount: 111 });
const racerStamp = (await storage.getLogs()).find(log => log.id === 'from-partner').updatedAt;
const partnerStamp = Date.now() + 60_000;
{
  const gate = await srv.holdNext({ kind: 'sync' });
  const pending = deltaSync();
  await gate.held;
  await srv.injectLog(deltaKey, { ...racer, amount: 999, updatedAt: partnerStamp }, Date.now() + 60_000);
  await gate.release();
  assert.equal((await pending).success, true);
}
assert.equal((await storage.getLogs()).find(log => log.id === 'from-partner').amount, 999,
  '같은 회차의 분류 응답으로 서버의 최신 값에 수렴해야 한다');
const ledgerAfter = await readLedger();
assert.notEqual(ledgerAfter.uploaded['from-partner'], racerStamp, '밀린 기록의 내 시각을 "올림"으로 적으면 안 된다');
assert.equal(ledgerAfter.uploaded['from-partner'], partnerStamp);
mark = await srv.requestCount();
assert.equal((await deltaSync()).success, true);
assert.ok((await syncRequests(mark)).every(r => !isFullPull(r)), '다음 회차는 증분이다');
assert.equal(pushedTotal(await syncRequests(mark)), 0, '수렴한 기록을 다시 올리지 않는다');
console.log('PASS 밀린 기록은 장부에 올림으로 적지 않고 분류 응답으로 수렴한다');

// 가족 데이터 영구 삭제는 예약(냉각 기간)을 먼저 걸어야 하고, 예약만으로는 지워지면 안 된다.
const scheduleOutcome = await scheduleFamilyDeletion(deltaKey);
assert.equal(scheduleOutcome.success, true, scheduleOutcome.error);
assert.ok(typeof scheduleOutcome.readyAt === 'number' && scheduleOutcome.readyAt > Date.now(),
  '삭제 예약은 냉각 기간 이후의 미래 시각을 반환해야 한다');
assert.ok((await srv.family(deltaKey)).pendingDeletionAt, '가족에 삭제 예약 시각이 저장돼야 한다');
assert.ok((await liveLogs(deltaKey)).length > 0, '예약만으로는 기록이 지워지면 안 된다');
console.log('PASS 가족 데이터 영구 삭제는 예약 시 즉시 실행되지 않고 냉각 기간을 둔다');

const cancelOutcome = await cancelFamilyDeletion(deltaKey);
assert.equal(cancelOutcome.success, true, cancelOutcome.error);
assert.equal((await srv.family(deltaKey)).pendingDeletionAt, null);
console.log('PASS 삭제 예약을 취소하면 표시가 지워진다');

await scheduleFamilyDeletion(deltaKey);
const prematureDelete = await deleteFamilyCloudData(deltaKey);
assert.equal(prematureDelete.success, false, '냉각 기간 이전에는 영구 삭제가 거부되어야 한다');
assert.ok((await srv.family(deltaKey)).exists, '거부된 삭제는 가족을 지우지 않아야 한다');
console.log('PASS 냉각 기간 이전에는 영구 삭제 요청이 서버에서 거부된다');

await srv.advanceClock(60 * 60 * 1000 + 1000); // 냉각 기간(1시간)이 지난 것으로 만든다
const deleteOutcome = await deleteFamilyCloudData(deltaKey);
assert.equal(deleteOutcome.success, true, deleteOutcome.error);
{
  const family = await srv.family(deltaKey);
  assert.ok(!family.exists && family.deleted && (await srv.logs(deltaKey)).rows.length === 0);
}
console.log('PASS 가족 데이터 영구 삭제가 가족과 기록을 모두 지우고 삭제 기록을 남긴다');

// 삭제한 가족은 410이고, allowCreate: true 로도 되살아나지 않는다. 다른 기기가 먼저 지운 삭제 요청도 성공이다.
const goneNormal = await syncWithCloud(deltaKey, await storage.getLogs(), await storage.getProfile(), false, undefined, false);
assert.equal(goneNormal.familyUnavailable, true);
assert.ok(!goneNormal.familyNotFound);
const goneCreate = await syncWithCloud(deltaKey, await storage.getLogs(), await storage.getProfile(), false, undefined, true);
assert.equal(goneCreate.familyUnavailable, true);
assert.ok(!(await srv.family(deltaKey)).exists, '영구 삭제한 가족은 allowCreate 로도 다시 생기지 않는다');
assert.equal((await deleteFamilyCloudData(deltaKey)).success, true, '410은 이미 삭제된 가족이라 성공으로 본다');
console.log('PASS 영구 삭제한 가족은 410이고 다시 생기지 않는다');

const invalidDelete = await deleteFamilyCloudData('bad key!!');
assert.equal(invalidDelete.success, false);
console.log('PASS 잘못된 가족 키로는 영구 삭제가 실행되지 않는다');

// ────────────── A4 새 동작 ──────────────
const bigKey = 'e'.repeat(32);

// 1. 500건 초과: 기록 1,200건과 삭제 표식 300건이 나눠 올라간다. 모든 요청이 한도 안이고 200이다.
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey });
const bigLogs = Array.from({ length: 1200 }, (_, i) => ({ id: `big-${i}`, type: 'formula', amount: 90, timestamp: 10_000 + i, updatedAt: 10_000 + i }));
await storage.saveLogs(bigLogs);
await storage.saveProfile({ ...await storage.getProfile(), deletedLogIds: Array.from({ length: 300 }, (_, i) => `gone-${i}`) });
let rounds = 0;
let big;
do {
  big = await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false);
  assert.equal(big.success, true, big.error);
  rounds += 1;
} while (big.continuing && rounds < 5);
assert.ok((await syncRequests()).every(r => r.status === 200 && r.pushLogs + r.pushDeleted <= 400));
assert.equal((await liveLogs(bigKey)).length, 1200);
assert.equal((await deletedIds(bigKey)).length, 300);
console.log(`PASS 기록 1,200건과 삭제 표식 300건이 나눠 올라간다 (회차 ${rounds}, 요청 ${(await syncRequests()).length})`);

// 1-a. 한글 메모 1,000자 400건: 묶음을 바이트로 잘라 413이 나지 않는다.
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey });
const memo = '가'.repeat(1000);
await storage.saveLogs(Array.from({ length: 400 }, (_, i) => ({ id: `kr-${i}`, type: 'formula', amount: 90, timestamp: 20_000 + i, updatedAt: 20_000 + i, notes: memo })));
rounds = 0;
do {
  big = await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false);
  assert.equal(big.success, true, big.error);
  rounds += 1;
} while (big.continuing && rounds < 5);
assert.equal((await syncRequests()).filter(r => r.status === 413).length, 0);
assert.equal((await liveLogs(bigKey)).length, 400);
assert.ok((await syncRequests()).filter(r => r.pushLogs > 0).length >= 2, '바이트 상한으로 묶음이 나뉜다');
console.log('PASS 한글 메모 400건도 413 없이 바이트 상한으로 나눠 올라간다');

// 큰 기록 하나(900KB 초과)는 공유하지 못한다고 알리고 나머지는 올라간다.
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey });
await storage.saveLogs([
  { id: 'huge', type: 'formula', amount: 1, timestamp: 1, updatedAt: 1, notes: 'x'.repeat(950 * 1024) },
  { id: 'small', type: 'formula', amount: 1, timestamp: 2, updatedAt: 2 },
]);
big = await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false);
assert.equal(big.success, true, big.error);
assert.deepEqual(big.oversizedIds, ['huge']);
assert.deepEqual((await liveLogs(bigKey)).map(([id]) => id), ['small']);
assert.ok((await storage.getLogs()).some(l => l.id === 'huge'), '큰 기록도 기기에는 그대로 있다');
console.log('PASS 900KB 넘는 기록은 oversizedIds 로 알리고 나머지는 올라간다');

// 3~4. 삭제 표식은 행이 없어도 서버에 남고, 같은 버전 재전송은 서버 행을 다시 쓰지 않는다.
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey });
await storage.saveLogs(Array.from({ length: 50 }, (_, i) => ({ id: `same-${i}`, type: 'formula', amount: 90, timestamp: 30_000 + i, updatedAt: 30_000 + i })));
await storage.saveProfile({ ...await storage.getProfile(), deletedLogIds: ['never-uploaded'] });
assert.equal((await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false)).success, true);
assert.ok((await deletedIds(bigKey)).includes('never-uploaded'), '행이 없어도 삭제 표식이 서버에 남는다');
const tokenSame = await tokenOf(bigKey);
const updatedAtSame = (await srv.logs(bigKey)).rows.map(r => r.updatedAt).join();
const ledgerNow = await readLedger();
await AsyncStorage.setItem(LEDGER_KEY, JSON.stringify({ ...ledgerNow, uploaded: {} }));
mark = await srv.requestCount();
assert.equal((await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false)).success, true);
assert.ok((await syncRequests(mark)).some(r => r.pushLogs === 50), '전제: 같은 버전 50건을 다시 보낸다');
assert.equal(await committedCount(mark), 0, '같은 버전 재전송은 서버 쓰기 0');
assert.equal(await tokenOf(bigKey), tokenSame);
assert.equal((await srv.logs(bigKey)).rows.map(r => r.updatedAt).join(), updatedAtSame);
assert.equal((await readLedger()).uploaded['same-0'], 30_000, '재전송 뒤 장부는 다시 채워진다');
console.log('PASS 삭제 표식이 보존되고 같은 버전 재전송은 서버 쓰기 0, 토큰 그대로');

// 요청 크기 조절: 503이면 절반, 서버 힌트가 낮으면 힌트를 따른다.
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey });
await storage.saveLogs(Array.from({ length: 600 }, (_, i) => ({ id: `lim-${i}`, type: 'formula', amount: 90, timestamp: 40_000 + i, updatedAt: 40_000 + i })));
await srv.failHttp({ status: 503, match: { kind: 'push', hasPushItems: true }, times: 'always' });
const failedPush = await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false);
assert.equal(failedPush.success, false);
assert.equal((await readLedger()).limits.push, 200, '503이면 올리기 크기가 절반으로 준다');
await srv.clearFaults();
mark = await srv.requestCount();
rounds = 0;
do { big = await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false); rounds += 1; } while (big.continuing && rounds < 5);
assert.equal(big.success, true, big.error);
assert.ok((await syncRequests(mark)).every(r => r.pushLogs <= 200), '다음 회차는 200건 이하 묶음');
await srv.setLimits({ maxPushItems: 100 });
await storage.saveLogs([...await storage.getLogs(), ...Array.from({ length: 300 }, (_, i) => ({ id: `hint-${i}`, type: 'formula', amount: 90, timestamp: 50_000 + i, updatedAt: 50_000 + i }))]);
await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false); // 힌트를 받는다(첫 묶음은 200건)
mark = await srv.requestCount();
rounds = 0;
do { big = await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false); rounds += 1; } while (big.continuing && rounds < 5);
assert.ok((await readLedger()).limits.serverPush === 100);
console.log('PASS 요청 크기 조절: 503이면 절반, 서버 힌트를 장부에 저장한다');
await srv.setLimits({ maxPushItems: 400 });

// 18. 진전 없음 중단: 분류가 항상 받아들이지 않으면 2묶음에서 멈추고 이어 가지 않는다. (가짜 Worker 모드 전용)
if (FAKE_ONLY) {
  await reset();
  await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey });
  await storage.saveLogs(Array.from({ length: 1200 }, (_, i) => ({ id: `st-${i}`, type: 'formula', amount: 90, timestamp: 60_000 + i, updatedAt: 60_000 + i })));
  srv.state.rejectAllPushes = true;
  big = await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false);
  assert.equal(big.success, false);
  assert.equal(big.uploadStalled, true);
  assert.ok(!big.continuing);
  assert.equal((await syncRequests()).filter(r => r.pushLogs > 0).length, 2);
  console.log('PASS 진전 없는 묶음이 두 번 나오면 올리기를 멈추고 uploadStalled 로 끝난다');
}

// 17. 아기 정보 가드: 완전하지 않은 원격 아기 정보로 이름이 바뀌지 않는다.
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey, name: '지킬이름' });
assert.equal((await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false)).success, true);
if (FAKE_ONLY) { // 서버 응답을 바꿔치기하는 검사라서 가짜 Worker 모드 전용이다.
  // 같은 sharedUpdatedAt(타이브레이커로 갈리는 경우)과 더 큰 sharedUpdatedAt 양쪽에서 확인한다.
  const sameStamp = (await storage.getProfile()).sharedUpdatedAt;
  const guarded = await storage.getProfile();
  for (const tampered of [
    {},
    { name: '엉뚱', sharedUpdatedAt: 9e15 },
    { name: '엉뚱', birthDate: '2020-01-01', birthWeight: '3', targetFormula: '900', sharedUpdatedAt: 9e15 },
    { sharedUpdatedAt: sameStamp },
    { name: '엉뚱', sharedUpdatedAt: sameStamp },
    { name: '엉뚱', birthDate: '2020-01-01', birthWeight: '3', targetFormula: '900', sharedUpdatedAt: sameStamp },
    { name: '엉뚱', birthDate: '2020-01-01', birthWeight: '3', targetFormula: 900 },
  ]) {
    srv.state.tamperSyncResponse = (_body, response) => ({ ...response, remoteProfile: tampered });
    assert.equal((await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false)).success, true);
    const after = await storage.getProfile();
    assert.equal(after.name, '지킬이름');
    assert.deepEqual([after.birthDate, after.birthWeight, after.targetFormula], [guarded.birthDate, guarded.birthWeight, guarded.targetFormula], '공유 항목이 바뀌지 않는다');
  }
  srv.state.tamperSyncResponse = null;
  console.log('PASS 완전하지 않은 원격 아기 정보는 무시한다');

  // 빈 이름도 완전한 값이면 따른다(6-a).
  srv.state.tamperSyncResponse = (_body, response) => ({ ...response, remoteProfile: { name: '', birthDate: '2024-01-01', birthWeight: '3.2', targetFormula: 800, sharedUpdatedAt: 9e15 } });
  assert.equal((await syncWithCloud(bigKey, await storage.getLogs(), await storage.getProfile(), false)).success, true);
  assert.equal((await storage.getProfile()).name, '');
  srv.state.tamperSyncResponse = null;
  console.log('PASS 빈 문자열 이름도 완전한 아기 정보로 따른다');
}

// 14. 가져오기와 백업 복원은 새 장부 키도 지운다.
await AsyncStorage.setItem(LEDGER_KEY, '{}');
await AsyncStorage.setItem(LEGACY_LEDGER_KEY, 'x');
await storage.importDataWithoutLoss([], await storage.getProfile());
assert.equal(await AsyncStorage.getItem(LEDGER_KEY), null);
assert.equal(await AsyncStorage.getItem(LEGACY_LEDGER_KEY), null);
await AsyncStorage.setItem(LEDGER_KEY, '{}');
await storage.backupLocalData();
await storage.restoreFromLocalBackup();
assert.equal(await AsyncStorage.getItem(LEDGER_KEY), null);
console.log('PASS 가져오기와 백업 복원이 새 장부 키를 지운다');

// ────────────── A5 러너 ──────────────
const runKey = 'f'.repeat(32);
const makeRunner = (events, timeoutMs = 20_000) => createSyncRunner({
  syncWithCloud,
  getLogs: storage.getLogs,
  getProfile: storage.getProfile,
  saveProfile: storage.saveProfile,
  readProfileAfterPendingWrites: storage.readProfileAfterPendingWrites,
  timeoutMs,
  onEvent: e => events.push(e),
});

// 12. syncKey 가 없으면 요청 0회.
await reset();
let events = [];
let runner = makeRunner(events);
let r = await runner.request({ syncKey: runKey });
assert.equal(r.success, false);
assert.equal(await srv.requestCount(), 0);
console.log('PASS 가족 키가 없으면 요청이 0회다');

// 18 (러너). 진전 없음 중단 회차는 failed 사건이고 러너가 이어 가지 않으며, 다음 회차는 같은 항목을 다시 시도한다. (가짜 Worker 모드 전용)
if (FAKE_ONLY) {
  await reset();
  await storage.saveProfile({ ...await storage.getProfile(), syncKey: bigKey });
  await srv.ensureFamily(bigKey);
  await storage.saveLogs(Array.from({ length: 1200 }, (_, i) => ({ id: `rs-${i}`, type: 'formula', amount: 90, timestamp: 65_000 + i, updatedAt: 65_000 + i })));
  srv.state.rejectAllPushes = true;
  events = [];
  runner = makeRunner(events);
  r = await runner.request({ syncKey: bigKey });
  assert.equal(r.success, false);
  assert.equal(r.uploadStalled, true);
  assert.ok(!r.continuing, '결과에 continuing이 없다');
  await new Promise(res => setTimeout(res, 100)); // 이어 가기가 있다면 그 사이에 회차가 더 시작된다
  assert.equal(events.filter(e => e.type === 'started').length, 1, '러너는 이 회차를 이어 가지 않는다');
  assert.ok(events.some(e => e.type === 'failed' && e.error.includes('일부 기록을 올리지 못했습니다')), '러너 사건은 failed이고 문구가 실린다');
  assert.ok(!events.some(e => e.type === 'succeeded'), '성공 사건이 없다');
  const stalledPushes = (await syncRequests()).filter(x => x.pushLogs > 0);
  assert.equal(stalledPushes.length, 2, '올리기 요청은 두 묶음에서 멈춘다');
  mark = await srv.requestCount();
  r = await runner.request({ syncKey: bigKey });
  const retried = (await syncRequests(mark)).filter(x => x.pushLogs > 0);
  assert.ok(retried.length >= 1 && retried[0].pushLogs === stalledPushes[0].pushLogs, '다음 회차는 같은 항목부터 다시 시도한다');
  srv.state.rejectAllPushes = false;
  await reset();
  console.log('PASS 진전 없음 중단 회차는 failed 사건이고 이어 가지 않으며 다음 회차가 같은 항목을 다시 시도한다 (러너)');
}

// 14-2. 합치기: 회차가 도는 동안 들어온 평소 동기화는 대기 중인 다음 회차 하나로 합쳐진다.
await storage.saveProfile({ ...await storage.getProfile(), syncKey: runKey });
await srv.ensureFamily(runKey);
await storage.addLog({ type: 'formula', amount: 1, timestamp: 70_000 });
const gate = await srv.holdNext({ kind: 'sync' });
events = [];
runner = makeRunner(events);
const results = [runner.request({ syncKey: runKey })];
await gate.held; // 첫 회차의 요청이 서버에서 멈춰 있는 동안 저장을 다섯 번 한다
for (let i = 0; i < 5; i += 1) {
  await storage.addLog({ type: 'formula', amount: 2 + i, timestamp: 70_001 + i });
  results.push(runner.request({ syncKey: runKey }));
}
await gate.release();
const settled = await Promise.all(results);
assert.ok(settled.every(x => x.success), JSON.stringify(settled.map(x => x.error)));
assert.equal(events.filter(e => e.type === 'started').length, 2, '회차는 처음 것 하나와 합쳐진 것 하나, 모두 두 번');
assert.equal((await liveLogs(runKey)).length, 6);
console.log('PASS 평소 동기화가 합쳐져 회차가 두 번만 돌고 기록이 모두 올라간다');

// 7-1. 연결 회차: 첫 저장 뒤 다른 요청이 503이어도 키가 저장됐으면 성공이고 이어 간다.
const joinKey = '1'.repeat(32);
await reset();
await storage.saveLogs(Array.from({ length: 1200 }, (_, i) => ({ id: `jn-${i}`, type: 'formula', amount: 90, timestamp: 80_000 + i, updatedAt: 80_000 + i })));
await srv.failHttp({ status: 503, match: { kind: 'push', hasPushItems: true }, skip: 1, times: 1 });
events = [];
runner = makeRunner(events);
r = await runner.request({ syncKey: joinKey, createBackup: true, allowFamilyCreation: true, connecting: true });
assert.equal(r.success, true, r.error);
assert.equal(r.continuing, true);
assert.equal((await storage.getProfile()).syncKey, joinKey, '키가 저장돼 있다');
await waitFor(async () => (await liveLogs(joinKey)).length === 1200, '이어 간 평소 동기화가 남은 묶음을 모두 올리지 못했습니다');
assert.equal((await liveLogs(joinKey)).length, 1200, '이어 간 평소 동기화가 남은 묶음을 올린다');
console.log('PASS 연결 회차가 첫 저장 뒤 503으로 끝나도 성공이고 이어 가서 모두 올린다');

// 연결 회차 첫 요청부터 모두 실패하면 키가 저장되지 않고 실패다.
await reset();
await storage.saveLogs([{ id: 'x', type: 'formula', amount: 1, timestamp: 1, updatedAt: 1 }]);
await srv.failHttp({ status: 503, match: { kind: 'sync' }, times: 'always' });
events = [];
runner = makeRunner(events);
r = await runner.request({ syncKey: joinKey, createBackup: true, allowFamilyCreation: true, connecting: true });
assert.equal(r.success, false);
assert.equal((await storage.getProfile()).syncKey, undefined);
await srv.clearFaults();
console.log('PASS 첫 저장 전에 모두 실패하면 키가 저장되지 않고 실패다');

// 11. 404는 오류만 보이고 연결은 유지, 합류 중 404/410은 실패 문구.
await reset();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: runKey });
await storage.addLog({ type: 'formula', amount: 1, timestamp: 1 });
await srv.ensureFamily(runKey);
events = [];
runner = makeRunner(events);
assert.equal((await runner.request({ syncKey: runKey })).success, true);
await srv.removeFamily(runKey);
r = await runner.request({ syncKey: runKey });
assert.equal(r.success, false);
assert.equal(r.familyNotFound, true);
assert.equal((await storage.getProfile()).syncKey, runKey, '404로는 연결을 끊지 않는다');
assert.ok(events.some(e => e.type === 'failed' && e.error.includes('찾지 못했습니다')));
await srv.ensureFamily(runKey);
assert.equal((await runner.request({ syncKey: runKey })).success, true, '서버가 돌아오면 다시 이어진다');
console.log('PASS 404는 오류만 보이고 연결은 유지, 서버가 돌아오면 이어진다');

// 10. 410이면 연결을 끊고 기록은 남는다.
await srv.markGone(runKey);
events = [];
runner = makeRunner(events);
const logsBeforeGone = (await storage.getLogs()).length;
r = await runner.request({ syncKey: runKey });
assert.equal(r.success, false);
assert.equal((await storage.getProfile()).syncKey, undefined, '410이면 연결이 끊긴다');
assert.equal((await storage.getLogs()).length, logsBeforeGone, '기록은 그대로 남는다');
assert.ok(events.some(e => e.type === 'disconnected'));
console.log('PASS 410이면 연결을 끊고 기록은 그대로 남는다');

// 상한 뒤 연결 판정: 시간 예산 안에 끝나지 않고 상한이 먼저 오면, 저장된 키로 연결을 확정한다.
await reset();
await storage.saveLogs(Array.from({ length: 800 }, (_, i) => ({ id: `to-${i}`, type: 'formula', amount: 90, timestamp: 90_000 + i, updatedAt: 90_000 + i })));
// 서버에 도착한 세 번째 동기화 요청(전체 모드 당겨 받기, 올리기 두 번째)을 400ms 늦춘다.
const slowThird = await srv.delay({ kind: 'sync' }, 400, { skip: 2, times: 1 });
events = [];
runner = makeRunner(events, 150);
setSyncTimingForTests({ requestTimeoutMs: 1000 });
r = await runner.request({ syncKey: joinKey, createBackup: true, allowFamilyCreation: true, connecting: true });
setSyncTimingForTests({ requestTimeoutMs: 10_000 });
await slowThird.clear();
assert.equal(r.success, true, r.error);
assert.equal((await storage.getProfile()).syncKey, joinKey);
console.log('PASS 상한이 먼저 와도 저장소에 키가 남았으면 연결을 확정한다');

// 연결 도중 410(다른 기기가 영구 삭제): 결과는 실패이고 첫 저장으로 남은 키도 지운다.
await reset();
await storage.saveLogs(Array.from({ length: 800 }, (_, i) => ({ id: `gn-${i}`, type: 'formula', amount: 90, timestamp: 95_000 + i, updatedAt: 95_000 + i })));
events = [];
runner = makeRunner(events);
{
  // 두 번째 올리기 요청이 서버에서 멈춰 있는 동안 다른 기기가 가족을 영구 삭제한 것으로 만든다.
  const gate = await srv.holdNext({ kind: 'push', hasPushItems: true }, { skip: 1 });
  const pending = runner.request({ syncKey: joinKey, createBackup: true, allowFamilyCreation: true, connecting: true });
  await gate.held;
  await srv.markGone(joinKey);
  await gate.release();
  r = await pending;
}
assert.equal(r.success, false);
assert.equal((await storage.getProfile()).syncKey, undefined, '410이면 키가 남지 않는다');
assert.equal((await storage.getLogs()).length, 800);
console.log('PASS 연결 도중 410은 실패이고 키가 남지 않으며 기록은 그대로다');

if (realHarness) {
  await observe();
  console.log(`실제 서버 관측: 요청 ${observed.requests}건, 요청당 최대 쿼리 ${observed.maxQueries}회(한도 50), 최대 읽은 행 ${observed.maxRowsRead}, 최대 쓴 행 ${observed.maxRowsWritten}, `
    + `최대 Worker 처리 시간 ${observed.maxWorkerMs}ms(참고값), 최대 본문 ${observed.maxBodyBytes}바이트, 5xx 응답 ${observed.serverErrors}건(주입한 실패 포함)`);
  await realHarness.stop();
}
