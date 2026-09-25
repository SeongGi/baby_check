import assert from 'node:assert/strict';
import AsyncStorage from './stubs/async-storage.mjs';
import { state } from './stubs/fake-cloud.mjs';
import * as storage from '../../src/database/storage.ts';
import { syncWithCloud, parseFamilySyncId, deleteFamilyCloudData, scheduleFamilyDeletion, cancelFamilyDeletion } from '../../src/database/sync.ts';
import { withSyncDeadline } from '../../src/database/syncDeadline.ts';

const stalledToken = { aborted: false };
const stalled = withSyncDeadline(new Promise(() => {}), stalledToken, () => 'timeout', 5);
const queuedRetry = stalled.then(() => withSyncDeadline(Promise.resolve('retried'), { aborted: false }, () => 'timeout', 50));
assert.equal(await stalled, 'timeout');
assert.equal(stalledToken.aborted, true);
assert.equal(await queuedRetry, 'retried');
console.log('PASS 응답이 영원히 없어도 시간 초과 뒤 대기 중인 재시도 실행');

const key = 'a'.repeat(32);
await AsyncStorage.clear();
await storage.saveProfile({ ...await storage.getProfile(), syncKey: key, name: '테스트 아기' });
const first = await storage.addLog({ type: 'formula', amount: 100, timestamp: 1000 });
const sync = async token => syncWithCloud(key, await storage.getLogs(), await storage.getProfile(), false, token);
let result = await sync();
assert.equal(result.success, true);
assert.ok(state.commits.length >= 2);
for (const writes of state.commits) {
  assert.ok(writes.some(w => w.ref.path.split('/').length === 2), 'every data commit includes the family notification');
}
console.log('PASS 기록·프로필 변경과 알림을 같은 트랜잭션으로 저장');

state.commits.length = 0;
assert.equal((await sync()).success, true);
assert.equal(state.commits.length, 0);
console.log('PASS 변경 없는 동기화는 서버 쓰기 0회');

state.beforeRead = async () => {
  state.beforeRead = null;
  await storage.deleteLog(first.id);
};
assert.equal((await sync()).success, true);
const remoteLog = [...state.docs.entries()].find(([path]) => path.endsWith(`/logs/${first.id}`))[1];
assert.equal(remoteLog.deleted, true);
console.log('PASS 서버 응답 중 삭제한 기록도 같은 회차에 삭제 전파');

const beforeOffline = await storage.getLogs();
state.offline = true;
result = await sync();
assert.equal(result.success, false);
assert.deepEqual(await storage.getLogs(), beforeOffline);
state.offline = false;
assert.equal((await sync()).success, true);
console.log('PASS 오프라인에서 성공 오표시 없이 로컬 보존, 재연결 시 성공');

const token = { aborted: false };
state.beforeRead = async () => { token.aborted = true; state.beforeRead = null; };
state.commits.length = 0;
assert.equal((await sync(token)).success, false);
assert.equal(state.commits.length, 0);
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
const remoteBeforeFailure = JSON.stringify([...state.docs]);
state.beforeCommit = () => { throw new Error('injected commit failure'); };
assert.equal((await sync()).success, false);
assert.equal(JSON.stringify([...state.docs]), remoteBeforeFailure);
assert.ok((await storage.getLogs()).some(log => log.amount === 180));
state.beforeCommit = null;
assert.equal((await sync()).success, true);
console.log('PASS 커밋 실패 시 기록·알림 모두 미반영, 로컬 기록 재전송 성공');

// ────────────── 증분 동기화 ──────────────
// 기록이 쌓일수록 동기화 한 번이 기록 수만큼 읽기를 쓰면, 무료 등급 하루 읽기
// 한도(5만)가 소진되는 순간 두 보호자 모두 동기화가 통째로 멈춥니다.

