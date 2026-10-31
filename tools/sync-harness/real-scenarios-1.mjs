// 실제 서버 모드 시나리오 1부(06 설계 5.1의 1, 1-a, 1-b, 2, 2-a, 3, 4, 5, 5-a, 6, 6-a, 7, 7-1).
// 실제 Worker 코드(server/src/index.ts)를 서버 프로세스로 띄우고, 기기마다 프로세스를 따로 띄워 요청합니다.
// 8번 이후는 real-scenarios-2.mjs가 맡습니다. 기기 이름은 모두 s1 접두어라서 저장 파일이 겹치지 않습니다.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-1.mjs
//       HARNESS_ONLY=1,5-a bash tools/sync-harness/verify.sh scenario real-scenarios-1.mjs   (일부만)
//
// 기기는 요청 상한 1000ms, 당겨 받기 예산 600ms, 회차 예산 800ms, 러너 상한 2000ms(실제의 10분의 1)로 돕니다.
// 시나리오마다 서버와 기기를 새로 띄워서 서로 상태를 공유하지 않습니다.
import assert from 'node:assert/strict';
import { startRealHarness, selfCheckDevices, selfCheckMembers } from './real-harness.mjs';

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_BODY_BYTES = 1024 * 1024;
const LOGS_KEY = '@baby_logs';
const PROFILE_KEY = '@baby_profile';

// ────────────── 시나리오 뼈대 ──────────────
const scenario = async (id, title, deviceNames, fn) => {
  if (ONLY && !ONLY.includes(id.split('/')[0]) && !ONLY.includes(id)) return;
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

const waitUntil = async (predicate, what, timeoutMs = 30_000, stepMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`시간 안에 ${what}`);
    await sleep(stepMs);
  }
};

/** 바로 기다리지 않는 약속입니다. 시나리오가 중간에 실패해 정리되면서 거부돼도 처리되지 않은 거부로 하네스가 죽지 않게 표시만 합니다. */
const track = (promise) => {
  promise.catch(() => undefined);
  return promise;
};

// ────────────── 서버와 기기 도우미 ──────────────
const isFullPull = (r) => Boolean(r.pull) && r.pull.after[0] === 0 && r.pull.after[1] === '';
const syncRequests = (reqs) => reqs.filter((r) => r.kind === 'push' || r.kind === 'pull');
const pushRequests = (reqs) => reqs.filter((r) => r.kind === 'push');
const sum = (items, pick) => items.reduce((n, item) => n + pick(item), 0);
const sortedUnique = (ids) => [...new Set(ids)].sort();
const byId = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const newKey = async (device) => (await device.send('newFamilyKey')).key;
const clientIdOf = async (device) => (await device.send('getSyncClientId')).clientId;
const joinKey = (device, key) => device.send('setProfile', { patch: { syncKey: key } });
const eventsOf = async (device) => (await device.send('runnerEvents', {})).events;
const profileOf = async (device) => (await device.send('getProfile')).profile;
const ledgerOf = async (device) => (await device.send('readLedger')).ledger;
const storedProfile = async (device) => {
  const raw = (await device.send('readStorage', { keys: [PROFILE_KEY] })).items[PROFILE_KEY];
  return raw ? JSON.parse(raw) : null;
};
const logSetOf = async (device) => (await device.send('logSet')).pairs;
const livePairs = async (adapter, key) => (await adapter.logs(key)).live;
const deletedOnServer = async (adapter, key) => (await adapter.logs(key)).deleted;

/** 기기의 syncWithCloud를 한 번 돌립니다. 가족이 이미 연결된 기기용이라 가족 만들기는 하지 않습니다. */
async function sync(device, extra = {}) {
  const result = await device.send('syncWithCloud', { allowFamilyCreation: false, ...extra });
  assert.equal(result.success, true, `${device.name} 동기화 실패: ${result.error}`);
  return result;
}

/** continuing이 끝날 때까지 회차를 반복합니다. 회차마다 성공이어야 합니다. */
async function syncUntilDone(device, extra = {}, max = 40) {
  const rounds = [];
  for (let i = 0; i < max; i += 1) {
    const result = await sync(device, extra);
    rounds.push(result);
    if (!result.continuing) return rounds;
  }
  throw new Error(`${device.name}이 ${max}회차 안에 끝나지 않았습니다`);
}

/** 새 가족을 만드는 첫 회차입니다. 결과를 그대로 돌려줍니다. */
const createRound = (device, key, extra = {}) => device.send('syncWithCloud', { syncKey: key, allowFamilyCreation: true, ...extra });

/** 러너의 사건이 한동안 늘지 않고 마지막 사건이 끝 사건일 때까지 기다립니다(이어 가기가 모두 끝남). */
async function settleRunner(device, quietMs = 700) {
  let lastCount = -1;
  let since = Date.now();
  await waitUntil(async () => {
    const events = await eventsOf(device);
    const last = events.at(-1)?.type;
    if (events.length !== lastCount) { lastCount = events.length; since = Date.now(); return false; }
    return last !== 'started' && last !== undefined && Date.now() - since >= quietMs;
  }, `${device.name} 러너가 멈추지 않았습니다`, 60_000, 50);
}

/** 두 집합의 (id, canonical JSON) 쌍이 정확히 같은지 확인합니다. */
function assertSamePairs(labelA, a, labelB, b) {
  const ma = new Map(a);
  const mb = new Map(b);
  const onlyA = [...ma.keys()].filter((k) => !mb.has(k));
  const onlyB = [...mb.keys()].filter((k) => !ma.has(k));
  const differ = [...ma.keys()].filter((k) => mb.has(k) && ma.get(k) !== mb.get(k));
  assert.ok(
    onlyA.length === 0 && onlyB.length === 0 && differ.length === 0,
    `${labelA}(${ma.size})와 ${labelB}(${mb.size})의 기록 집합이 다릅니다: ${labelA}에만 ${onlyA.length}, ${labelB}에만 ${onlyB.length}, 내용 다름 ${differ.length} ${JSON.stringify({ onlyA: onlyA.slice(0, 3), onlyB: onlyB.slice(0, 3), differ: differ.slice(0, 3) })}`,
  );
}

function assertSameIds(labelA, a, labelB, b) {
  const sa = sortedUnique(a);
  const sb = sortedUnique(b);
  assert.deepEqual(sa, sb, `${labelA}(${sa.length})와 ${labelB}(${sb.length})의 id 집합이 다릅니다`);
}

const logOf = (id, extra = {}) => ({ id, type: 'formula', amount: 100, timestamp: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra });

/** 같은 id의 기록을 기기에 직접 넣습니다(상대 기기에서 받은 것과 같은 상태를 만듭니다). */
async function putLog(device, log) {
  const { logs } = await device.send('getLogs');
  await device.send('saveLogs', { logs: [...logs.filter((l) => l.id !== log.id), log] });
}

