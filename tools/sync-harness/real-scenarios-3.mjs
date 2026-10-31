// 실제 서버 모드 시나리오 3부(앱과 서버의 늦은 수정 검증). real-scenarios-1.mjs의 뼈대를 그대로 씁니다.
// 기기 이름은 모두 s3 접두어라서 저장 파일이 겹치지 않습니다.
//   C1. 전체 모드 회차의 마지막 당겨 받기 뒤, 올리기가 확정되기 전에 상대 기기가 쓴 기록을 같은 회차에 받는다.
//   D1. 삭제 확인(SELECT)을 통과한 뒤 배치 전에 삭제 취소가 확정되면 영구 삭제가 거부된다.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-3.mjs
//       HARNESS_ONLY=C1 bash tools/sync-harness/verify.sh scenario real-scenarios-3.mjs   (일부만)
import assert from 'node:assert/strict';
import { startRealHarness } from './real-harness.mjs';

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];

// ────────────── 시나리오 뼈대 ──────────────
const scenario = async (id, title, deviceNames, fn) => {
  if (ONLY && !ONLY.includes(id)) return;
  const started = Date.now();
  let harness = null;
  try {
    harness = await startRealHarness({ devices: deviceNames });
    const { server, devices } = harness;
    await fn({ harness, server, adapter: server.adapter, devices: deviceNames.map((name) => devices[name]) });
    results.push(true);
    console.log(`PASS [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)\n     ${error?.stack || error}`);
  } finally {
    await harness?.stop().catch(() => undefined);
  }
};

/** 바로 기다리지 않는 약속입니다. 시나리오가 중간에 실패해 정리되면서 거부돼도 처리되지 않은 거부로 하네스가 죽지 않게 표시만 합니다. */
const track = (promise) => {
  promise.catch(() => undefined);
  return promise;
};

// ────────────── 서버와 기기 도우미 ──────────────
const isFullPull = (r) => Boolean(r.pull) && r.pull.after[0] === 0 && r.pull.after[1] === '';
const newKey = async (device) => (await device.send('newFamilyKey')).key;
const clientIdOf = async (device) => (await device.send('getSyncClientId')).clientId;
const joinKey = (device, key) => device.send('setProfile', { patch: { syncKey: key } });
const createRound = (device, key, extra = {}) => device.send('syncWithCloud', { syncKey: key, allowFamilyCreation: true, ...extra });

/** 기기의 syncWithCloud를 한 번 돌립니다. 가족이 이미 연결된 기기용이라 가족 만들기는 하지 않습니다. */
async function sync(device, extra = {}) {
  const result = await device.send('syncWithCloud', { allowFamilyCreation: false, ...extra });
  assert.equal(result.success, true, `${device.name} 동기화 실패: ${result.error}`);
  return result;
}

/** 같은 id의 기록을 기기에 직접 넣습니다(addLog는 id를 새로 정하므로 id를 지정할 때는 이 도우미를 씁니다). */
async function putLog(device, log) {
  const { logs } = await device.send('getLogs');
  await device.send('saveLogs', { logs: [...logs.filter((l) => l.id !== log.id), log] });
}

const logOf = (id, extra = {}) => ({ id, type: 'formula', amount: 100, timestamp: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra });

// ════════════════════════════════ C1. 전체 모드 회차의 늦은 기록 ════════════════════════════════
await scenario('C1', '전체 모드 회차: 마지막 당겨 받기 뒤 올리기 확정 전에 B가 확정한 기록 X를 A의 그 한 회차가 받는다', ['s3A', 's3B'], async ({ adapter, devices: [A, B] }) => {
  const key = await newKey(A);
  const idA = await clientIdOf(A);
  const idB = await clientIdOf(B);

  // B가 가족을 만들고 기록 3건을 올려 둔다. A는 기록을 하나 갖고(올릴 것이 있어야 올리기 단계가 돈다) 처음 합류한다.
  await B.send('seedLogs', { count: 3, idPrefix: 'base', timestamp: 8_000_000 });
  const created = await createRound(B, key);
  assert.equal(created.success, true, `B의 가족 만들기 실패: ${created.error}`);
  await joinKey(A, key);
  await putLog(A, logOf('a-own', { amount: 55 }));
  // 멈춘 올리기 요청이 요청 상한(1초)에 걸리지 않도록 A의 상한과 회차 예산을 넉넉히 늘린다.
  await A.send('setTiming', { requestTimeoutMs: 8_000, cycleBudgetMs: 8_000, pullBudgetMs: 8_000 });

  // A의 첫 회차는 전체 모드다. 당겨 받기가 끝난 뒤의 올리기 요청(a-own을 담은 것)을 서버에서 멈춘다.
  const mark = await adapter.requestCount();
  const gate = await adapter.holdNext({ kind: 'push', clientId: idA, hasPushItems: true });
  const pending = track(A.send('syncWithCloud', { allowFamilyCreation: false }, { timeoutMs: 30_000 }));
  await gate.held;

  // 멈춘 사이 B가 기록 X를 올려 확정한다. A의 올리기는 아직 서버에 도착하지 않았다.
  await putLog(B, logOf('x-late', { amount: 77, timestamp: Date.now(), updatedAt: Date.now() }));
  await sync(B);
  assert.ok((await adapter.logs(key)).live.some(([id]) => id === 'x-late'), '전제: B의 기록 X가 서버에 확정됐다');
  assert.ok(!(await A.send('getLogs')).logs.some((l) => l.id === 'x-late'), '전제: 올리기가 멈춘 동안 A에는 아직 X가 없다');
  await gate.release();

  const round = await pending;
  assert.equal(round.success, true, `A의 회차 실패: ${round.error}`);
  assert.equal(round.continuing ?? false, false, '전제: A의 전체 모드와 올리기가 이 한 회차에 모두 끝났다');

  // 전제: A의 회차는 전체 모드 당겨 받기, 올리기, (고친 코드에서) 증분 당겨 받기 순서였고, 올리기가 변경 토큰을 A의 것으로 덮었다.
  const aRequests = (await adapter.requests(mark)).filter((r) => r.clientId === idA);
  assert.ok(aRequests.some(isFullPull), '전제: A가 전체 모드 당겨 받기를 했다');
  const pushIndex = aRequests.findIndex((r) => r.kind === 'push' && r.pushLogs > 0);
  assert.ok(pushIndex > 0, '전제: A가 당겨 받기 뒤에 기록을 올렸다');
  assert.ok(aRequests.slice(0, pushIndex).some((r) => r.kind === 'pull'), '전제: 올리기 앞에 당겨 받기가 있다');
  assert.ok((await adapter.family(key)).token.endsWith(`:${idA}`), '전제: 변경 토큰의 마지막 기록자가 A라서 A의 폴링은 B의 기록을 알아채지 못한다');
  assert.ok(!(await adapter.family(key)).token.endsWith(`:${idB}`));
  const ledger = (await A.send('readLedger')).ledger;
  assert.ok(!ledger.full, '전제: A의 전체 모드가 이 회차에 끝났다');

  // 판정: 그 한 회차가 끝났을 때 A의 저장소에 X가 있다. 폴링이나 다음 회차에 기대지 않는다.
  const stored = JSON.parse((await A.send('readStorage', { keys: ['@baby_logs'] })).items['@baby_logs']);
  assert.ok(stored.some((l) => l.id === 'x-late' && l.amount === 77), 'A의 그 한 회차가 끝났는데 저장소에 X가 없다');
  assert.ok(aRequests.slice(pushIndex + 1).some((r) => r.kind === 'pull' && !isFullPull(r)), 'A가 올리기 뒤에 증분 당겨 받기를 하지 않았다');
  // 올린 a-own은 서버에도 있고 B도 받는다.
  assert.ok((await adapter.logs(key)).live.some(([id]) => id === 'a-own'));
  await sync(B);
  assert.ok((await B.send('getLogs')).logs.some((l) => l.id === 'a-own'), 'B가 A의 기록을 받지 못했다');
});