const deltaKey = 'd'.repeat(32);
await AsyncStorage.clear();
state.docs.clear();
state.commits.length = 0;
state.reads.length = 0;
await storage.saveProfile({ ...await storage.getProfile(), syncKey: deltaKey, name: '증분 아기' });
const deltaSync = async (force = false) =>
  syncWithCloud(deltaKey, await storage.getLogs(), await storage.getProfile(), false, undefined, true, force);

for (let i = 0; i < 40; i += 1) {
  await storage.addLog({ type: 'formula', amount: 100 + i, timestamp: 1_000 + i });
}
// 1회차: 빈 가족이라 읽을 문서가 없고, 여기서 40건이 올라갑니다.
assert.equal((await deltaSync()).success, true);
// 2회차: 방금 올린 40건을 전부 읽으면서 증분 커서가 잡힙니다. 서버가 찍은
// 시각은 읽어 봐야 알 수 있어서, 새 가족은 한 회차 뒤부터 증분이 됩니다.
state.reads.length = 0;
assert.equal((await deltaSync()).success, true);
const firstReadCount = state.reads.at(-1).count;
assert.equal(state.reads.at(-1).constraints.length, 0, '커서가 없는 회차는 전체를 읽는다');
assert.equal(firstReadCount, 40);

state.reads.length = 0;
state.commits.length = 0;
assert.equal((await deltaSync()).success, true);
const idleReadCount = state.reads.at(-1).count;
assert.ok(state.reads.at(-1).constraints.length > 0, '두 번째 동기화는 증분 질의를 써야 한다');
assert.ok(idleReadCount < firstReadCount, `증분 읽기(${idleReadCount})가 전체 읽기(${firstReadCount})보다 적어야 한다`);
assert.equal(state.commits.length, 0, '변경이 없으면 증분 동기화도 쓰기가 없어야 한다');
console.log(`PASS 증분 동기화가 읽기를 줄인다 — 전체 ${firstReadCount}건 → 증분 ${idleReadCount}건, 쓰기 0회`);

// 증분 모드에서 "이번 응답에 없다"를 "서버에 없다"로 오해하면 기록 전체를
// 매번 다시 올려 쓰기 한도를 태웁니다.
state.commits.length = 0;
await storage.addLog({ type: 'urine', wetness: 'medium', color: 'normal', timestamp: 5_000 });
assert.equal((await deltaSync()).success, true);
const uploaded = state.commits.flat().filter(w => w.ref.path.includes('/logs/'));
assert.equal(uploaded.length, 1, `새 기록 1건만 올라가야 하는데 ${uploaded.length}건이 올라갔다`);
console.log('PASS 증분 모드에서 기존 기록을 다시 올리지 않는다 (쓰기 1회)');

// 상대 기기가 남긴 변경은 증분 응답에 반드시 포함되어야 합니다.
const remotePath = [...state.docs.keys()].find(p => p.includes('/logs/'));
const familyPath = remotePath.split('/logs/')[0];
state.docs.set(`${familyPath}/logs/from-partner`, {
  payload: { id: 'from-partner', type: 'formula', amount: 222, timestamp: 9_000, updatedAt: Date.now() + 1000 },
  deleted: false,
  updatedAt: Date.now() + 1000,
  updatedBy: 'partner-device',
});
assert.equal((await deltaSync()).success, true);
assert.ok((await storage.getLogs()).some(log => log.id === 'from-partner'), '상대 기기 기록이 증분으로 들어와야 한다');
console.log('PASS 상대 기기의 새 기록이 증분 읽기로 들어온다');