const rawConnect = async (server, key, clientId) => {
  const response = await fetch(`${server.url}/api/family/connect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowCreate: true }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

// ════════════════════════════════ 1. 500건 초과 ════════════════════════════════
await scenario('1', '500건 초과: 기록 1,200건과 삭제 표식 300건이 묶음으로 올라가고 합류한 기기가 모두 받는다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  await A.send('seedLogs', { count: 1200, idPrefix: 'bulk', timestamp: 1_000_000 });
  await A.send('seedTombstones', { count: 300, idPrefix: 'gone' });

  // 올리기를 묶음마다 300ms 늦춰서 첫 회차(예산 800ms)가 반드시 continuing으로 끝나게 합니다. 러너의 이어 가기를 본다.
  const slow = await adapter.delay({ kind: 'push' }, 300);
  const first = await A.send('runnerRequest', { request: { syncKey: key, createBackup: true, allowFamilyCreation: true, connecting: true } });
  assert.equal(first.success, true, `가족 만들기 실패: ${first.error}`);
  assert.equal(first.continuing, true, '전제: 첫 회차가 continuing: true로 끝나야 러너의 이어 가기를 볼 수 있다');

  // 사용자 동작은 위 요청 하나뿐이다. 나머지 묶음은 러너가 스스로 이어 가서 올려야 한다.
  await waitUntil(async () => {
    const logs = await adapter.logs(key);
    return logs.live.length === 1200 && logs.deleted.length === 300;
  }, '기록 1,200건과 삭제 표식 300건이 서버에 모두 올라가지 않았습니다');
  await settleRunner(A);
  await slow.clear();

  const events = await eventsOf(A);
  assert.ok(events.some((e) => e.type === 'succeeded' && e.continuation === true), `러너가 이어 간 회차가 없다: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.ok(!events.some((e) => e.type === 'failed'), `러너 사건에 실패가 있다: ${JSON.stringify(events.filter((e) => e.type === 'failed'))}`);

  const reqs = syncRequests(await adapter.requests());
  const pushes = pushRequests(reqs);
  assert.ok(pushes.length >= 4, `올리기 묶음이 ${pushes.length}개뿐이다`);
  for (const r of pushes) {
    assert.ok(r.pushLogs + r.pushDeleted <= 500, `묶음이 500건을 넘었다: ${r.pushLogs + r.pushDeleted}`);
    assert.ok(r.bodyBytes <= MAX_BODY_BYTES, `묶음 본문이 1MB를 넘었다: ${r.bodyBytes}`);
  }
  for (const r of reqs) assert.equal(r.status, 200, `요청 ${r.seq}(${r.kind})의 응답 상태가 ${r.status}`);
  assert.equal(sum(pushes, (r) => r.pushLogs), 1200, '기록이 한 번씩만 올라가야 한다');
  assert.equal(sum(pushes, (r) => r.pushDeleted), 300, '삭제 표식이 한 번씩만 올라가야 한다');
  // 새 기록과 삭제 표식 삽입은 한 건에 logs 2행(테이블 + 인덱스)이다. 보통 테이블이면 3행이 되어 실패한다.
  for (const r of pushes) {
    assert.equal(r.writtenByTable.logs, 2 * (r.pushLogs + r.pushDeleted), `새 항목 삽입의 쓴 행 수가 항목당 2행이 아니다: 묶음 ${r.pushLogs + r.pushDeleted}건에 ${r.writtenByTable.logs}행`);
  }
  assert.equal(sum(pushes, (r) => r.writtenByTable.logs), 3000);

  // 합류한 두 번째 기기가 모두 받는다.
  await joinKey(B, key);
  const joined = await B.send('runnerRequest', { request: { syncKey: key } });
  assert.equal(joined.success, true, `합류 실패: ${joined.error}`);
  await waitUntil(async () => (await logSetOf(B)).length === 1200, 'B가 기록 1,200건을 모두 받지 못했습니다');
  await settleRunner(B);
  const serverLive = await livePairs(adapter, key);
  assertSamePairs('A', await logSetOf(A), '서버', serverLive);
  assertSamePairs('B', await logSetOf(B), '서버', serverLive);
  const deleted = await deletedOnServer(adapter, key);
  assertSameIds('A의 삭제 id', (await profileOf(A)).deletedLogIds, '서버', deleted);
  assertSameIds('B의 삭제 id', (await profileOf(B)).deletedLogIds, '서버', deleted);
  assert.equal(deleted.length, 300);
  await selfCheckMembers(harness, key);
});

// ════════════════════════════════ 1-a. 바이트 묶음 ════════════════════════════════
await scenario('1-a', '바이트 묶음: 한글 메모 400건(약 1.2MB)이 413 없이 모두 올라간다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  const notes = '가'.repeat(1000);
  assert.equal(notes.length, 1000);
  assert.equal(Buffer.byteLength(notes), 3000);
  await A.send('seedLogs', { count: 400, idPrefix: 'kor', timestamp: 1_000_000, notes });
  const first = await A.send('runnerRequest', { request: { syncKey: key, createBackup: true, allowFamilyCreation: true, connecting: true }, timeoutMs: 10_000 });
  assert.equal(first.success, true, `가족 만들기 실패: ${first.error}`);
  await waitUntil(async () => (await adapter.logs(key)).live.length === 400, '기록 400건이 서버에 모두 올라가지 않았습니다');
  await settleRunner(A);

  const reqs = await adapter.requests();
  const pushes = pushRequests(reqs);
  assert.equal(reqs.filter((r) => r.status === 413).length, 0, '413이 나면 안 된다');
  for (const r of syncRequests(reqs)) assert.equal(r.status, 200, `요청 ${r.seq}의 응답 상태가 ${r.status}`);
  // 전제: 400건 전체는 1MB를 넘어서 한 묶음으로 보낼 수 없다.
  assert.ok(sum(pushes, (r) => r.bodyBytes) > MAX_BODY_BYTES, '전제: 모든 묶음의 본문 합이 1MB를 넘어야 한다');
  assert.ok(pushes.length >= 2, `전제: 바이트로 잘라 두 묶음 이상이어야 한다(${pushes.length}개)`);
  for (const r of pushes) assert.ok(r.bodyBytes <= MAX_BODY_BYTES, `묶음 본문이 1MB를 넘었다: ${r.bodyBytes}`);
  assert.equal(sum(pushes, (r) => r.pushLogs), 400, '기록이 한 번씩만 올라가야 한다');
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));
});

// ════════════════════════════════ 1-b. 느린 서버 ════════════════════════════════
await scenario('1-b', '느린 서버: 올리기가 요청 상한의 60%씩 늦어도 첫 회차가 continuing으로 끝나고 상한 실패가 없다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  await A.send('seedLogs', { count: 2400, idPrefix: 'slow', timestamp: 1_000_000 });
  const timing = await A.send('getTiming');
  const delayMs = Math.round(timing.requestTimeoutMs * 0.6);
  assert.equal(delayMs, 600);
  const slow = await adapter.delay({ kind: 'push' }, delayMs);
  const started = Date.now();
  const first = await A.send('runnerRequest', { request: { syncKey: key, createBackup: true, allowFamilyCreation: true, connecting: true } });
  const firstMs = Date.now() - started;
  assert.equal(first.success, true, `가족 만들기 실패: ${first.error}`);
  assert.equal(first.continuing, true, '첫 회차의 결과가 continuing: true여야 한다');
  // 시간 예산이 있으면 첫 회차는 두 묶음(0, 0.6초 시작)만 보내고 1.2초쯤 끝난다. 예산이 없으면 러너 상한(2초)에 걸린다.
  assert.ok(firstMs < 1850, `첫 회차가 러너 상한 가까이 걸렸다: ${firstMs}ms`);
  await waitUntil(async () => (await adapter.logs(key)).live.length === 2400, '기록 2,400건이 서버에 모두 올라가지 않았습니다');
  await settleRunner(A);
  await slow.clear();

  const events = await eventsOf(A);
  assert.ok(!events.some((e) => e.type === 'failed'), `러너 사건에 상한 때문에 생긴 failed가 있다: ${JSON.stringify(events.filter((e) => e.type === 'failed'))}`);
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ['started', 'succeeded']);
  const pushes = pushRequests(await adapter.requests());
  for (const r of pushes) assert.equal(r.status, 200);
  assert.ok(pushes.every((r) => r.held), '전제: 모든 올리기 요청이 늦춰졌다');
  assert.equal(sum(pushes, (r) => r.pushLogs), 2400, '기록이 한 번씩만 올라가야 한다');
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));
});