// ════════════════════════════════ D1. 삭제 확인과 배치 사이의 삭제 취소 ════════════════════════════════
await scenario('D1', '영구 삭제: 냉각 확인을 통과한 뒤 배치 전에 삭제 취소가 확정되면 400 cooling_period_active이고 아무것도 지워지지 않는다', ['s3A', 's3B'], async ({ server, adapter, devices: [A, B] }) => {
  const key = await newKey(A);
  const idA = await clientIdOf(A);
  await A.send('seedLogs', { count: 4, idPrefix: 'keep', timestamp: 9_000_000 });
  assert.equal((await createRound(A, key)).success, true);
  await joinKey(B, key);
  await sync(B);
  const before = await adapter.family(key);
  assert.ok(before.members.length >= 2, '전제: 회원이 두 명이다');
  assert.equal((await adapter.logs(key)).live.length, 4);

  // 삭제를 예약하고 서버 시계를 냉각 시각 뒤로 보낸다. 이제 /delete의 앞쪽 확인(SELECT)을 통과할 수 있다.
  const scheduled = await A.send('scheduleDeletion');
  assert.equal(scheduled.success, true, `삭제 예약 실패: ${scheduled.error}`);
  await adapter.advanceClock(60 * 60_000 + 5_000);
  assert.equal((await A.send('deletionStatus')).canDeleteNow, true, '전제: 냉각 시각이 지났다');

  // /delete 요청을 SELECT 확인 뒤, 쓰기 배치 직전(BEGIN 전)에서 멈춘다. 기기 클라이언트의 요청 상한에 걸리지 않게 직접 요청한다.
  const gate = await adapter.holdNext({ kind: 'other', clientId: idA, batch: 'write' });
  const deleting = track(fetch(`${server.url}/api/family/delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': idA, 'Content-Type': 'application/json' },
    body: '{}',
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) })));
  await gate.held;

  // 멈춘 사이 다른 기기가 삭제 취소를 확정한다.
  const cancelled = await B.send('cancelDeletion');
  assert.equal(cancelled.success, true, `삭제 취소 실패: ${cancelled.error}`);
  assert.equal((await adapter.family(key)).pendingDeletionAt, null, '전제: 삭제 취소가 확정됐다');
  await gate.release();

  const response = await deleting;
  assert.equal(response.status, 400, `삭제 응답 상태가 400이 아니다: ${response.status} ${JSON.stringify(response.json)}`);
  assert.equal(response.json?.error, 'cooling_period_active');

  const after = await adapter.family(key);
  assert.equal(after.exists, true, '취소한 가족이 지워졌다');
  assert.equal(after.deleted, false, 'deleted_families에 삭제 기록이 남았다');
  assert.equal(after.members.length, before.members.length, '회원이 지워졌다');
  assert.equal((await adapter.logs(key)).live.length, 4, '기록이 지워졌다');
  const token = await A.send('rawToken');
  assert.equal(token.status, 200, `이후 token 요청이 200이 아니다: ${JSON.stringify(token)}`);
  assert.equal(token.ok, true);
  // 가족이 살아 있으므로 평소 동기화도 계속된다.
  await sync(A);
  await sync(B);
});

// ════════════════════════════════ 집계 ════════════════════════════════
const failed = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오 3부: ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