// 삭제는 updatedAt 을 남기지 않으면 증분 질의에 영영 안 걸립니다.
state.docs.set(`${familyPath}/logs/partner-deleted`, {
  payload: { id: 'partner-deleted', type: 'formula', amount: 5, timestamp: 9_500 },
  deleted: false,
  updatedAt: Date.now() + 2000,
  updatedBy: 'partner-device',
});
assert.equal((await deltaSync()).success, true);
assert.ok((await storage.getLogs()).some(log => log.id === 'partner-deleted'));
state.docs.set(`${familyPath}/logs/partner-deleted`, {
  ...state.docs.get(`${familyPath}/logs/partner-deleted`),
  deleted: true,
  updatedAt: Date.now() + 3000,
});
assert.equal((await deltaSync()).success, true);
assert.ok(!(await storage.getLogs()).some(log => log.id === 'partner-deleted'), '상대가 지운 기록은 증분으로 사라져야 한다');
console.log('PASS 상대 기기의 삭제가 증분 읽기로 전파된다');

// 내가 지운 기록의 삭제 표시에도 updatedAt 이 있어야 상대가 받습니다.
const mine = (await storage.getLogs()).find(log => log.type === 'urine');
await storage.deleteLog(mine.id);
assert.equal((await deltaSync()).success, true);
const tombstone = state.docs.get(`${familyPath}/logs/${mine.id}`);
assert.equal(tombstone.deleted, true);
assert.ok(typeof tombstone.updatedAt === 'number' && tombstone.updatedAt > 0,
  '삭제 표시에 updatedAt 이 없으면 상대 기기가 증분 질의로 삭제를 못 받는다');
console.log('PASS 삭제 표시에 updatedAt 을 남겨 상대가 증분으로 받을 수 있다');

// 삭제 표시를 한 번 올린 뒤에는 같은 삭제를 매번 다시 쓰지 않아야 합니다.
state.commits.length = 0;
assert.equal((await deltaSync()).success, true);
assert.equal(state.commits.length, 0, '이미 올린 삭제 표시를 다시 쓰면 안 된다');
console.log('PASS 이미 전파된 삭제를 반복해서 다시 쓰지 않는다');

// 장부가 사라져도(앱 재설치·저장소 손상) 전체 읽기로 안전하게 되돌아가야 합니다.
await AsyncStorage.removeItem('@baby_sync_ledger_v1');
state.reads.length = 0;
assert.equal((await deltaSync()).success, true);
assert.equal(state.reads.at(-1).constraints.length, 0, '장부가 없으면 전체를 읽어야 한다');
const afterLedgerLoss = await storage.getLogs();
assert.ok(afterLedgerLoss.some(log => log.id === 'from-partner'));
assert.ok(!afterLedgerLoss.some(log => log.id === 'partner-deleted'));
console.log('PASS 장부가 사라지면 전체 읽기로 되돌아가고 기록은 그대로다');

// 당겨서 새로고침은 증분을 건너뛰고 전체를 대조합니다.
state.reads.length = 0;
assert.equal((await deltaSync(true)).success, true);
assert.equal(state.reads.at(-1).constraints.length, 0, '강제 새로고침은 전체를 읽어야 한다');
console.log('PASS 당겨서 새로고침은 전체 대조로 동작한다');

// 서버가 더 최신이면 장부에 "올렸다"고 적으면 안 됩니다. 그러면 내 수정이
// 영영 안 올라가고 두 기기가 서로 다른 값으로 갈라집니다.
// 계획을 세운 뒤 커밋 직전에 상대가 먼저 쓴 경우를 재현합니다.
const racer = (await storage.getLogs()).find(log => log.id === 'from-partner');
await storage.updateLog({ ...racer, amount: 111 });
state.beforeTransaction = () => {
  state.beforeTransaction = null;
  state.docs.set(`${familyPath}/logs/from-partner`, {
    payload: { ...racer, amount: 999, updatedAt: Date.now() + 60_000 },
    deleted: false,
    updatedAt: Date.now() + 60_000,
    updatedBy: 'partner-device',
  });
};
assert.equal((await deltaSync()).success, true);
const ledgerAfter = JSON.parse(await AsyncStorage.getItem('@baby_sync_ledger_v1'));
assert.ok(!('from-partner' in ledgerAfter.uploaded),
  '서버가 더 최신이라 못 올린 기록을 장부에 "올렸다"고 적으면 내 수정이 영영 안 올라간다');