// ════════════════════════════════ 2. 3,000건 전체 대조 ════════════════════════════════
await scenario('2', '3,000건 전체 대조: 여러 페이지, 여러 회차에 걸친 전체 모드 뒤 두 기기와 서버의 집합이 정확히 같다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  const idB = await clientIdOf(B);
  await A.send('seedLogs', { count: 3000, idPrefix: 'big', timestamp: 1_000_000 });
  await A.send('seedTombstones', { count: 100, idPrefix: 'gone' });
  const created = await A.send('runnerRequest', { request: { syncKey: key, createBackup: true, allowFamilyCreation: true, connecting: true } });
  assert.equal(created.success, true, `가족 만들기 실패: ${created.error}`);
  await waitUntil(async () => {
    const logs = await adapter.logs(key);
    return logs.live.length === 3000 && logs.deleted.length === 100;
  }, 'A의 기록 3,000건이 서버에 모두 올라가지 않았습니다');
  await settleRunner(A);

  // B는 자기 기록 20건과 삭제 표식 5건을 갖고 합류한다. 전체 모드가 여러 회차에 걸치게 당겨 받기 예산을 줄이고,
  // 회차 예산은 늘려서 예산을 넘긴 뒤에도 같은 회차에 올리기를 하게 한다.
  await B.send('seedLogs', { count: 20, idPrefix: 'bown', timestamp: 2_000_000 });
  await B.send('seedTombstones', { count: 5, idPrefix: 'bgone' });
  await joinKey(B, key);
  await B.send('setTiming', { pullBudgetMs: 300, cycleBudgetMs: 3000 });
  const bFirstLog = (await B.send('addLog', { log: { type: 'formula', amount: 71, timestamp: Date.now() } })).saved;
  assert.ok(bFirstLog?.id);

  const markB = await adapter.requestCount();
  const gate = await adapter.holdNext({ kind: 'pull', clientId: idB }, { skip: 1 });
  const pending = track(B.send('syncWithCloud', { allowFamilyCreation: false }));
  await gate.held;
  await sleep(400);
  // 전체 모드 당겨 받기 도중(두 번째 페이지를 기다리는 사이)에 새 기록을 만든다.
  const bSecondLog = (await B.send('addLog', { log: { type: 'formula', amount: 72, timestamp: Date.now() } })).saved;
  assert.ok(bSecondLog?.id);
  await gate.release();
  const round1 = await pending;
  assert.equal(round1.success, true, `B의 첫 회차 실패: ${round1.error}`);
  assert.equal(round1.continuing, true, '전제: B의 전체 모드가 첫 회차에 끝나지 않고 continuing이어야 한다');
  const ledger1 = await ledgerOf(B);
  assert.ok(ledger1?.full, '전제: 첫 회차 뒤 장부에 진행 중인 전체 모드(full)가 남아 있어야 한다');
  // 전체 모드가 끝나기 전인데도 B가 만든 기록이 같은 회차에 올라가야 한다.
  const liveIds = new Set((await livePairs(adapter, key)).map(([id]) => id));
  assert.ok(liveIds.has(bFirstLog.id), '전체 모드 전에 만든 기록이 첫 회차에 올라가지 않았다');
  assert.ok(liveIds.has(bSecondLog.id), '전체 모드 도중에 만든 기록이 같은 회차에 올라가지 않았다');
  for (let i = 0; i < 20; i += 1) assert.ok(liveIds.has(`bown-${i}`), `B의 기록 bown-${i}가 첫 회차에 올라가지 않았다`);

  const rest = await syncUntilDone(B, {});
  assert.ok(rest.length >= 1);
  const ledgerDone = await ledgerOf(B);
  assert.ok(!ledgerDone.full && ledgerDone.cursorMillis > 0, '전체 모드가 끝나 장부가 바뀌어야 한다');
  const bPulls = (await adapter.requests(markB)).filter((r) => r.kind === 'pull' && r.clientId === idB);
  assert.ok(bPulls.length >= 7, `B의 당겨 받기 요청이 여러 페이지로 나뉘어야 한다(${bPulls.length}개)`);
  assert.equal(bPulls.filter(isFullPull).length >= 1, true);
  // B가 올린 기록은 자기 기록 22건뿐이어야 한다. 페이지로 받은 기록을 다시 올리지 않는다.
  const bPushes = (await adapter.requests(markB)).filter((r) => r.kind === 'push' && r.clientId === idB);
  assert.equal(sum(bPushes, (r) => r.pushLogs), 22, 'B가 받은 기록을 다시 올렸다');
  assert.equal(sum(bPushes, (r) => r.pushDeleted), 5);

  // A도 증분 회차로 B의 기록을 받는다.
  await syncUntilDone(A, {});
  await syncUntilDone(B, {});
  await syncUntilDone(A, {});
  const serverLive = await livePairs(adapter, key);
  assert.equal(serverLive.length, 3022);
  assertSamePairs('A', await logSetOf(A), '서버', serverLive);
  assertSamePairs('B', await logSetOf(B), '서버', serverLive);
  const deleted = await deletedOnServer(adapter, key);
  assert.equal(deleted.length, 105);
  assertSameIds('A의 삭제 id', (await profileOf(A)).deletedLogIds, '서버', deleted);
  assertSameIds('B의 삭제 id', (await profileOf(B)).deletedLogIds, '서버', deleted);
  await selfCheckMembers(harness, key);
});

// ════════════════════════════════ 2-a. 합류 기기의 재전송 ════════════════════════════════
await scenario('2-a', '합류 기기의 재전송: 전체 모드가 두 회차 이상에 걸쳐도 받은 기록을 다시 올리지 않는다', ['s1C'], async ({ server, adapter, devices: [C] }) => {
  const key = await newKey(C);
  const idC = await clientIdOf(C);
  // 3,000건 가족을 서버에 바로 만든다(다른 기기가 올린 상태). 기록이 없는 C가 합류한다.
  const base = Date.now() - 10 * 60_000;
  await server.control('inject', {
    key,
    serverTime: base,
    logs: Array.from({ length: 3000 }, (_, i) => logOf(`join-${i}`, { timestamp: 1_000_000 + i, updatedAt: 1_000_000 + i })),
  });
  assert.equal((await adapter.logs(key)).live.length, 3000);
  await joinKey(C, key);
  // 페이지 응답을 200ms씩 늦추고 당겨 받기 예산을 줄여서 두 페이지마다 회차가 끝나게 한다. 회차 예산 안에서 올리기 단계까지 간다.
  await C.send('setTiming', { pullBudgetMs: 300 });
  const slow = await adapter.delay({ kind: 'pull', clientId: idC }, 200);
  const mark = await adapter.requestCount();
  const rounds = [];
  for (let i = 0; i < 40; i += 1) {
    const fromSeq = await adapter.requestCount();
    const result = await sync(C);
    const ledger = await ledgerOf(C);
    rounds.push({ continuing: result.continuing, fullLeft: Boolean(ledger?.full), requests: (await adapter.requests(fromSeq)).filter((r) => r.clientId === idC) });
    if (!result.continuing) break;
  }
  await slow.clear();
  const fullRounds = rounds.filter((r, i) => r.fullLeft || i === rounds.findIndex((x) => !x.fullLeft));
  assert.ok(fullRounds.length >= 2, `전제: C의 전체 모드가 두 회차 이상에 걸쳐야 한다(${fullRounds.length}회차)`);
  assert.equal(rounds[0].continuing, true);
  assert.equal(rounds[0].fullLeft, true, '전제: 첫 회차 뒤에도 전체 모드가 남아 있어야 한다');
  // 전체 모드를 마칠 때까지 C의 올리기 요청에 담긴 기록 수가 0이다.
  const cRequests = (await adapter.requests(mark)).filter((r) => r.clientId === idC);
  const pushesWithLogs = cRequests.filter((r) => r.kind === 'push' && r.pushLogs > 0);
  assert.equal(pushesWithLogs.length, 0, `C가 받은 기록을 다시 올렸다: ${pushesWithLogs.map((r) => r.pushLogs).join(',')}건`);
  assert.equal(sum(cRequests, (r) => r.logWrites), 0);
  assertSamePairs('C', await logSetOf(C), '서버', await livePairs(adapter, key));
  assert.equal((await logSetOf(C)).length, 3000);
});

// ════════════════════════════════ 3. 장부 정확성 ════════════════════════════════
await scenario('3', '장부 정확성: 올리기 응답을 기다리는 동안 추가, 수정, 삭제한 기록이 올림으로 적히지 않고 다음 회차에 올라간다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  const idA = await clientIdOf(A);
  await A.send('seedLogs', { count: 3, idPrefix: 'led', timestamp: 3_000_000 });
  const original = (await A.send('getLogs')).logs;
  const P = original.find((l) => l.id === 'led-0');
  const Q = original.find((l) => l.id === 'led-1');
  const created = await createRound(A, key);
  assert.equal(created.success, true, created.error);
  await joinKey(B, key);
  await sync(B);
  await sync(A);
  const ledger0 = await ledgerOf(A);
  assert.equal(ledger0.uploaded[P.id], 3_000_000);
  assert.ok(ledger0.tombstoned !== undefined);

  // 올릴 기록 N0 하나를 두고, 그 올리기 요청이 서버에서 기다리는 동안 추가, 수정, 삭제를 한다.
  const N0 = (await A.send('addLog', { log: { type: 'formula', amount: 11, timestamp: Date.now() } })).saved;
  // M도 같은 묶음에 담겨 서버로 가는 기록이다. 응답을 기다리는 동안 M을 고치면 올림으로 적히면 안 된다(설계 2.6.1의 2번).
  const M = (await A.send('addLog', { log: { type: 'formula', amount: 33, timestamp: Date.now() } })).saved;
  // 회차 예산을 300ms로 줄여서, 멈춘 요청이 끝나면 회차가 곧바로 끝나게 한다(같은 회차의 다음 묶음으로 올라가는 경로를 막는다).
  await A.send('setTiming', { cycleBudgetMs: 300 });
  const gate = await adapter.holdNext({ kind: 'push', clientId: idA });
  const pending = track(A.send('syncWithCloud', { allowFamilyCreation: false }));
  await gate.held;
  const N1 = (await A.send('addLog', { log: { type: 'formula', amount: 22, timestamp: Date.now() } })).saved;
  await sleep(15);
  await A.send('updateLog', { log: { ...P, amount: 777 } });
  await A.send('deleteLog', { id: Q.id });
  await sleep(15);
  await A.send('updateLog', { log: { ...M, amount: 888 } });
  const editedM = (await A.send('getLogs')).logs.find((l) => l.id === M.id);
  assert.equal(editedM.amount, 888, '전제: 멈춘 묶음 안의 기록 M이 응답 전에 고쳐졌다');
  assert.ok(editedM.updatedAt > (M.updatedAt || M.timestamp), '전제: 고친 M의 버전 시각이 보낸 버전보다 늦다');
  await sleep(400);
  await gate.release();
  const round = await pending;
  assert.equal(round.success, true, round.error);

  const ledger1 = await ledgerOf(A);
  assert.equal(typeof ledger1.uploaded[N0.id], 'number', '전제: 멈췄던 묶음의 N0는 올림으로 적혀야 한다');
  assert.equal(ledger1.uploaded[N1.id], undefined, '요청 중에 추가한 기록이 올림으로 적혔다');
  // 멈춘 묶음에 담겼던 M은 서버가 받았지만 그 사이 고쳤으므로, 고친 버전 시각이 올림으로 적히면 안 된다.
  assert.notEqual(ledger1.uploaded[M.id], editedM.updatedAt, '묶음 안의 기록을 응답 전에 고쳤는데 고친 버전이 올림으로 적혔다');
  assert.ok(ledger1.uploaded[M.id] === undefined || ledger1.uploaded[M.id] === (M.updatedAt || M.timestamp), `M의 올림 시각이 보낸 버전도 아니다: ${ledger1.uploaded[M.id]}`);
  assert.ok((await livePairs(adapter, key)).some(([id, raw]) => id === M.id && JSON.parse(raw).amount === 33), '전제: 서버에는 M의 보낸 버전(33)이 있다');
  assert.equal(ledger1.uploaded[P.id], 3_000_000, '요청 중에 고친 기록이 새 버전으로 올림에 적혔다');
  assert.ok(!ledger1.tombstoned.includes(Q.id), '요청 중에 지운 기록의 삭제 표식이 올림으로 적혔다');
  assert.ok(!(await livePairs(adapter, key)).some(([id]) => id === N1.id), '전제: 서버에는 아직 N1이 없다');
  assert.ok(!(await deletedOnServer(adapter, key)).includes(Q.id), '전제: 서버에는 아직 Q의 삭제 표식이 없다');

  // 다음 증분 회차에 두 기록과 삭제가 올라가 상대 기기에 들어간다.
  await A.send('setTiming', { cycleBudgetMs: 800 });
  await sync(A);
  const serverLive = await livePairs(adapter, key);
  assert.ok(serverLive.some(([id]) => id === N1.id), '다음 회차에 N1이 올라가지 않았다');
  assert.ok(serverLive.some(([id, raw]) => id === P.id && JSON.parse(raw).amount === 777), '다음 회차에 고친 기록이 올라가지 않았다');
  assert.ok((await deletedOnServer(adapter, key)).includes(Q.id), '다음 회차에 삭제 표식이 올라가지 않았다');
  assert.ok(serverLive.some(([id, raw]) => id === M.id && JSON.parse(raw).amount === 888), '다음 회차에 묶음 안에서 고친 M이 올라가지 않았다');
  await sync(B);
  const bLogs = (await B.send('getLogs')).logs;
  assert.ok(bLogs.some((l) => l.id === N1.id), 'B가 N1을 받지 못했다');
  assert.equal(bLogs.find((l) => l.id === P.id)?.amount, 777, 'B가 고친 기록을 받지 못했다');
  assert.equal(bLogs.find((l) => l.id === M.id)?.amount, 888, 'B가 묶음 안에서 고친 M을 받지 못했다');
  assert.ok(!bLogs.some((l) => l.id === Q.id), 'B에 삭제한 기록이 남았다');
  assertSamePairs('A', await logSetOf(A), 'B', await logSetOf(B));
  assertSamePairs('A', await logSetOf(A), '서버', serverLive);
});

// ════════════════════════════════ 4. 삭제 표식 보존 ════════════════════════════════
await scenario('4', '삭제 표식 보존: 올리기 전에 지운 기록을 다른 기기가 올려도 되살아나지 않고, 순서를 바꿔도 수렴한다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  await A.send('seedLogs', { count: 1, idPrefix: 'base', timestamp: 4_000_000 });
  assert.equal((await createRound(A, key)).success, true);
  await joinKey(B, key);
  await sync(B);
  await sync(A);

  // 첫 번째: A가 기록을 올리기 전에 지우고 표식을 먼저 올린 뒤, B가 같은 id 기록을 올린다.
  const ghost1 = logOf('ghost-1', { amount: 50 });
  await putLog(A, ghost1);
  await putLog(B, ghost1);
  await A.send('deleteLog', { id: 'ghost-1' });
  await sync(A);
  assert.ok((await deletedOnServer(adapter, key)).includes('ghost-1'), '서버에 행이 없어도 삭제 표식이 남아야 한다');
  await sync(B);
  assert.ok(!(await livePairs(adapter, key)).some(([id]) => id === 'ghost-1'), 'B가 올린 기록이 서버에서 되살아났다');
  assert.ok(!(await B.send('getLogs')).logs.some((l) => l.id === 'ghost-1'), 'B에 지운 기록이 남았다');
  await sync(A);
  assert.ok(!(await A.send('getLogs')).logs.some((l) => l.id === 'ghost-1'), 'A에 지운 기록이 되살아났다');
  assert.ok((await deletedOnServer(adapter, key)).includes('ghost-1'));
  assert.ok((await profileOf(B)).deletedLogIds.includes('ghost-1'), 'B가 삭제 표식을 받지 못했다');

  // 두 번째 순서: B의 기록이 먼저 서버에 오고, 그 뒤에 A의 삭제 표식이 도착한다.
  const ghost2 = logOf('ghost-2', { amount: 60 });
  await putLog(A, ghost2);
  await putLog(B, ghost2);
  await A.send('deleteLog', { id: 'ghost-2' });
  await sync(B);
  assert.ok((await livePairs(adapter, key)).some(([id]) => id === 'ghost-2'), '전제: B가 올린 기록이 서버에 살아 있다');
  await sync(A);
  assert.ok(!(await livePairs(adapter, key)).some(([id]) => id === 'ghost-2'), '서버에 기록이 되살아난 채로 남았다');
  assert.ok((await deletedOnServer(adapter, key)).includes('ghost-2'));
  await sync(B);
  assert.ok(!(await B.send('getLogs')).logs.some((l) => l.id === 'ghost-2'), 'B에 지운 기록이 남았다');
  assert.ok(!(await A.send('getLogs')).logs.some((l) => l.id === 'ghost-2'));
  assertSamePairs('A', await logSetOf(A), 'B', await logSetOf(B));
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));
  assertSameIds('A의 삭제 id', (await profileOf(A)).deletedLogIds, '서버', await deletedOnServer(adapter, key));
  assertSameIds('B의 삭제 id', (await profileOf(B)).deletedLogIds, '서버', await deletedOnServer(adapter, key));
});