assert.equal(ledgerAfter.lastFullReadAt, 0, '밀린 기록이 있으면 다음 회차는 전체 대조여야 한다');
console.log('PASS 커밋 직전에 밀린 기록은 장부에 기록하지 않고 다음 회차에 전체 대조한다');

// 전체 대조 회차에서 서버의 최신 값을 받아 두 기기가 수렴해야 합니다.
state.reads.length = 0;
assert.equal((await deltaSync()).success, true);
assert.equal(state.reads.at(-1).constraints.length, 0, '밀린 뒤 회차는 전체를 읽어야 한다');
assert.equal((await storage.getLogs()).find(log => log.id === 'from-partner').amount, 999,
  '전체 대조 뒤에는 서버의 최신 값으로 수렴해야 한다');
console.log('PASS 밀린 다음 회차의 전체 대조로 두 기기가 수렴한다');

// 가족 데이터 영구 삭제는 예약(냉각 기간)을 먼저 걸어야 하고, 예약만으로는
// 문서가 지워지면 안 됩니다.
const scheduleOutcome = await scheduleFamilyDeletion(deltaKey);
assert.equal(scheduleOutcome.success, true, scheduleOutcome.error);
assert.ok(typeof scheduleOutcome.readyAt === 'number' && scheduleOutcome.readyAt > Date.now(),
  '삭제 예약은 냉각 기간 이후의 미래 시각을 반환해야 한다');
assert.ok(state.docs.get(familyPath)?.pendingDeletionAt,
  '가족 문서에 삭제 예약 시각이 저장돼야 한다');
assert.ok([...state.docs.keys()].some(p => p.startsWith(`${familyPath}/logs/`)),
  '예약만으로는 기록이 지워지면 안 된다');
console.log('PASS 가족 데이터 영구 삭제는 예약 시 즉시 실행되지 않고 냉각 기간을 둔다');

// 예약을 취소하면 표시가 지워져야 합니다.
const cancelOutcome = await cancelFamilyDeletion(deltaKey);
assert.equal(cancelOutcome.success, true, cancelOutcome.error);
assert.equal(state.docs.get(familyPath)?.pendingDeletionAt, null,
  '취소 후에는 삭제 예약 표시가 남아 있으면 안 된다');
console.log('PASS 삭제 예약을 취소하면 표시가 지워진다');

// 가족 데이터 영구 삭제는 그 가족 경로의 모든 문서(기록·회원·프로필·가족 문서)를 지워야 합니다.
// (가짜 클라우드는 firestore.rules를 평가하지 않으므로, 여기서는 냉각 기간이
// 지난 뒤 클라이언트가 실제로 batch delete를 수행하는지만 검증합니다. 냉각
// 기간이 지나기 전에는 규칙이 delete 자체를 거부한다는 서버 쪽 보장은
// firestore.rules 파일과 별도로 확인해야 합니다.)
assert.ok([...state.docs.keys()].some(p => p.startsWith(`${familyPath}/`)),
  '삭제 전에는 가족 경로에 문서가 남아 있어야 한다');
const deleteOutcome = await deleteFamilyCloudData(deltaKey);
assert.equal(deleteOutcome.success, true, deleteOutcome.error);
assert.equal([...state.docs.keys()].filter(p => p === familyPath || p.startsWith(`${familyPath}/`)).length, 0,
  '가족 데이터 영구 삭제 후에는 그 가족 경로에 문서가 하나도 남으면 안 된다');
console.log('PASS 가족 데이터 영구 삭제가 기록·회원·프로필·가족 문서를 모두 지운다');

// 잘못된 키로는 삭제를 시도하지 않아야 합니다.
const invalidDelete = await deleteFamilyCloudData('bad key!!');
assert.equal(invalidDelete.success, false);
console.log('PASS 잘못된 가족 키로는 영구 삭제가 실행되지 않는다');