// ════════════════════════════════ 5. 같은 버전 무시 ════════════════════════════════
await scenario('5', '같은 버전 무시: 바뀐 것이 없으면 전체 모드와 새로고침을 반복해도 서버 쓰기가 0이고 토큰이 그대로다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  await A.send('seedLogs', { count: 30, idPrefix: 'same', timestamp: 5_000_000 });
  assert.equal((await createRound(A, key)).success, true);
  await joinKey(B, key);
  await sync(B);
  await sync(A);
  await sync(B);
  await sync(A);
  await selfCheckMembers(harness, key);
  const family0 = await adapter.family(key);
  const rows0 = (await adapter.logs(key)).rows.map((r) => [r.id, r.updatedAt]);
  assert.equal(rows0.length, 30);

  // 바뀐 기록 없이 전체 모드(당겨서 새로고침)를 두 기기가 반복한다.
  const mark = await adapter.requestCount();
  for (let i = 0; i < 2; i += 1) {
    await sync(A, { forceFullRead: true });
    await sync(B, { forceFullRead: true });
  }
  const repeated = syncRequests(await adapter.requests(mark));
  assert.ok(repeated.some(isFullPull), '전제: 전체 모드 당겨 받기가 실제로 돌았다');
  assert.equal(sum(repeated, (r) => r.logWrites), 0, '바뀐 기록이 없는데 D1 기록 행을 썼다');
  assert.equal(repeated.filter((r) => r.committed).length, 0, '바뀐 것이 없는데 서버가 확정한 요청이 있다');
  assert.equal((await adapter.family(key)).token, family0.token, '변경 토큰이 바뀌었다');
  assert.deepEqual((await adapter.logs(key)).rows.map((r) => [r.id, r.updatedAt]), rows0, '기록 행의 updated_at이 바뀌었다');

  // 장부를 잊은 기기가 같은 버전을 다시 올려도 서버 쓰기가 0이고 토큰이 그대로다(5-a가 요청 단위로 더 자세히 본다).
  assert.equal((await B.send('forgetUploaded', {})).removed, 30);
  const markResend = await adapter.requestCount();
  await sync(B);
  const resent = pushRequests(await adapter.requests(markResend)).filter((r) => r.pushLogs > 0);
  assert.ok(resent.length >= 1, '전제: B가 같은 버전을 다시 올렸다');
  assert.equal(sum(resent, (r) => r.logWrites), 0, '같은 버전 재전송이 D1 기록 행을 썼다');
  assert.equal((await adapter.family(key)).token, family0.token, '같은 버전 재전송이 변경 토큰을 바꿨다');

  // 상대 기기의 다음 증분 당겨 받기가 0행이다(최근 2분 안의 행은 제외해야 하므로 서버 시계를 3분 진행한다).
  await adapter.advanceClock(3 * 60_000);
  await sync(B);
  const markPull = await adapter.requestCount();
  await sync(B);
  const pulls = (await adapter.requests(markPull)).filter((r) => r.kind === 'pull');
  assert.ok(pulls.length >= 1 && pulls.every((r) => !isFullPull(r)), '전제: 증분 당겨 받기가 돌았다');
  // 빈 증분 당겨 받기가 읽는 행은 가족 행 1과 아기 정보 행 1뿐이다. 기록 행이 하나라도 있으면 더 커진다.
  for (const r of pulls) assert.ok(r.rowsRead <= 2, `증분 당겨 받기가 기록 행을 읽었다: rowsRead ${r.rowsRead}`);
  assert.equal(sum(pulls, (r) => r.logWrites), 0);

  // 기록 하나를 고치면 쓰기는 그 행 하나(인덱스 포함 2행)다.
  const target = (await A.send('getLogs')).logs.find((l) => l.id === 'same-7');
  await sleep(5);
  await A.send('updateLog', { log: { ...target, amount: 123 } });
  const markEdit = await adapter.requestCount();
  await sync(A);
  const editPushes = pushRequests(await adapter.requests(markEdit)).filter((r) => r.pushLogs > 0);
  assert.equal(editPushes.length, 1);
  assert.equal(editPushes[0].pushLogs, 1);
  assert.equal(editPushes[0].logWrites, 1);
  assert.equal(editPushes[0].writtenByTable.logs, 2, '고친 기록의 쓴 행이 인덱스 포함 2행이 아니다');
  assert.notEqual((await adapter.family(key)).token, family0.token, '기록이 바뀌면 토큰도 바뀌어야 한다');
  await sync(B);
  assert.equal((await B.send('getLogs')).logs.find((l) => l.id === 'same-7').amount, 123);
});

/** 아기 정보를 고친 적 없는 두 기기(sharedUpdatedAt: 0)가 번갈아 한 번씩 동기화한 뒤 서버 쓰기가 멈추는지 봅니다. */
async function profilePingPong({ adapter, devices: [A, B], birthA, birthB, maxProfileWrites }) {
  const key = await newKey(A);
  // 아기 정보를 고친 적 없는 기기: 공유 시각 0, 생일만 정한다. 이름, 몸무게, 목표량은 기본값이다.
  await A.send('writeStorage', { key: PROFILE_KEY, json: { birthDate: birthA, sharedUpdatedAt: 0, syncKey: key } });
  await B.send('writeStorage', { key: PROFILE_KEY, json: { birthDate: birthB, sharedUpdatedAt: 0, syncKey: key } });
  assert.equal((await profileOf(A)).sharedUpdatedAt, 0);
  assert.equal((await profileOf(B)).sharedUpdatedAt, 0);
  const mark = await adapter.requestCount();
  assert.equal((await createRound(A, key)).success, true);
  await sync(B);
  await sync(A);
  const writes = syncRequests(await adapter.requests(mark)).filter((r) => r.committed);
  assert.ok(writes.length <= maxProfileWrites, `아기 정보 쓰기가 ${writes.length}회다(${maxProfileWrites}회 이하여야 한다)`);
  const settled = await adapter.family(key);
  assert.ok(settled.sharedJson, '서버에 아기 정보가 있어야 한다');
  // A, B, A 순서 뒤에는 이후 회차를 몇 번 돌려도 변경 토큰과 shared_json이 바뀌지 않는다.
  const markAfter = await adapter.requestCount();
  for (let i = 0; i < 3; i += 1) {
    await sync(B);
    await sync(A);
  }
  await sync(A, { forceFullRead: true });
  await sync(B, { forceFullRead: true });
  const after = await adapter.family(key);
  assert.equal(after.token, settled.token, '수렴한 뒤에 변경 토큰이 바뀌었다');
  assert.equal(after.sharedJson, settled.sharedJson, '수렴한 뒤에 shared_json이 바뀌었다');
  assert.equal(syncRequests(await adapter.requests(markAfter)).filter((r) => r.committed).length, 0, '수렴한 뒤에도 서버 쓰기가 있다');
  const [a, b] = [await profileOf(A), await profileOf(B)];
  assert.equal(a.birthDate, b.birthDate, '두 기기의 생일이 수렴하지 않았다');
  assert.equal(a.birthDate, JSON.parse(settled.sharedJson).birthDate);
  return writes.length;
}

await scenario('5/같은생일', '같은 버전 무시: 아기 정보를 고친 적 없는 두 기기(생일 같음)는 A, B, A 뒤 서버 쓰기가 멈춘다', ['s1A', 's1B'], async (ctx) => {
  const writes = await profilePingPong({ ...ctx, birthA: '2024-05-05', birthB: '2024-05-05', maxProfileWrites: 2 });
  assert.equal(writes, 1, '같은 아기 정보는 처음 한 번만 쓰여야 한다');
});

await scenario('5/다른생일', '같은 버전 무시: 아기 정보를 고친 적 없는 두 기기(생일 다름)는 쓰기 2회 이하로 수렴해 멈춘다', ['s1A', 's1B'], async (ctx) => {
  await profilePingPong({ ...ctx, birthA: '2024-05-05', birthB: '2024-05-06', maxProfileWrites: 2 });
});

// ════════════════════════════════ 5-a. 같은 버전 직접 재전송 ════════════════════════════════
await scenario('5-a', '같은 버전 직접 재전송: 장부를 비우고 다시 올려도 D1 기록 행 쓰기가 0이고 토큰과 행 시각이 그대로다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  const idA = await clientIdOf(A);
  await A.send('seedLogs', { count: 50, idPrefix: 'resend', timestamp: 6_000_000 });
  assert.equal((await createRound(A, key)).success, true);
  await waitUntil(async () => (await adapter.logs(key)).live.length === 50, '기록 50건이 서버에 올라가지 않았습니다');
  await joinKey(B, key);
  await syncUntilDone(B);
  await syncUntilDone(A);
  await selfCheckMembers(harness, key);
  const tokenBefore = (await adapter.family(key)).token;
  const rowsBefore = (await adapter.logs(key)).rows.map((r) => [r.id, r.updatedAt]);
  assert.equal(rowsBefore.length, 50);

  const forgotten = await A.send('forgetUploaded', {});
  assert.equal(forgotten.removed, 50);
  const mark = await adapter.requestCount();
  await syncUntilDone(A);
  const resent = pushRequests(await adapter.requests(mark)).filter((r) => r.clientId === idA && r.pushLogs === 50);
  assert.ok(resent.length >= 1, '전제: A가 50건을 다시 보낸 올리기 요청이 있어야 한다');
  for (const r of resent) {
    assert.equal(r.status, 200);
    assert.equal(r.logWrites, 0, `같은 버전 재전송이 D1 기록 행을 썼다: ${r.logWrites}건`);
    assert.equal(r.writtenByTable.logs || 0, 0);
    assert.equal(r.committed, false);
  }
  assert.equal((await adapter.family(key)).token, tokenBefore, '같은 버전 재전송이 변경 토큰을 바꿨다');
  assert.deepEqual((await adapter.logs(key)).rows.map((r) => [r.id, r.updatedAt]), rowsBefore, '같은 버전 재전송이 기록 행의 updated_at을 바꿨다');
  // 장부는 응답으로 다시 채워진다.
  assert.equal(Object.keys((await ledgerOf(A)).uploaded).length, 50);
});

// ════════════════════════════════ 6. 동률 수렴 ════════════════════════════════
const EMOJI = '😀'; // U+1F600: UTF-16 순서로는 작고 코드 포인트(UTF-8) 순서로는 크다.
const FULLWIDTH = '！'; // U+FF01: UTF-16 순서로는 크고 코드 포인트 순서로는 작다.

await scenario('6', '동률 수렴: 같은 updatedAt에 다르게 고친 기록과 아기 정보가 두 기기와 서버에서 같은 쪽으로 수렴한다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  assert.equal(EMOJI > FULLWIDTH, false, '전제: UTF-16 순서로는 😀이 ！보다 작다');
  assert.ok(EMOJI.codePointAt(0) > FULLWIDTH.codePointAt(0), '전제: 코드 포인트 순서로는 😀이 ！보다 크다');
  assert.ok(Buffer.compare(Buffer.from(EMOJI), Buffer.from(FULLWIDTH)) > 0, '전제: UTF-8 바이트 순서도 😀이 더 크다');
  const key = await newKey(A);
  const idB = await clientIdOf(B);
  const R0 = logOf('tie-1', { notes: 'base', updatedAt: 1_700_000_000_000 });
  await putLog(A, R0);
  assert.equal((await createRound(A, key)).success, true);
  await joinKey(B, key);
  await sync(B);
  await sync(A);
  assert.equal((await B.send('getLogs')).logs.find((l) => l.id === 'tie-1')?.notes, 'base');
  const ledgerB = await ledgerOf(B);
  assert.ok(ledgerB && !ledgerB.full, '전제: B는 증분 모드(장부가 있고 전체 대조가 6시간 안)다');
  const notesOn = async (device) => (await device.send('peekLogs')).logs.find((l) => l.id === 'tie-1')?.notes;

  // ── 기록, 순서 고정: A가 이기는 쪽(😀)을 먼저 올려 확정하고, B가 지는 쪽(！)을 올린다. ──
  const S1 = 1_700_000_100_000;
  await putLog(A, { ...R0, notes: EMOJI, updatedAt: S1 });
  await putLog(B, { ...R0, notes: FULLWIDTH, updatedAt: S1 });
  await sync(A);
  assert.equal(JSON.parse((await livePairs(adapter, key)).find(([id]) => id === 'tie-1')[1]).notes, EMOJI, '서버는 A가 올린 값이어야 한다');
  const gate = await adapter.holdNext({ kind: 'pull', clientId: idB });
  const pendingB = track(B.send('syncWithCloud', { allowFamilyCreation: false }));
  await gate.held;
  // B의 당겨 받기 요청이 멈춘 사이에 B의 저장소를 읽는다. 올리기 응답의 분류만으로 이미 서버 값이어야 한다.
  assert.equal(await notesOn(B), EMOJI, '올리기 응답의 분류로 B의 기록이 서버 값으로 수렴하지 않았다');
  await gate.release();
  const roundB = await pendingB;
  assert.equal(roundB.success, true, roundB.error);
  await sync(A);
  await sync(B);
  for (const [label, notes] of [['A', await notesOn(A)], ['B', await notesOn(B)]]) assert.equal(notes, EMOJI, `${label}의 기록이 수렴하지 않았다`);
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));
  assertSamePairs('B', await logSetOf(B), '서버', await livePairs(adapter, key));

  // ── 기록, 반대 순서: A가 지는 쪽(！)을 먼저 올리면 서버가 B의 이기는 쪽(😀)으로 바뀌고 A가 받는다. ──
  const S2 = 1_700_000_200_000;
  await putLog(A, { ...R0, notes: FULLWIDTH, updatedAt: S2 });
  await putLog(B, { ...R0, notes: EMOJI, updatedAt: S2 });
  await sync(A);
  assert.equal(JSON.parse((await livePairs(adapter, key)).find(([id]) => id === 'tie-1')[1]).notes, FULLWIDTH);
  await sync(B);
  assert.equal(JSON.parse((await livePairs(adapter, key)).find(([id]) => id === 'tie-1')[1]).notes, EMOJI, '서버가 코드 포인트가 큰 쪽으로 바뀌어야 한다');
  await sync(A);
  assert.equal(await notesOn(A), EMOJI, 'A가 서버의 이기는 쪽을 받지 않았다');
  assertSamePairs('A', await logSetOf(A), 'B', await logSetOf(B));
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));

  // ── 아기 정보: 같은 sharedUpdatedAt에 이름만 다르게 ──
  const setName = async (device, name, ts) => {
    const current = await storedProfile(device);
    await device.send('writeStorage', { key: PROFILE_KEY, json: { ...current, name, sharedUpdatedAt: ts } });
  };
  const serverName = async () => JSON.parse((await adapter.family(key)).sharedJson).name;
  const T1 = 1_000_000_000_000;
  await setName(A, EMOJI, T1);
  await setName(B, FULLWIDTH, T1);
  await sync(A);
  assert.equal(await serverName(), EMOJI);
  await sync(B);
  assert.equal((await profileOf(B)).name, EMOJI, 'B의 아기 이름이 서버의 이기는 쪽으로 수렴하지 않았다');
  await sync(A);
  await sync(B);
  assert.equal((await profileOf(A)).name, EMOJI);
  assert.equal(await serverName(), EMOJI);
  // 반대 순서: 지는 쪽이 먼저 서버에 있어도 이기는 쪽으로 바뀌며, 먼저 올린 기기가 그 값을 받아 간다.
  const T2 = T1 + 1000;
  await setName(A, FULLWIDTH, T2);
  await setName(B, EMOJI, T2);
  await sync(A);
  assert.equal(await serverName(), FULLWIDTH);
  await sync(B);
  assert.equal(await serverName(), EMOJI, '서버의 아기 이름이 코드 포인트가 큰 쪽으로 바뀌어야 한다');
  await sync(A);
  assert.equal((await profileOf(A)).name, EMOJI, 'A의 아기 이름이 수렴하지 않았다');
  assert.equal((await profileOf(B)).name, EMOJI);
  assert.equal((await profileOf(A)).sharedUpdatedAt, T2);
});

// ════════════════════════════════ 6-a. 빈 이름 ════════════════════════════════
await scenario('6-a', '빈 이름: A가 아기 이름을 빈 문자열로 고치면 B의 이름도 빈 문자열이 된다', ['s1A', 's1B'], async ({ harness, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  await A.send('setProfile', { patch: { name: '처음이름' } });
  assert.equal((await createRound(A, key)).success, true);
  await joinKey(B, key);
  await sync(B);
  await sync(A);
  assert.equal((await profileOf(B)).name, '처음이름');
  await sleep(5);
  // B보다 큰 sharedUpdatedAt으로 이름을 빈 문자열로 고친다.
  const edited = (await A.send('setProfile', { patch: { name: '' } })).profile;
  assert.equal(edited.name, '');
  assert.ok(edited.sharedUpdatedAt > (await profileOf(B)).sharedUpdatedAt);
  await sync(A);
  assert.equal(JSON.parse((await adapter.family(key)).sharedJson).name, '', '서버에 빈 문자열이 저장되어야 한다');
  await sync(B);
  assert.equal((await profileOf(B)).name, '', 'B의 아기 이름이 빈 문자열을 따르지 않았다');
  assert.equal((await profileOf(B)).sharedUpdatedAt, edited.sharedUpdatedAt);
});

// ════════════════════════════════ 7. 동시 생성 ════════════════════════════════
await scenario('7', '동시 생성: 두 기기가 같은 키로 동시에 새 가족을 만들어도 둘 다 성공하고 가족은 하나이며 한쪽만 isNewFamily다', ['s1A', 's1B'], async ({ harness, server, adapter, devices: [A, B] }) => {
  await selfCheckDevices(harness);
  const key = await newKey(A);
  const [idA, idB] = [await clientIdOf(A), await clientIdOf(B)];
  const logA = (await A.send('addLog', { log: { type: 'formula', amount: 31, timestamp: Date.now() } })).saved;
  const logB = (await B.send('addLog', { log: { type: 'formula', amount: 32, timestamp: Date.now() } })).saved;

  // ① 연결 요청의 쓰기 배치를 A와 B 모두에 건다.
  const gateA = await adapter.holdNext({ kind: 'connect', batch: 'write', clientId: idA });
  const gateB = await adapter.holdNext({ kind: 'connect', batch: 'write', clientId: idB });
  // ② 두 기기가 연결을 요청한다. 두 요청 모두 가족 읽기에서 "없음"을 보고 생성 배치에서 멈춘다.
  const pendingA = track(createRound(A, key));
  const pendingB = track(createRound(B, key));
  // ③ 멈춘 목록에 두 요청이 모두 있는지 확인한다.
  await Promise.all([gateA.held, gateB.held]);
  const { held } = await server.control('state', { q: 'held' });
  const heldConnects = held.filter((h) => h.kind === 'connect' && h.batch === 'write');
  assert.deepEqual(heldConnects.map((h) => h.clientId).sort(), [idA, idB].sort(), '전제: 두 연결 요청이 모두 쓰기 배치에서 멈춰 있어야 한다');
  assert.equal((await adapter.family(key)).exists, false, '전제: 아직 가족이 없다');
  // ④ A를 풀고 응답을 받은 뒤 B를 푼다.
  await gateA.release();
  const resultA = await pendingA;
  assert.equal(resultA.success, true, `A 실패: ${resultA.error}`);
  await gateB.release();
  const resultB = await pendingB;
  assert.equal(resultB.success, true, `B 실패(늦은 쪽이 500을 받으면 안 된다): ${resultB.error}`);

  const connects = (await adapter.requests()).filter((r) => r.kind === 'connect');
  assert.equal(connects.length, 2);
  for (const r of connects) assert.equal(r.status, 200, `연결 요청의 응답 상태가 ${r.status}`);
  assert.equal(connects.filter((r) => (r.changedByTable.families || 0) === 1).length, 1, '가족 행은 한 번만 만들어져야 한다');
  const members = (await adapter.family(key)).members.map((m) => m.clientId).sort();
  assert.deepEqual(members, [idA, idB].sort(), 'members에 두 기기가 모두 있어야 한다');

  // 다음 회차 안에 서로의 기록을 받는다.
  await sync(A);
  await sync(B);
  const [setA, setB] = [await logSetOf(A), await logSetOf(B)];
  assert.deepEqual(setA.map(([id]) => id).sort(), [logA.id, logB.id].sort());
  assertSamePairs('A', setA, 'B', setB);
  assertSamePairs('A', setA, '서버', await livePairs(adapter, key));
  await selfCheckMembers(harness, key);

  // 응답 본문의 isNewFamily를 직접 확인한다(같은 연출을 HTTP 요청으로).
  const key2 = await newKey(A);
  const gateX = await adapter.holdNext({ kind: 'connect', batch: 'write', clientId: 'raw-x' });
  const gateY = await adapter.holdNext({ kind: 'connect', batch: 'write', clientId: 'raw-y' });
  const rawX = track(rawConnect(server, key2, 'raw-x'));
  const rawY = track(rawConnect(server, key2, 'raw-y'));
  await Promise.all([gateX.held, gateY.held]);
  await gateX.release();
  const resX = await rawX;
  await gateY.release();
  const resY = await rawY;
  assert.deepEqual([resX.status, resY.status], [200, 200], `응답 상태 ${resX.status}/${resY.status}`);
  assert.deepEqual([resX.json.isNewFamily, resY.json.isNewFamily], [true, false], '한쪽만 isNewFamily: true를 받아야 한다');
});

// ════════════════════════════════ 7-1. 여러 요청 가족 만들기 ════════════════════════════════
const createRequest = (key) => ({ syncKey: key, createBackup: true, allowFamilyCreation: true, connecting: true });

await scenario('7-1/저장', '여러 요청 가족 만들기: 같은 회차의 두 번째 이후 묶음도 저장된다(기대 키)', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  await A.send('seedLogs', { count: 1200, idPrefix: 'multi', timestamp: 7_000_000 });
  const result = await A.send('runnerRequest', { request: createRequest(key), timeoutMs: 10_000 });
  assert.equal(result.success, true, `가족 만들기 실패: ${result.error}`);
  await waitUntil(async () => (await adapter.logs(key)).live.length === 1200, '기록 1,200건이 올라가지 않았습니다');
  await settleRunner(A);
  const pushes = pushRequests(await adapter.requests());
  assert.ok(pushes.length >= 3, `올리기 묶음이 ${pushes.length}개뿐이다`);
  // 두 번째 이후 묶음의 응답이 저장되지 않으면(기대 키 거부) 다음 회차가 같은 묶음을 다시 올린다.
  assert.equal(sum(pushes, (r) => r.pushLogs), 1200, '묶음의 응답이 저장되지 않아 같은 기록을 다시 올렸다');
  assert.equal(sum(pushes, (r) => r.logWrites), 1200);
  const events = await eventsOf(A);
  assert.ok(!events.some((e) => e.type === 'failed'), `러너 사건에 실패가 있다: ${JSON.stringify(events.filter((e) => e.type === 'failed'))}`);
  assert.equal((await storedProfile(A)).syncKey, key);
  assert.equal(Object.keys((await ledgerOf(A)).uploaded).length, 1200);
});

await scenario('7-1/상한뒤', '여러 요청 가족 만들기: 첫 저장 뒤 상한에 걸리면 success, continuing이고 러너가 남은 묶음을 올린다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  await A.send('seedLogs', { count: 1200, idPrefix: 'cap', timestamp: 7_100_000 });
  // 올리기를 500ms씩 늦추고 러너 상한을 900ms로 짧게 둔다. 첫 묶음은 상한 전에 저장되고 두 번째 묶음이 상한에 걸린다.
  const slow = await adapter.delay({ kind: 'push' }, 500);
  const started = Date.now();
  const result = await A.send('runnerRequest', { request: createRequest(key), timeoutMs: 900 });
  const elapsed = Date.now() - started;
  await slow.clear();
  assert.ok(elapsed >= 800 && elapsed < 1100, `전제: 러너 상한(900ms)에서 끝나야 한다: ${elapsed}ms`);
  assert.equal(result.success, true, `상한 뒤에도 키가 저장됐으므로 성공이어야 한다: ${result.error}`);
  assert.equal(result.continuing, true);
  assert.equal((await storedProfile(A)).syncKey, key, '키가 저장되어 있어야 한다');
  await waitUntil(async () => (await adapter.logs(key)).live.length === 1200, '러너가 이어 요청한 평소 동기화가 남은 묶음을 올리지 못했습니다');
  await settleRunner(A);
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));
  const events = await eventsOf(A);
  assert.ok(events.some((e) => e.type === 'succeeded' && e.continuation === true), '러너가 이어 요청한 회차가 없다');
});

await scenario('7-1/저장전상한', '여러 요청 가족 만들기: 첫 저장 전에 상한에 걸리면 키가 저장되지 않고 결과는 실패다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  await A.send('seedLogs', { count: 50, idPrefix: 'early', timestamp: 7_200_000 });
  // 첫 저장은 첫 당겨 받기 응답을 반영할 때다. 그 응답을 러너 상한(400ms)보다 늦게(800ms) 보낸다.
  const slow = await adapter.delay({ kind: 'pull' }, 800);
  const result = await A.send('runnerRequest', { request: createRequest(key), timeoutMs: 400 });
  assert.equal(result.success, false, '첫 저장 전에 상한에 걸렸으므로 실패여야 한다');
  assert.equal((await storedProfile(A))?.syncKey ?? null, null, '키가 저장되면 안 된다');
  // 늦게 도착한 응답이 상한 뒤에 키를 저장하지도 않는다.
  await sleep(1300);
  await slow.clear();
  assert.equal((await storedProfile(A))?.syncKey ?? null, null, '늦은 응답이 상한 뒤에 키를 저장했다');
  // 상한으로 중단된 연결 회차는 연결 해제가 아니므로 detached가 아니라 failed로 알리고, 오류는 시간 초과 문구여야 한다.
  const events = await eventsOf(A);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('failed'), `failed 사건이 없다: ${JSON.stringify(types)}`);
  assert.ok(!types.includes('detached'), `상한에 걸린 연결 회차가 detached로 알려졌다: ${JSON.stringify(types)}`);
  assert.ok(!types.includes('succeeded'), '성공 사건이 있으면 안 된다');
  assert.ok(String(result.error).includes('서버 응답을 기다리고 있어요'), `결과 오류가 시간 초과 문구가 아니다: ${result.error}`);
  assert.ok(String(events.find((e) => e.type === 'failed').error).includes('서버 응답을 기다리고 있어요'), '실패 사건의 오류가 시간 초과 문구가 아니다');
});

await scenario('7-1/503', '여러 요청 가족 만들기: 첫 저장 뒤 다른 요청이 503이어도 success, continuing이고, 모든 요청이 503이면 실패다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  await A.send('seedLogs', { count: 1200, idPrefix: 'five', timestamp: 7_300_000 });
  // 첫 저장을 마친 뒤의 두 번째 올리기 묶음에만 503을 한 번 준다. 상한에는 걸리지 않는다.
  await adapter.failHttp({ status: 503, match: { kind: 'push' }, skip: 1, times: 1 });
  const result = await A.send('runnerRequest', { request: createRequest(key), timeoutMs: 10_000 });
  assert.equal(result.success, true, `첫 저장 뒤의 503은 성공이어야 한다: ${result.error}`);
  assert.equal(result.continuing, true);
  assert.equal((await storedProfile(A)).syncKey, key);
  await waitUntil(async () => (await adapter.logs(key)).live.length === 1200, '러너가 이어 요청한 평소 동기화가 남은 묶음을 올리지 못했습니다');
  await settleRunner(A);
  const reqs = await adapter.requests();
  assert.equal(reqs.filter((r) => r.status === 503).length, 1);
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));

  // 같은 조건에서 모든 요청에 503이면 첫 저장까지 가지 못해 키가 없고 결과는 실패다.
  await adapter.clearFaults();
  await A.send('writeStorage', { key: PROFILE_KEY, json: { ...(await storedProfile(A)), syncKey: undefined } });
  await A.send('writeStorage', { key: '@baby_sync_ledger_cf_v1', value: null });
  await A.send('runnerReset', { timeoutMs: 10_000 });
  const key2 = await newKey(A);
  await adapter.failHttp({ status: 503, match: { kind: 'sync' }, times: 'always' });
  const failed = await A.send('runnerRequest', { request: createRequest(key2), timeoutMs: 10_000 });
  assert.equal(failed.success, false, '모든 요청이 503이면 실패여야 한다');
  assert.equal((await storedProfile(A))?.syncKey ?? null, null, '키가 저장되면 안 된다');
  await adapter.clearFaults();
});

await scenario('7-1/404', '여러 요청 가족 만들기: 첫 저장 뒤 데이터베이스를 비우면(404) 결과가 실패다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  const idA = await clientIdOf(A);
  await A.send('seedLogs', { count: 1200, idPrefix: 'nf', timestamp: 7_400_000 });
  const gate = await adapter.holdNext({ kind: 'push', clientId: idA }, { skip: 1 });
  const pending = track(A.send('runnerRequest', { request: createRequest(key), timeoutMs: 10_000 }));
  await gate.held;
  assert.equal((await storedProfile(A)).syncKey, key, '전제: 첫 저장으로 키가 저장되어 있다');
  await adapter.control('wipe', { scope: 'all' });
  await gate.release();
  const result = await pending;
  assert.equal(result.success, false, '404는 저장소 판정으로 성공을 만들면 안 된다');
  assert.equal(result.familyNotFound, true);
  assert.equal((await storedProfile(A)).syncKey, key, '404로 앱이 스스로 연결을 끊으면 안 된다');
  assert.ok((await eventsOf(A)).some((e) => e.type === 'failed'));
});

await scenario('7-1/410', '여러 요청 가족 만들기: 첫 저장 뒤 다른 기기가 영구 삭제하면(410) 결과가 실패이고 키가 남지 않는다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  const idA = await clientIdOf(A);
  await A.send('seedLogs', { count: 1200, idPrefix: 'gone', timestamp: 7_500_000 });
  const gate = await adapter.holdNext({ kind: 'push', clientId: idA }, { skip: 1 });
  const pending = track(A.send('runnerRequest', { request: createRequest(key), timeoutMs: 10_000 }));
  await gate.held;
  assert.equal((await storedProfile(A)).syncKey, key, '전제: 첫 저장으로 키가 저장되어 있다');
  await adapter.markGone(key);
  await gate.release();
  const result = await pending;
  assert.equal(result.success, false, '410은 저장소 판정으로 성공을 만들면 안 된다');
  assert.equal(result.familyUnavailable, true);
  assert.equal((await storedProfile(A))?.syncKey ?? null, null, '410이면 키가 남으면 안 된다');
  assert.ok((await eventsOf(A)).some((e) => e.type === 'failed'));
  assert.ok(!(await adapter.family(key)).exists, '삭제된 가족이 다시 생기면 안 된다');
});

await scenario('7-1/multiSet', '여러 요청 가족 만들기: multiSet 도중 상한이 지나도 키가 저장되므로 success다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  await A.send('seedLogs', { count: 10, idPrefix: 'ms', timestamp: 7_600_000 });
  // 첫 저장(기록 키나 새 장부 키를 담은 첫 쓰기)을 멈춘다.
  await A.send('injectStorageFault', { mode: 'delay', nth: 1 });
  const pending = track(A.send('runnerRequest', { request: createRequest(key), timeoutMs: 500 }));
  await waitUntil(async () => (await A.send('storageFaultStatus')).state === 'delayed', '첫 저장이 멈추지 않았습니다', 10_000, 10);
  // 쓰기가 멈춘 동안 러너 상한을 넘긴다.
  await sleep(900);
  assert.equal((await A.send('readStorage', { keys: [PROFILE_KEY] })).items[PROFILE_KEY], null, '전제: 멈춘 동안 키가 아직 저장되지 않았다');
  assert.deepEqual(await A.send('releaseWrite'), { released: true });
  const result = await pending;
  assert.equal(result.success, true, `키가 저장됐으므로 성공이어야 한다: ${result.error}`);
  assert.equal(result.continuing, true);
  assert.equal((await storedProfile(A)).syncKey, key);
  await A.send('clearStorageFault');
  await waitUntil(async () => (await adapter.logs(key)).live.length === 10, '러너가 이어 요청한 평소 동기화가 기록을 올리지 못했습니다');
  await settleRunner(A);
  assertSamePairs('A', await logSetOf(A), '서버', await livePairs(adapter, key));
});

await scenario('7-1/해제', '여러 요청 가족 만들기: 회차 도중 연결을 해제하면 키가 되살아나지 않고 detached 사건이 남는다', ['s1A'], async ({ adapter, devices: [A] }) => {
  const key = await newKey(A);
  const idA = await clientIdOf(A);
  await A.send('seedLogs', { count: 1200, idPrefix: 'det', timestamp: 7_700_000 });
  const gate = await adapter.holdNext({ kind: 'push', clientId: idA }, { skip: 1 });
  const pending = track(A.send('runnerRequest', { request: createRequest(key), timeoutMs: 10_000 }));
  await gate.held;
  assert.equal((await storedProfile(A)).syncKey, key, '전제: 첫 저장으로 키가 저장되어 있다');
  // App의 연결 해제와 같은 순서: 진행 중인 회차를 중단하고 키를 지운다.
  await A.send('runnerAbort');
  await A.send('setProfile', { patch: { syncKey: null } });
  await gate.release();
  const result = await pending;
  assert.equal(result.success, false);
  await sleep(500);
  assert.equal((await storedProfile(A)).syncKey ?? null, null, '연결을 해제한 뒤 키가 되살아났다');
  const events = await eventsOf(A);
  assert.ok(events.some((e) => e.type === 'detached'), `러너의 사건 목록에 detached가 없다: ${JSON.stringify(events.map((e) => e.type))}`);
  // 같은 연출을 중단 표시 없이(저장된 키만 사라진 경우) 반복해도, 다음 저장이 거부되어 키가 되살아나지 않는다.
  const key2 = await newKey(A);
  await A.send('runnerReset', { timeoutMs: 10_000 });
  await A.send('writeStorage', { key: '@baby_sync_ledger_cf_v1', value: null });
  const gate2 = await adapter.holdNext({ kind: 'push', clientId: idA }, { skip: 1 });
  const pending2 = track(A.send('runnerRequest', { request: createRequest(key2), timeoutMs: 10_000 }));
  await gate2.held;
  assert.equal((await storedProfile(A)).syncKey, key2);
  await A.send('setProfile', { patch: { syncKey: null } });
  await gate2.release();
  const result2 = await pending2;
  assert.equal(result2.success, false, '키가 사라진 회차는 성공이면 안 된다');
  await sleep(500);
  assert.equal((await storedProfile(A)).syncKey ?? null, null, '저장된 키가 사라진 뒤 다음 저장이 키를 되살렸다');
});

// ════════════════════════════════ 집계 ════════════════════════════════
const failed = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오 1부: ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
