// 실제 서버 모드 시나리오 둘째 묶음입니다(06 설계 5.1의 8, 8-b, 8-c, 8-1, 9, 10, 11, 12, 13, 14, 14-1, 14-2, 16, 16-a, 16-b, 17, 18).
// 앞쪽 시나리오(1~7-1)는 real-scenarios-1.mjs 가 맡고, 시나리오 15(기존 회귀)는 regression.mjs 가 두 모드로 돕니다.
// 실제 Worker 코드(server/src/index.ts)가 서버 프로세스로 뜨고, 기기는 프로세스를 따로 띄워 HTTP로 요청합니다.
// 두 묶음이 저장 파일을 겹치지 않도록 기기 이름은 모두 s2 접두어로 시작합니다(s2A, s2B ...).
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-2.mjs
// 각 시나리오는 새 서버와 새 기기를 띄워 서로 상태를 공유하지 않습니다. 판정은 설계 문장 그대로이고,
// 전제 확인(요청이 실제로 멈췄는지, 전체 모드가 실제로 여러 회차에 걸쳤는지 등)도 판정에 포함합니다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as storage from '../../src/database/storage.ts';
import * as sync from '../../src/database/sync.ts';
import { setCustomWorkerUrl } from '../../src/database/cloudConfig.ts';
import { decideAfterTokenError } from '../../src/database/syncDecision.ts';
import AsyncStorage from './stubs/async-storage.mjs';
import { startRealHarness, selfCheckDevices, selfCheckMembers } from './real-harness.mjs';

const LEDGER_KEY = '@baby_sync_ledger_cf_v1';
const LEGACY_LEDGER_KEY = '@baby_sync_ledger_v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ────────────── 시나리오 실행기 ──────────────
const results = [];
const only = process.env.SCENARIO_ONLY ? new Set(process.env.SCENARIO_ONLY.split(',')) : null;

/**
 * 새 서버와 기기(이름에 s2 접두어)를 띄워 fn을 돌리고, 끝나면 모두 정리합니다.
 * fn은 { server, adapter, devices, harness, A, B, ... } 를 받습니다(기기는 접두어 없는 이름으로도 접근).
 */
async function scenario(id, name, deviceNames, fn, options = {}) {
  if (only && !only.has(id)) return;
  const started = Date.now();
  let harness = null;
  try {
    harness = await startRealHarness({
      devices: deviceNames.map((n) => `s2${n}`),
      maxPushItems: options.maxPushItems,
      maxPageRows: options.maxPageRows,
    });
    const devices = {};
    for (const n of deviceNames) {
      devices[n] = harness.devices[`s2${n}`];
      devices[n].cid = (await devices[n].send('getSyncClientId')).clientId;
    }
    await harness.server.adapter.reset();
    if (options.maxPushItems !== undefined || options.maxPageRows !== undefined) {
      await harness.server.adapter.setLimits({ maxPushItems: options.maxPushItems, maxPageRows: options.maxPageRows });
    }
    setCustomWorkerUrl(harness.server.url);
    await fn({ harness, server: harness.server, adapter: harness.server.adapter, devices, ...devices });
    results.push(true);
    console.log(`PASS [${id}] ${name} (${((Date.now() - started) / 1000).toFixed(1)}초)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL [${id}] ${name} (${((Date.now() - started) / 1000).toFixed(1)}초)\n     ${error?.stack || error}`);
  } finally {
    if (harness) await harness.stop().catch(() => undefined);
  }
}

// ────────────── 공통 도우미 ──────────────
const newKey = (() => { let n = 0; const stamp = Date.now().toString(16); return () => `${stamp}${String(++n).padStart(4, '0')}`.padStart(32, 'k').slice(-32); })();

/** 모든 시간 상한을 넉넉히 늘립니다. 서버에서 요청을 멈춰 두는 시나리오가 상한에 걸리지 않게 합니다. */
const relax = (device) => device.send('setTiming', { requestTimeoutMs: 20_000, pullBudgetMs: 20_000, cycleBudgetMs: 20_000 });

/** 평소 동기화를 이어 가기가 끝날 때까지 돌립니다(직접 호출, 러너 없음). */
async function syncDone(device, payload = {}, max = 60) {
  let result;
  for (let i = 0; i < max; i += 1) {
    result = await device.send('syncWithCloud', { allowFamilyCreation: false, ...payload });
    if (!result.success || !result.continuing) return result;
  }
  return result;
}

async function createFamily(device, key) {
  const result = await device.send('runnerRequest', { request: { syncKey: key, createBackup: true, allowFamilyCreation: true, connecting: true } });
  assert.equal(result.success, true, `가족 만들기 실패: ${result.error}`);
  return result;
}

async function joinFamily(device, key) {
  const result = await device.send('runnerRequest', { request: { syncKey: key, createBackup: true, connecting: true } });
  assert.equal(result.success, true, `합류 실패: ${result.error}`);
  return result;
}

/** A가 만들고 B가 합류한 뒤 둘 다 증분 모드(장부가 있고 전체 대조가 6시간 안)가 되게 합니다. */
async function setupPair(h, key) {
  await createFamily(h.A, key);
  await joinFamily(h.B, key);
  for (const device of [h.A, h.B, h.A, h.B]) {
    const r = await syncDone(device);
    assert.equal(r.success, true, r.error);
  }
  await selfCheckDevices(h.harness);
  await selfCheckMembers(h.harness, key, 2);
  for (const device of [h.A, h.B]) {
    const { ledger } = await device.send('readLedger');
    assert.ok(ledger && !ledger.full, '전제: 증분 모드의 장부가 있다');
  }
}

const isFullPull = (r) => r.kind === 'pull' && r.pull.after[0] === 0 && r.pull.after[1] === '';
const requestsOf = async (adapter, device, from = 0) => (await adapter.requests(from)).filter((r) => r.clientId === device.cid);
const syncRequestsOf = async (adapter, device, from = 0) => (await requestsOf(adapter, device, from)).filter((r) => r.kind === 'push' || r.kind === 'pull');
const pullsOf = async (adapter, device, from = 0) => (await requestsOf(adapter, device, from)).filter((r) => r.kind === 'pull');
const pushesOf = async (adapter, device, from = 0) => (await requestsOf(adapter, device, from)).filter((r) => r.kind === 'push' && r.pushLogs + r.pushDeleted > 0);

const mkLog = (id, updatedAt, extra = {}) => ({ id, type: 'formula', amount: 90, timestamp: updatedAt, updatedAt, ...extra });
const logsWith = (prefix, count, base = 1_000_000, extra = {}) => Array.from({ length: count }, (_, i) => mkLog(`${prefix}-${String(i).padStart(4, '0')}`, base + i, extra));
const addLogs = async (device, logs) => {
  const current = (await device.send('getLogs')).logs;
  await device.send('saveLogs', { logs: [...current, ...logs] });
};
const addSavedLog = async (device, amount) => (await device.send('addLog', { log: { type: 'formula', amount, timestamp: Date.now() } })).saved;
const idsOf = (logs) => new Set(logs.map((l) => l.id));
const pairsOf = async (device) => (await device.send('logSet')).pairs;
const serverPairs = async (adapter, key) => (await adapter.logs(key)).live;

/** 기기의 살아 있는 기록 집합(id와 canonical JSON의 쌍)과 서버의 살아 있는 행 집합이 정확히 같은지 봅니다. */
async function assertSameSet(adapter, key, device, label = '') {
  const devicePairs = await pairsOf(device);
  const server = await serverPairs(adapter, key);
  const deviceIds = new Set(devicePairs.map(([id]) => id));
  const serverIds = new Set(server.map(([id]) => id));
  const missingOnServer = [...deviceIds].filter((id) => !serverIds.has(id));
  const missingOnDevice = [...serverIds].filter((id) => !deviceIds.has(id));
  assert.deepEqual(
    [missingOnServer.length, missingOnDevice.length],
    [0, 0],
    `${label} 기록 집합이 다릅니다: 서버에 없음 ${missingOnServer.slice(0, 3)}…(${missingOnServer.length}), 기기에 없음 ${missingOnDevice.slice(0, 3)}…(${missingOnDevice.length})`,
  );
  assert.deepEqual(devicePairs, server, `${label} 기록 내용(canonical JSON)이 다릅니다`);
}

const readStoredFile = (device) => JSON.parse(readFileSync(device.storageFile, 'utf8'));
const storedLedger = (device) => {
  const raw = readStoredFile(device)[LEDGER_KEY];
  return raw ? JSON.parse(raw) : null;
};
const storedLogs = (device) => {
  const raw = readStoredFile(device)['@baby_logs'];
  return raw ? JSON.parse(raw) : [];
};

/** 서버 요청 목록을 기다려 조건에 맞는 첫 요청을 돌려줍니다. */
async function waitForRequest(adapter, predicate, what, from = 0, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await adapter.requests(from)).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`시간 안에 ${what}`);
    await sleep(10);
  }
}

const waitUntil = async (predicate, what, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`시간 안에 ${what}`);
    await sleep(10);
  }
};

/** 서버에 직접 요청합니다(제어 엔드포인트가 아닌 Worker 경로). */
async function rawCall(server, key, route, { method = 'POST', body, clientId = 'raw-scenario-client' } = {}) {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

/** 같은 프로세스에서 변경 토큰 폴링(subscribeToCloudChanges)을 돌립니다. 90초 주기만 짧게 줄여 실제 폴링 코드를 그대로 씁니다. */
async function startPoller(key, intervalMs = 120) {
  const events = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...rest) => realSetInterval(fn, ms === 90_000 ? intervalMs : ms, ...rest);
  let unsubscribe;
  try {
    unsubscribe = await sync.subscribeToCloudChanges(
      key,
      () => events.push({ type: 'change', at: Date.now() }),
      (error) => events.push({ type: 'error', status: error?.status ?? null, at: Date.now() }),
    );
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  return { events, stop: () => unsubscribe?.() };
}

// ════════════════════════════════════════════════════════════════
// 8. 커서 여유 (결함 6): 이른 시각으로 늦게 확정된 행을 다음 증분 회차가 받는다
// ════════════════════════════════════════════════════════════════
await scenario('8', '커서 여유: 늦게 확정된 A의 행을 B의 다음 증분 회차가 받는다', ['A', 'B'], async (h) => {
  const { adapter, server, A, B } = h;
  const key = newKey();
  const T = 1_800_000_000_000;
  // ① 서버 시계를 T로 둔다. 설정과 연결은 시계가 정해진 뒤에 한다.
  await server.control('clock', { set: T });
  await setupPair(h, key);
  await relax(A);
  await relax(B);
  const mark0 = await adapter.requestCount();
  await server.control('clock', { set: T });

  // ② A가 올린다. A의 쓰기 배치는 시각 T를 찍은 뒤 BEGIN 전에 멈춘다.
  const late = await addSavedLog(A, 77);
  const gate = await adapter.holdNext({ kind: 'push', clientId: A.cid, batch: 'write' });
  const aRound = A.send('syncWithCloud', { allowFamilyCreation: false });
  await gate.held;

  // ③ 시계를 T + 30초로 진행한다(여유가 0이면 커서가 T를 넘어서는 것을 드러내려면 반드시 진행해야 한다).
  await server.control('clock', { advance: 30_000 });
  // ④ B가 증분 회차를 마친다. B의 커서 후보는 T + 30초 - 2분이다.
  const bFirst = await syncDone(B);
  assert.equal(bFirst.success, true, bFirst.error);
  assert.equal(
    idsOf((await B.send('getLogs')).logs).has(late.id), false,
    '전제: A의 배치가 아직 확정되지 않았으므로 B는 A의 기록을 아직 받지 못했다',
  );
  const bPulls = await pullsOf(adapter, B, mark0);
  assert.ok(bPulls.length >= 1 && bPulls.every((r) => !isFullPull(r)), '전제: B의 회차는 증분 모드다');
  assert.equal((await B.send('readLedger')).ledger.cursorMillis, T + 30_000 - 2 * MINUTE, '전제: B의 커서는 T + 30초 - 2분이다');

  // ⑤ A를 푼다. A의 행은 이른 시각 T로 늦게 확정된다.
  await gate.release();
  const aResult = await aRound;
  assert.equal(aResult.success, true, aResult.error);
  const row = (await adapter.logs(key)).rows.find((r) => r.id === late.id);
  assert.equal(row?.updatedAt, T, '전제: 행은 이른 시각 T로 확정되었다');

  // ⑥ 시계를 1분 더 진행하고 B가 다음 증분 회차를 돈다. 판정은 B가 A의 기록을 받는 것이다.
  await server.control('clock', { advance: MINUTE });
  const bSecond = await syncDone(B);
  assert.equal(bSecond.success, true, bSecond.error);
  assert.equal(idsOf((await B.send('getLogs')).logs).has(late.id), true, 'B가 늦게 확정된 A의 기록을 받는다');
  await assertSameSet(adapter, key, B, 'B');
});

// ════════════════════════════════════════════════════════════════
// 8-b. 여러 페이지를 받는 도중 첫 페이지 범위에 끼어든 늦은 확정
// ════════════════════════════════════════════════════════════════
await scenario('8-b', '여러 페이지 중 늦은 확정: 마지막 페이지의 후보가 아니라 첫 페이지의 후보가 최종 커서다', ['A', 'B'], async (h) => {
  const { adapter, server, A, B } = h;
  const key = newKey();
  const T = 1_800_000_000_000;
  await server.control('clock', { set: T });
  await adapter.setLimits({ maxPageRows: 25 });
  await setupPair(h, key);
  await relax(A);
  await relax(B);
  const mark0 = await adapter.requestCount();

  // ① 시계를 T로 두고 A의 쓰기 배치가 T를 찍은 뒤 BEGIN 전에 멈추게 한다.
  await server.control('clock', { set: T });
  const late = await addSavedLog(A, 88);
  const writeGate = await adapter.holdNext({ kind: 'push', clientId: A.cid, batch: 'write' });
  const aRound = A.send('syncWithCloud', { allowFamilyCreation: false });
  await writeGate.held;

  // ② 시계를 T + 10초로 두고 B가 받을 행을 두 페이지 분량(페이지 크기 25) 넣는다.
  await server.control('clock', { set: T + 10_000 });
  const injected = logsWith('inj', 30, T - HOUR);
  await server.control('inject', { key, logs: injected, serverTime: T + 10_000 });

  // ③ B의 두 번째 당겨 받기 요청을 멈춘 채 B의 증분 회차를 시작한다. 첫 페이지의 후보는 c1 = T + 10초 - 2분이다.
  const pageGate = await adapter.holdNext({ kind: 'pull', clientId: B.cid }, { skip: 1 });
  const bRound = B.send('syncWithCloud', { allowFamilyCreation: false });
  await pageGate.held;
  const midLedger = (await B.send('readLedger')).ledger;
  assert.equal(midLedger.pullCursorAtStart, T + 10_000 - 2 * MINUTE, '전제: 첫 페이지의 후보 c1이 pullCursorAtStart에 적혔다');
  assert.ok(midLedger.pullAfter, '전제: 첫 페이지에서 끊겼다(pullAfter가 있다)');

  // ④ 시계를 T + 3분으로 진행하고 B의 두 번째 요청을 푼다. 그 페이지의 후보는 c2 = T + 1분이다.
  await server.control('clock', { set: T + 3 * MINUTE });
  await pageGate.release();
  const bResult = await bRound;
  assert.equal(bResult.success, true, bResult.error);
  const afterLedger = (await B.send('readLedger')).ledger;
  assert.equal(afterLedger.cursorMillis, T + 10_000 - 2 * MINUTE, 'B의 회차가 끝나면 커서는 c1이다(c2 = T + 1분이 아니다)');
  assert.ok((await pullsOf(adapter, B, mark0)).length >= 2, '전제: B의 회차는 당겨 받기 요청이 두 번 이상이다');
  assert.equal(idsOf((await B.send('getLogs')).logs).has(late.id), false, '전제: A의 행은 아직 확정되지 않았다');

  // ⑤ A를 푼다. A의 행은 시각 T로 늦게 확정된다.
  await writeGate.release();
  assert.equal((await aRound).success, true);
  assert.equal((await adapter.logs(key)).rows.find((r) => r.id === late.id)?.updatedAt, T, '전제: A의 행은 T로 확정되었다');

  // ⑥ B의 다음 증분 회차가 A의 행을 받는다.
  const bNext = await syncDone(B);
  assert.equal(bNext.success, true, bNext.error);
  assert.equal(idsOf((await B.send('getLogs')).logs).has(late.id), true, 'B가 늦게 확정된 A의 기록을 받는다');
  await assertSameSet(adapter, key, B, 'B');
}, { maxPageRows: 25 });

// ════════════════════════════════════════════════════════════════
// 8-c. 끊긴 뒤 이어 받기 중 늦은 확정
// ════════════════════════════════════════════════════════════════
await scenario('8-c', '끊긴 뒤 이어 받기 중 늦은 확정: 재개 첫 페이지의 후보가 pullCursorAtStart를 덮지 않는다', ['A', 'B'], async (h) => {
  const { adapter, server, A, B } = h;
  const key = newKey();
  const T = 1_800_000_000_000;
  await server.control('clock', { set: T });
  await adapter.setLimits({ maxPageRows: 25 });
  await setupPair(h, key);
  await relax(A);
  await relax(B);
  const mark0 = await adapter.requestCount();

  // ① 시계를 T로 두고 B가 증분 회차의 첫 페이지를 받는다(pullCursorAtStart = T - 2분). 두 번째 요청을 멈추고 B를 SIGKILL로 끝낸다.
  await server.control('clock', { set: T });
  await server.control('inject', { key, logs: logsWith('inj', 30, T - HOUR), serverTime: T });
  const pageGate = await adapter.holdNext({ kind: 'pull', clientId: B.cid }, { skip: 1 });
  const bFirst = B.send('syncWithCloud', { allowFamilyCreation: false }).catch(() => undefined);
  await pageGate.held;
  await B.kill();
  await bFirst;
  const killedLedger = storedLedger(B);
  assert.equal(killedLedger.pullCursorAtStart, T - 2 * MINUTE, '전제: 끊기기 전 pullCursorAtStart는 T - 2분이다');
  assert.ok(killedLedger.pullAfter, '전제: 끊긴 지점이 pullAfter에 남았다');
  assert.ok(storedLogs(B).some((l) => l.id.startsWith('inj-')), '전제: 첫 페이지의 기록은 이미 저장되었다');
  await pageGate.release();

  // ② 시계를 T + 1분으로 두고 A의 쓰기 배치가 T + 1분을 찍은 뒤 BEGIN 전에 멈추게 한다.
  await server.control('clock', { set: T + MINUTE });
  const late = await addSavedLog(A, 99);
  const writeGate = await adapter.holdNext({ kind: 'push', clientId: A.cid, batch: 'write' });
  const aRound = A.send('syncWithCloud', { allowFamilyCreation: false });
  await writeGate.held;

  // ③ 시계를 T + 4분으로 진행하고 B를 다시 띄워 pullAfter부터 이어 받는다. 이어 받는 첫 페이지의 후보는 T + 2분이다.
  await server.control('clock', { set: T + 4 * MINUTE });
  await B.restart();
  await relax(B);
  const mark1 = await adapter.requestCount();
  const resumed = await syncDone(B);
  assert.equal(resumed.success, true, resumed.error);
  const resumedPulls = await pullsOf(adapter, B, mark1);
  assert.deepEqual(
    resumedPulls[0].pull.after, [killedLedger.pullAfter.updatedAt, killedLedger.pullAfter.logId],
    '전제: 재시작한 B는 pullAfter부터 이어 받는다',
  );
  assert.equal((await B.send('readLedger')).ledger.cursorMillis, T - 2 * MINUTE, 'B의 회차가 끝나면 커서는 T - 2분이다(T + 2분이 아니다)');
  assert.equal(idsOf((await B.send('getLogs')).logs).has(late.id), false, '전제: A의 행은 아직 확정되지 않았다');

  // ④ A를 푼다.
  await writeGate.release();
  assert.equal((await aRound).success, true);
  assert.equal((await adapter.logs(key)).rows.find((r) => r.id === late.id)?.updatedAt, T + MINUTE, '전제: A의 행은 T + 1분으로 확정되었다');

  // ⑤ B의 다음 증분 회차가 A의 행을 받는다.
  const bNext = await syncDone(B);
  assert.equal(bNext.success, true, bNext.error);
  assert.equal(idsOf((await B.send('getLogs')).logs).has(late.id), true, 'B가 늦게 확정된 A의 기록을 받는다');
  assert.ok(mark0 >= 0);
  await assertSameSet(adapter, key, B, 'B');
}, { maxPageRows: 25 });

// ════════════════════════════════════════════════════════════════
// 8-1. 토큰 확정: 확정 뒤 응답이 실패해도 토큰은 이미 바뀌어 있다
// ════════════════════════════════════════════════════════════════
await scenario('8-1', '토큰 확정: COMMIT 뒤 응답 실패에도 토큰이 바뀌고, 재전송은 쓰기 0행이다', ['A', 'B'], async (h) => {
  const { adapter, server, A, B } = h;
  const key = newKey();
  await setupPair(h, key);
  await relax(A);
  await relax(B);
  // 직전 토큰과 확실히 다른 시각이 찍히도록 서버 시계를 조금 진행한다.
  await server.control('clock', { advance: 5_000 });
  const tokenBefore = (await B.send('rawToken')).changeToken;
  assert.equal(tokenBefore, (await adapter.family(key)).token);

  // ① A의 올리기 배치가 확정된 뒤 응답이 실패한다.
  const added = await addSavedLog(A, 61);
  await server.control('fail', { op: 'add', mode: 'afterCommit', match: { kind: 'push', clientId: A.cid, batch: 'write' } });
  const mark = await adapter.requestCount();
  const failed = await A.send('syncWithCloud', { allowFamilyCreation: false });
  assert.equal(failed.success, false, '전제: A의 요청은 확정 뒤 오류로 끝난다');
  const firstPush = (await pushesOf(adapter, A, mark))[0];
  assert.equal(firstPush.status, 500, '전제: 서버가 COMMIT 뒤 500을 돌려준다');
  assert.equal(firstPush.committed, true, '전제: 배치는 확정되었다');
  assert.ok((await adapter.logs(key)).rows.some((r) => r.id === added.id), '전제: 기록은 서버에 있다');
  assert.equal(idsOf((await A.send('getLogs')).logs).has(added.id), true);
  assert.equal((await A.send('readLedger')).ledger.uploaded[added.id], undefined, '전제: A는 응답을 못 받아 장부에 올림으로 적지 않았다');

  // ② A가 다시 보내기 전에 B가 변경 토큰을 읽는다. 토큰이 바뀌었고, B의 다음 증분 회차가 A의 기록을 받는다.
  const tokenAfterCommit = (await B.send('rawToken')).changeToken;
  assert.notEqual(tokenAfterCommit, tokenBefore, '확정된 배치와 함께 토큰이 바뀌어 있다');
  const bSync = await syncDone(B);
  assert.equal(bSync.success, true, bSync.error);
  assert.equal(idsOf((await B.send('getLogs')).logs).has(added.id), true, 'B의 다음 증분 회차가 A의 기록을 받는다');
  assert.equal((await adapter.requests(mark)).filter((r) => r.clientId === A.cid && r.kind === 'push').length, 1, '전제: 그 사이 A는 다시 보내지 않았다');

  // ③ 그 뒤 A가 같은 항목을 다시 보낸다. 그 요청의 D1 기록 행 쓰기가 0행이고 토큰이 ②에서 읽은 값과 같다.
  const mark2 = await adapter.requestCount();
  const resent = await syncDone(A);
  assert.equal(resent.success, true, resent.error);
  const resend = (await pushesOf(adapter, A, mark2)).find((r) => r.pushLogs >= 1);
  assert.ok(resend, '전제: A가 같은 항목을 다시 보냈다');
  assert.equal(resend.logWrites, 0, '재전송 요청의 D1 기록 행 쓰기가 0행이다');
  assert.equal(resend.writtenByTable.logs || 0, 0);
  assert.equal(resend.committed, false);
  assert.equal((await B.send('rawToken')).changeToken, tokenAfterCommit, '토큰이 ②에서 읽은 값과 같다');
});

// ════════════════════════════════════════════════════════════════
// 9. 강제 종료 시점: SIGKILL 뒤 같은 저장 파일로 다시 띄워도 기록이 줄지 않고 모두 서버에 올라간다
// ════════════════════════════════════════════════════════════════
// 서버의 페이지 크기와 묶음 크기를 하한인 25로 줄여 한 회차가 여러 요청으로 나뉘게 한다(클라이언트의 하한도 25다).
const NINE = { maxPageRows: 25, maxPushItems: 25 };

/** 재시작한 기기가 회차를 모두 마친 뒤 증분 회차를 한 번 더 돌고, 시계를 진행하기 전에 기기와 서버의 집합을 비교한다. */
async function finishAndCompare(h, device, key, preKillIds, label) {
  await relax(device);
  const done = await syncDone(device);
  assert.equal(done.success, true, `${label}: ${done.error}`);
  const incremental = await device.send('syncWithCloud', { allowFamilyCreation: false });
  assert.equal(incremental.success, true, `${label}: ${incremental.error}`);
  const deviceIds = idsOf((await device.send('getLogs')).logs);
  const lost = [...preKillIds].filter((id) => !deviceIds.has(id));
  assert.equal(lost.length, 0, `${label}: 종료 전에 있던 기록이 사라졌습니다 ${lost.slice(0, 3)}`);
  await assertSameSet(h.adapter, key, device, label);
}

const joinOnServer = async (h, key, serverCount, ownCount) => {
  await h.server.control('inject', { key, logs: logsWith('srv', serverCount, 2_000_000) });
  await h.D.send('setProfile', { patch: { syncKey: key } });
  await addLogs(h.D, logsWith('own', ownCount, 3_000_000));
  await relax(h.D);
};

await scenario('9-a', '강제 종료 시점: 전체 모드 당겨 받기 페이지 중간', ['D'], async (h) => {
  const { adapter, D } = h;
  const key = newKey();
  await joinOnServer(h, key, 120, 30);
  const gate = await adapter.holdNext({ kind: 'pull', clientId: D.cid }, { skip: 1 });
  const running = D.send('syncWithCloud', { allowFamilyCreation: false }).catch(() => undefined);
  await gate.held;
  await D.kill();
  await running;
  const ledger = storedLedger(D);
  assert.ok(ledger?.full && !(ledger.full.after.updatedAt === 0 && ledger.full.after.logId === ''), '전제: 전체 모드가 첫 페이지 뒤에서 끊겼다(full.after가 앞으로 갔다)');
  const preKillIds = idsOf(storedLogs(D));
  assert.ok(preKillIds.size >= 30 + 25, '전제: 받은 첫 페이지가 저장되어 있다');
  await gate.release();

  await D.restart();
  const mark = await adapter.requestCount();
  await finishAndCompare(h, D, key, preKillIds, '전체 모드 페이지 중간');
  const pulls = await pullsOf(adapter, D, mark);
  assert.deepEqual(pulls[0].pull.after, [ledger.full.after.updatedAt, ledger.full.after.logId], '재시작한 기기는 full.after부터 이어 받는다');
  assert.equal(pulls.filter(isFullPull).length, 0, '이미 받은 페이지를 처음부터 다시 받지 않는다');
  assert.equal((await serverPairs(adapter, key)).length, 150, '기기의 기록 30건이 모두 서버에 올라갔다');
}, NINE);

await scenario('9-b', '강제 종료 시점: 전체 모드 마지막 페이지 직후(올리기 전)', ['D'], async (h) => {
  const { adapter, D } = h;
  const key = newKey();
  await joinOnServer(h, key, 120, 30);
  // 마지막 페이지를 저장한 뒤 첫 올리기 요청이 서버에 닿으면(서버에서 멈춘다) 종료한다.
  const gate = await adapter.holdNext({ kind: 'push', clientId: D.cid, hasPushItems: true });
  const running = D.send('syncWithCloud', { allowFamilyCreation: false }).catch(() => undefined);
  await gate.held;
  await D.kill();
  await running;
  const ledger = storedLedger(D);
  assert.ok(ledger && !ledger.full && ledger.cursorMillis > 0, '전제: 전체 모드가 끝났고 장부가 바꿔 끼워졌다');
  assert.ok(Object.keys(ledger.uploaded).length >= 120, '전제: 받은 기록이 장부에 서버에 있는 것으로 적혔다');
  assert.equal((await serverPairs(adapter, key)).length, 120, '전제: 기기의 기록은 아직 서버에 올라가지 않았다');
  const preKillIds = idsOf(storedLogs(D));
  await gate.release();

  await D.restart();
  const mark = await adapter.requestCount();
  await finishAndCompare(h, D, key, preKillIds, '전체 모드 마지막 페이지 직후');
  assert.equal((await pullsOf(adapter, D, mark)).filter(isFullPull).length, 0, '전체 모드를 처음부터 다시 받지 않는다');
  assert.equal((await serverPairs(adapter, key)).length, 150);
}, NINE);

await scenario('9-c', '강제 종료 시점: 올리기 묶음 중간(요청 전송 후 응답 전), 재전송은 쓰기 0행', ['D'], async (h) => {
  const { adapter, D } = h;
  const key = newKey();
  await createFamily(D, key);
  assert.equal((await syncDone(D)).success, true);
  await addLogs(D, logsWith('own', 60, 3_000_000));
  await relax(D);
  // 두 번째 올리기 묶음은 서버가 확정한 뒤 응답을 내보내기 전에 멈춘다.
  const gate = await adapter.holdNext({ kind: 'push', clientId: D.cid, hasPushItems: true }, { skip: 1, at: 'response' });
  const running = D.send('syncWithCloud', { allowFamilyCreation: false }).catch(() => undefined);
  await gate.held;
  await D.kill();
  await running;
  const tokenBefore = (await adapter.family(key)).token;
  const onServer = (await serverPairs(adapter, key)).length;
  assert.equal(onServer, 50, '전제: 서버는 두 묶음(50건)을 이미 확정했다');
  const ledger = storedLedger(D);
  assert.equal(Object.keys(ledger.uploaded).length, 25, '전제: 장부에는 응답을 받은 첫 묶음 25건만 올림으로 적혀 있다');
  const preKillIds = idsOf(storedLogs(D));
  await gate.release();

  await D.restart();
  await relax(D);
  // 재시작한 기기가 보내는 두 번째 올리기 요청을 멈춰 두고, 첫 재전송 요청의 결과를 본다.
  const mark = await adapter.requestCount();
  const holdSecond = await adapter.holdNext({ kind: 'push', clientId: D.cid, hasPushItems: true }, { skip: 1 });
  const running2 = D.send('syncWithCloud', { allowFamilyCreation: false });
  await holdSecond.held;
  const resend = (await pushesOf(adapter, D, mark))[0];
  assert.equal(resend.pushLogs, 25, '전제: 재시작한 기기는 서버가 이미 확정한 묶음 25건을 다시 보낸다');
  assert.equal(resend.logWrites, 0, '재전송 요청의 D1 기록 행 쓰기가 0행이다');
  assert.equal(resend.committed, false);
  assert.equal((await adapter.family(key)).token, tokenBefore, '변경 토큰이 종료 직전 값과 같다');
  await holdSecond.release();
  assert.equal((await running2).success, true);
  await finishAndCompare(h, D, key, preKillIds, '올리기 묶음 중간');
  assert.equal((await serverPairs(adapter, key)).length, 60);
}, NINE);

await scenario('9-d', '강제 종료 시점: 올리기 마지막 묶음 직후', ['D'], async (h) => {
  const { adapter, D } = h;
  const key = newKey();
  await createFamily(D, key);
  assert.equal((await syncDone(D)).success, true);
  await addLogs(D, logsWith('own', 60, 3_000_000));
  await relax(D);
  // 세는 쓰기(기록과 장부)의 세 번째, 곧 세 번째 묶음의 응답 저장 직후 프로세스를 끝낸다.
  await D.send('injectStorageFault', { mode: 'exit', nth: 3 });
  await assert.rejects(D.send('syncWithCloud', { allowFamilyCreation: false }), /exited/);
  assert.equal(D.exitInfo.signal, 'SIGKILL');
  assert.equal((await serverPairs(adapter, key)).length, 60, '전제: 세 묶음(25, 25, 10건)이 모두 서버에 확정되었다');
  const ledger = storedLedger(D);
  assert.equal(Object.keys(ledger.uploaded).length, 60, '전제: 마지막 묶음의 저장까지 끝난 뒤 종료되었다');
  const preKillIds = idsOf(storedLogs(D));

  await D.restart();
  const mark = await adapter.requestCount();
  await finishAndCompare(h, D, key, preKillIds, '올리기 마지막 묶음 직후');
  assert.equal((await pushesOf(adapter, D, mark)).length, 0, '이미 올라간 기록을 다시 올리지 않는다');
}, NINE);

await scenario('9-e', '강제 종료 시점: 증분 당겨 받기 페이지 중간', ['D'], async (h) => {
  const { adapter, D } = h;
  const key = newKey();
  await createFamily(D, key);
  assert.equal((await syncDone(D)).success, true);
  await h.server.control('inject', { key, logs: logsWith('srv', 80, 2_000_000) });
  await relax(D);
  const gate = await adapter.holdNext({ kind: 'pull', clientId: D.cid }, { skip: 1 });
  const running = D.send('syncWithCloud', { allowFamilyCreation: false }).catch(() => undefined);
  await gate.held;
  await D.kill();
  await running;
  const ledger = storedLedger(D);
  assert.ok(ledger.pullAfter && !ledger.full, '전제: 증분 당겨 받기가 첫 페이지 뒤에서 끊겼다(pullAfter가 있다)');
  const preKillIds = idsOf(storedLogs(D));
  assert.equal(preKillIds.size, 25, '전제: 첫 페이지 25건이 저장되어 있다');
  await gate.release();

  await D.restart();
  const mark = await adapter.requestCount();
  await finishAndCompare(h, D, key, preKillIds, '증분 당겨 받기 페이지 중간');
  const pulls = await pullsOf(adapter, D, mark);
  assert.deepEqual(pulls[0].pull.after, [ledger.pullAfter.updatedAt, ledger.pullAfter.logId], '이어 받는 첫 요청은 pullAfter에서 시작한다(처음부터 다시 받지 않는다)');
  assert.equal(pulls.filter(isFullPull).length, 0);
}, NINE);

await scenario('9-f', '강제 종료 시점: 원자적 저장 도중(첫 쓰기 직후 종료), 시계를 진행하기 전 집합이 같다', ['D'], async (h) => {
  const { adapter, server, D } = h;
  const key = newKey();
  const T0 = 1_800_000_000_000;
  await server.control('clock', { set: T0 });
  await createFamily(D, key);
  assert.equal((await syncDone(D)).success, true);
  const cursorBefore = storedLedger(D).cursorMillis;
  // 기기의 커서(T0 - 2분)보다 새롭지만, 다음 회차의 커서 후보(T0 + 8분)보다는 오래된 행을 넣는다.
  await server.control('inject', { key, logs: logsWith('srv', 10, 2_000_000), serverTime: T0 + 30_000 });
  await server.control('clock', { set: T0 + 10 * MINUTE });
  await relax(D);
  await D.send('injectStorageFault', { mode: 'exit', nth: 1 });
  await assert.rejects(D.send('syncWithCloud', { allowFamilyCreation: false }), /exited/);
  assert.equal(D.exitInfo.signal, 'SIGKILL');
  const stored = storedLedger(D);
  const storedIds = idsOf(storedLogs(D));
  assert.ok(stored.cursorMillis > cursorBefore, '전제: 장부의 커서가 받은 페이지 뒤로 갔다');
  assert.equal([...storedIds].filter((id) => id.startsWith('srv-')).length, 10, '장부의 커서가 앞으로 간 만큼 기록도 함께 저장되어 있다(원자적 저장)');

  await D.restart();
  await finishAndCompare(h, D, key, storedIds, '원자적 저장 도중');
});

// ════════════════════════════════════════════════════════════════
// 10. 영구 삭제와 410 (결함 7, 불변 조건 4)
// ════════════════════════════════════════════════════════════════
const GONE = '이 가족 공유는 영구 삭제되었습니다.';
await scenario('10', '영구 삭제와 410: B는 410으로 연결을 끊고 기록은 남으며, 폴링은 멈추고, 같은 키로 만들어도 410이다', ['A', 'B'], async (h) => {
  const { adapter, server, A, B } = h;
  const key = newKey();
  await setupPair(h, key);
  await addLogs(B, logsWith('b', 5, 1_000_000));
  assert.equal((await syncDone(B)).success, true);
  assert.equal((await syncDone(A)).success, true);
  const bLogsBefore = (await B.send('getLogs')).logs.length;
  assert.equal(bLogsBefore, 5);

  // B의 변경 토큰 폴링(같은 폴링 코드, 90초 주기만 줄임)을 시작한다. 첫 확인이 성공할 때까지 기다린다.
  const pollerId = await sync.getSyncClientId();
  const poller = await startPoller(key);
  try {
    await waitForRequest(adapter, (r) => r.kind === 'token' && r.clientId === pollerId && r.status === 200, '폴링의 첫 토큰 확인');

    // A가 영구 삭제한다(냉각 기간 1시간을 서버 시계로 지나게 한다).
    assert.equal((await A.send('scheduleDeletion')).success, true);
    await adapter.advanceClock(HOUR + 1000);
    assert.equal((await A.send('deleteFamily')).success, true);
    const gone = await adapter.family(key);
    assert.deepEqual([gone.exists, gone.deleted], [false, true], '전제: 가족 행이 지워지고 삭제 기록이 남았다');

    // B의 다음 동기화(러너)가 410을 받아 연결을 끊는다. 기록은 그대로 남는다.
    const bResult = await B.send('runnerRequest', { request: { syncKey: key } });
    assert.equal(bResult.success, false);
    assert.equal(bResult.familyUnavailable, true);
    assert.equal((await B.send('getProfile')).profile.syncKey ?? null, null, 'B는 연결을 끊는다');
    assert.equal((await B.send('getLogs')).logs.length, bLogsBefore, '기록은 그대로 남는다');
    const { events } = await B.send('runnerEvents');
    assert.ok(events.some((e) => e.type === 'disconnected'), '러너 사건에 disconnected가 있다');
    assert.ok(!events.some((e) => e.type === 'failed' && !e.result?.familyUnavailable), '다른 실패 사건은 없다');

    // B의 폴링은 410을 받고 멈춘다(재연결하지 않는다).
    await waitUntil(() => poller.events.some((e) => e.type === 'error' && e.status === 410), '폴링이 410을 받았습니다');
    assert.equal(decideAfterTokenError({ status: 410 }).action, 'syncNow', '410이면 폴링을 멈추고 동기화를 한 번 요청한다');
    const tokenCalls = async () => (await adapter.requests()).filter((r) => r.kind === 'token' && r.clientId === pollerId).length;
    const callsAfter410 = await tokenCalls();
    await sleep(120 * 8);
    assert.equal(await tokenCalls(), callsAfter410, '410 뒤에는 토큰 요청이 더 나가지 않는다');
    assert.equal(poller.events.filter((e) => e.type === 'error').length, 1, '오류 통지는 한 번뿐이다');
  } finally {
    poller.stop();
  }

  // 같은 키로 allowCreate: true 연결을 보내도 410이고 가족이 생기지 않는다.
  const raw = await rawCall(server, key, '/api/family/connect', { body: { allowCreate: true } });
  assert.equal(raw.status, 410);
  assert.equal(raw.json.error, 'family_deleted');
  const viaDevice = await B.send('syncWithCloud', { syncKey: key, allowFamilyCreation: true });
  assert.equal(viaDevice.success, false);
  assert.equal(viaDevice.familyUnavailable, true, '기기의 가족 만들기 요청도 410이다');
  const after = await adapter.family(key);
  assert.deepEqual([after.exists, after.members.length], [false, 0], '가족도 회원도 다시 생기지 않았다');
  assert.equal((await adapter.logs(key)).rows.length, 0);
  for (const route of ['/api/family/token', '/api/family/deletion-status']) {
    assert.equal((await rawCall(server, key, route, { method: 'GET' })).status, 410, `${route}도 410`);
  }

  // 삭제와 생성 요청을 겹쳐도 같다: 생성 요청이 가족 읽기에서 "없음"을 보고 쓰기 배치에서 멈춘 사이에 가족이 만들어졌다가 영구 삭제된다.
  const overlapKey = newKey();
  await relax(B);
  const gate = await adapter.holdNext({ kind: 'connect', clientId: B.cid, batch: 'write' });
  const creating = B.send('syncWithCloud', { syncKey: overlapKey, allowFamilyCreation: true });
  await gate.held;
  assert.equal((await adapter.family(overlapKey)).exists, false, '전제: 멈춘 생성 요청은 아직 가족을 만들지 못했다');
  assert.equal((await rawCall(server, overlapKey, '/api/family/connect', { body: { allowCreate: true }, clientId: 'overlap-creator' })).json.isNewFamily, true);
  assert.equal((await rawCall(server, overlapKey, '/api/family/delete-schedule', { clientId: 'overlap-creator' })).status, 200);
  await adapter.advanceClock(HOUR + 1000);
  assert.equal((await rawCall(server, overlapKey, '/api/family/delete', { clientId: 'overlap-creator' })).status, 200);
  const overlapGone = await adapter.family(overlapKey);
  assert.deepEqual([overlapGone.exists, overlapGone.deleted], [false, true], '전제: 그 사이 가족이 만들어졌다가 영구 삭제되었다');
  await gate.release();
  const created = await creating;
  assert.equal(created.success, false);
  assert.equal(created.familyUnavailable, true, '겹친 생성 요청은 410이다');
  const overlapAfter = await adapter.family(overlapKey);
  assert.deepEqual([overlapAfter.exists, overlapAfter.members.length], [false, 0], '가족이 되살아나지 않았다');
});

// ════════════════════════════════════════════════════════════════
// 11. 404 보존 (결함 7, 불변 조건 3)
// ════════════════════════════════════════════════════════════════
await scenario('11', '404 보존: D1을 비워도 연결은 끊기지 않고 오류만 보이며, 되돌리면 이어진다', ['A', 'B', 'C'], async (h) => {
  const { adapter, server, A, B, C } = h;
  const key = newKey();
  const pair = { ...h, A, B };
  await setupPair(pair, key);
  await addLogs(A, logsWith('a', 6, 1_000_000));
  await addLogs(B, logsWith('b', 4, 2_000_000));
  for (const device of [A, B, A, B]) assert.equal((await syncDone(device)).success, true);
  await server.control('wipe', { scope: 'snapshot', name: 'before' });
  const logsBefore = { A: (await A.send('getLogs')).logs.length, B: (await B.send('getLogs')).logs.length };
  assert.deepEqual(logsBefore, { A: 10, B: 10 });

  const pollerId = await sync.getSyncClientId();
  const poller = await startPoller(key);
  try {
    await waitForRequest(adapter, (r) => r.kind === 'token' && r.clientId === pollerId && r.status === 200, '폴링의 첫 토큰 확인');
    // D1을 비운다(설정 오류 흉내).
    await server.control('wipe', { scope: 'all' });
    const wiped = await adapter.family(key);
    assert.deepEqual([wiped.exists, wiped.deleted], [false, false], '전제: 가족 행도 삭제 기록도 없다(404 상황)');

    // 두 기기의 동기화는 오류만 보이고 연결은 끊기지 않는다.
    const a = await A.send('runnerRequest', { request: { syncKey: key } });
    assert.equal(a.success, false);
    assert.equal(a.familyNotFound, true);
    assert.ok(!a.familyUnavailable);
    const b = await syncDone(B);
    assert.equal(b.success, false);
    assert.equal(b.familyNotFound, true);
    assert.ok(!b.familyUnavailable);
    for (const device of [A, B]) {
      assert.equal((await device.send('getProfile')).profile.syncKey, key, '연결은 끊기지 않는다');
      assert.equal((await device.send('getLogs')).logs.length, 10, '기록은 그대로다');
    }
    const { events } = await A.send('runnerEvents');
    assert.ok(events.some((e) => e.type === 'failed' && e.error.includes('서버에서 가족 정보를 찾지 못했습니다')), '404 오류 문장이 나온다');
    assert.ok(!events.some((e) => e.type === 'disconnected'), '연결 해제 사건은 없다');

    // 변경 토큰 폴링은 404에서 멈추지 않고 계속 시도한다(재연결 쪽 판정).
    assert.equal(decideAfterTokenError({ status: 404 }).action, 'reconnect');
    await waitUntil(() => poller.events.filter((e) => e.type === 'error' && e.status === 404).length >= 3, '폴링이 404 오류를 계속 받습니다');
    assert.ok(!poller.events.some((e) => e.status === 410), '폴링은 410을 받지 않았다');

    // D1을 되돌리면 동기화가 다시 이어진다.
    await server.control('wipe', { scope: 'restore', name: 'before' });
    const restored = await A.send('runnerRequest', { request: { syncKey: key } });
    assert.equal(restored.success, true, restored.error);
    assert.equal((await syncDone(B)).success, true);
    assert.equal((await syncDone(A)).success, true);
    await assertSameSet(adapter, key, A, 'A');
    await assertSameSet(adapter, key, B, 'B');
  } finally {
    poller.stop();
  }

  // 가족 합류에서 없는 키를 넣으면 합류 실패 메시지가 나오고 키는 저장되지 않는다.
  const unknown = newKey();
  const joined = await C.send('runnerRequest', { request: { syncKey: unknown, createBackup: true, connecting: true } });
  assert.equal(joined.success, false);
  assert.equal(joined.familyNotFound, true);
  assert.equal(joined.error, '초대 정보를 찾지 못했습니다. 초대 링크를 다시 받아 주세요.');
  assert.equal((await C.send('getProfile')).profile.syncKey ?? null, null, '합류 실패면 키가 저장되지 않는다');
  const cEvents = (await C.send('runnerEvents')).events;
  assert.ok(cEvents.some((e) => e.type === 'failed' && e.error.includes('초대 정보를 찾지 못했습니다')));
  assert.equal((await adapter.family(unknown)).exists, false, '없는 키로 가족이 생기지 않았다');
});

// ════════════════════════════════════════════════════════════════
// 12. 혼자 쓰기 (불변 조건 5)
// ════════════════════════════════════════════════════════════════
await scenario('12', '혼자 쓰기: syncKey 없이 기록을 추가, 수정, 삭제하고 앱을 다시 열어도 요청이 0회다', ['A'], async (h) => {
  const { adapter, A } = h;
  const first = await addSavedLog(A, 100);
  const second = await addSavedLog(A, 110);
  const third = await addSavedLog(A, 120);
  assert.equal((await A.send('updateLog', { log: { ...second, amount: 111 } })).ok, true);
  assert.equal((await A.send('deleteLog', { id: third.id })).ok, true);
  const someKey = newKey();
  const idle = await A.send('runnerRequest', { request: { syncKey: someKey } });
  assert.equal(idle.success, false, '키가 없는 러너 요청은 동기화하지 않는다');
  assert.equal((await A.send('syncWithCloud', {})).error, 'no syncKey locally');

  // 앱을 다시 연다(프로세스 재시작). 같은 저장 파일에서 기록이 그대로이고, 다시 요청해도 서버에 닿지 않는다.
  await A.restart();
  const logs = (await A.send('getLogs')).logs;
  assert.deepEqual(logs.map((l) => [l.id, l.amount]).sort(), [[first.id, 100], [second.id, 111]].sort(), '추가, 수정, 삭제가 저장되어 있다');
  assert.equal((await A.send('runnerRequest', { request: { syncKey: someKey } })).success, false);
  assert.equal((await A.send('syncWithCloud', {})).success, false);
  assert.equal((await A.send('getProfile')).profile.syncKey ?? null, null);
  assert.equal(await adapter.requestCount(), 0, '서버에 닿은 요청이 0회다');
});

// ════════════════════════════════════════════════════════════════
// 13. 장부 손상 (불변 조건 6)
// ════════════════════════════════════════════════════════════════
await scenario('13', '장부 손상: 깨진 값이나 다른 가족 장부는 전체 모드로 돌고 기록이 줄지 않으며 옛 키는 그대로다', ['A'], async (h) => {
  const { adapter, A } = h;
  const key = newKey();
  await createFamily(A, key);
  await addLogs(A, logsWith('own', 20, 1_000_000));
  assert.equal((await syncDone(A)).success, true);
  await A.send('writeStorage', { key: LEGACY_LEDGER_KEY, value: 'legacy-ledger-untouched' });
  const healthy = (await A.send('readLedger')).ledger;
  assert.equal(healthy.familyKey, key);
  const serverBefore = await serverPairs(adapter, key);
  assert.equal(serverBefore.length, 20);

  // 대조군: 장부가 멀쩡하면 다음 회차는 전체 모드가 아니다.
  let mark = await adapter.requestCount();
  assert.equal((await syncDone(A)).success, true);
  const control = await pullsOf(adapter, A, mark);
  assert.ok(control.length >= 1 && control.every((r) => !isFullPull(r)), '전제: 멀쩡한 장부면 증분 모드다');

  const variants = [
    ['깨진 JSON', async () => A.send('writeStorage', { key: LEDGER_KEY, value: '{not json' })],
    ['null', async () => A.send('writeStorage', { key: LEDGER_KEY, value: 'null' })],
    ['모양이 틀린 값', async () => A.send('writeStorage', { key: LEDGER_KEY, json: { familyKey: key, cursorMillis: 'x', uploaded: [], tombstoned: 3 } })],
    ['다른 가족의 장부(올림이라고 거짓으로 적힌 새 기록 포함)', async () => {
      const fresh = mkLog('claimed-new', 5_000_000);
      await addLogs(A, [fresh]);
      await A.send('writeStorage', {
        key: LEDGER_KEY,
        json: { ...healthy, familyKey: 'z'.repeat(32), uploaded: { ...healthy.uploaded, 'claimed-new': 5_000_000 } },
      });
    }],
  ];
  for (const [label, corrupt] of variants) {
    await corrupt();
    const logsBefore = (await A.send('getLogs')).logs;
    mark = await adapter.requestCount();
    const result = await syncDone(A);
    assert.equal(result.success, true, `${label}: ${result.error}`);
    const pulls = await pullsOf(adapter, A, mark);
    assert.ok(isFullPull(pulls[0]), `${label}: 첫 당겨 받기가 전체 모드다`);
    const logsAfter = (await A.send('getLogs')).logs;
    assert.ok(logsAfter.length >= logsBefore.length && [...idsOf(logsBefore)].every((id) => idsOf(logsAfter).has(id)), `${label}: 기록이 줄지 않는다`);
    const ledger = (await A.send('readLedger')).ledger;
    assert.equal(ledger.familyKey, key, `${label}: 장부가 새로 바르게 쓰였다`);
    assert.equal((await A.send('readStorage', { keys: [LEGACY_LEDGER_KEY] })).items[LEGACY_LEDGER_KEY], 'legacy-ledger-untouched', `${label}: 옛 키의 값은 그대로다`);
    await assertSameSet(adapter, key, A, label);
  }
  assert.ok((await serverPairs(adapter, key)).some(([id]) => id === 'claimed-new'), '거짓 장부가 새 기록의 올리기를 막지 못했다');
});

// ════════════════════════════════════════════════════════════════
// 14. 가져오기와 복원
// ════════════════════════════════════════════════════════════════
await scenario('14', '가져오기와 복원: 새 장부 키가 지워지고 다음 회차가 전체 모드로 돈다', [], async (h) => {
  const { adapter } = h;
  const key = newKey();
  await AsyncStorage.clear();
  const inProcessId = await sync.getSyncClientId();
  await adapter.ensureFamily(key);
  await storage.saveProfile({ ...await storage.getProfile(), syncKey: key, name: '가져오기' });
  await storage.saveLogs(logsWith('imp', 20, 1_000_000));
  const round = async () => {
    let result;
    for (let i = 0; i < 20; i += 1) {
      result = await sync.syncWithCloud(key, await storage.getLogs(), await storage.getProfile(), false, undefined, false);
      assert.equal(result.success, true, result.error);
      if (!result.continuing) break;
    }
    return result;
  };
  const firstPullAfter = async (mark) => (await adapter.requests(mark)).find((r) => r.kind === 'pull' && r.clientId === inProcessId)?.pull.after;
  await round();
  let mark = await adapter.requestCount();
  await round();
  assert.notDeepEqual(await firstPullAfter(mark), [0, ''], '대조군: 장부가 있으면 다음 회차는 증분 모드다');

  // 데이터 가져오기
  await AsyncStorage.setItem(LEGACY_LEDGER_KEY, 'legacy');
  assert.ok(await AsyncStorage.getItem(LEDGER_KEY), '전제: 새 장부 키가 있다');
  await storage.importDataWithoutLoss([], await storage.getProfile());
  assert.equal(await AsyncStorage.getItem(LEDGER_KEY), null, '가져오기 뒤 새 장부 키가 지워진다');
  mark = await adapter.requestCount();
  await round();
  assert.deepEqual(await firstPullAfter(mark), [0, ''], '가져오기 뒤 다음 회차는 전체 모드다');
  assert.equal((await storage.getLogs()).length, 20, '기록은 그대로다');

  // 백업 복원
  await round();
  assert.ok(await AsyncStorage.getItem(LEDGER_KEY), '전제: 장부가 다시 생겼다');
  await storage.backupLocalData();
  await storage.restoreFromLocalBackup();
  assert.equal(await AsyncStorage.getItem(LEDGER_KEY), null, '백업 복원 뒤 새 장부 키가 지워진다');
  mark = await adapter.requestCount();
  await round();
  assert.deepEqual(await firstPullAfter(mark), [0, ''], '백업 복원 뒤 다음 회차는 전체 모드다');
  assert.equal((await storage.getLogs()).length, 20, '기록은 그대로다');
  assert.equal((await adapter.logs(key)).live.length, 20);
});

// ════════════════════════════════════════════════════════════════
// 14-1. 서버 교체 뒤 다시 올리기 (2.6.1의 장부 바꿔 끼우기)
// ════════════════════════════════════════════════════════════════
await scenario('14-1', '서버 교체 뒤 다시 올리기: D1 기록을 비우고 6시간이 지나면 전체 모드 뒤 두 기기의 기록이 모두 다시 올라간다', ['A', 'B'], async (h) => {
  const { adapter, server, A, B } = h;
  const key = newKey();
  await setupPair(h, key);
  await addLogs(A, logsWith('a', 10, 1_000_000));
  await addLogs(B, logsWith('b', 10, 2_000_000));
  for (const device of [A, B, A, B]) assert.equal((await syncDone(device)).success, true);
  const doomed = (await A.send('getLogs')).logs.find((l) => l.id === 'a-0003');
  assert.equal((await A.send('deleteLog', { id: doomed.id })).ok, true);
  for (const device of [A, B, A, B]) assert.equal((await syncDone(device)).success, true);
  const live = await serverPairs(adapter, key);
  assert.equal(live.length, 19);
  assert.deepEqual((await adapter.logs(key)).deleted, ['a-0003']);

  // D1 기록만 비운다(가족 행은 남긴다).
  await server.control('wipe', { scope: 'logs' });
  const wiped = await adapter.family(key);
  assert.equal(wiped.exists, true);
  assert.equal((await adapter.logs(key)).rows.length, 0, '전제: 서버 기록이 모두 사라졌다');
  // 6시간을 지나게 한다.
  for (const device of [A, B]) await device.send('advanceClock', { ms: 6 * HOUR + 1000 });

  const mark = await adapter.requestCount();
  const a = await syncDone(A);
  assert.equal(a.success, true, a.error);
  assert.ok(isFullPull((await pullsOf(adapter, A, mark))[0]), '전제: 6시간이 지나 A의 회차는 전체 모드다');
  const b = await syncDone(B);
  assert.equal(b.success, true, b.error);
  assert.ok(isFullPull((await pullsOf(adapter, B, mark))[0]), '전제: B의 회차도 전체 모드다');
  assert.equal((await serverPairs(adapter, key)).length, 19, '두 기기의 기록이 모두 다시 올라갔다');
  assert.deepEqual((await adapter.logs(key)).deleted, ['a-0003'], '삭제 표식도 다시 올라갔다');
  await assertSameSet(adapter, key, A, 'A');
  await assertSameSet(adapter, key, B, 'B');
});

// ════════════════════════════════════════════════════════════════
// 14-2. 합치기 (결함 8, 러너)
// ════════════════════════════════════════════════════════════════
await scenario('14-2', '합치기: 올리기가 멈춘 사이 저장마다 요청한 평소 동기화가 합쳐져 회차는 두 번만 돈다', ['A'], async (h) => {
  const { adapter, A } = h;
  const key = newKey();
  await createFamily(A, key);
  assert.equal((await syncDone(A)).success, true);
  await relax(A);
  await A.send('runnerReset', { timeoutMs: 30_000 });
  const mark = await adapter.requestCount();

  // 러너로 평소 동기화를 하나 요청하고, 그 회차의 올리기 요청을 서버에서 멈춘다.
  const first = await addSavedLog(A, 200);
  const gate = await adapter.holdNext({ kind: 'push', clientId: A.cid, hasPushItems: true });
  const settled = [A.send('runnerRequest', { request: { syncKey: key } })];
  await gate.held;
  // 그 사이 기록을 다섯 번 저장하고 저장마다 평소 동기화를 요청한다(App이 저장 뒤 하는 일과 같다).
  const saved = [first];
  for (let i = 0; i < 5; i += 1) {
    saved.push(await addSavedLog(A, 201 + i));
    settled.push(A.send('runnerRequest', { request: { syncKey: key } }));
  }
  await gate.release();
  const outcomes = await Promise.all(settled);
  assert.ok(outcomes.every((r) => r.success), JSON.stringify(outcomes.map((r) => r.error)));

  const { events } = await A.send('runnerEvents');
  assert.equal(events.filter((e) => e.type === 'started').length, 2, '회차는 처음 것 하나와 합쳐진 것 하나, 모두 두 번이다');
  const reqs = await syncRequestsOf(adapter, A, mark);
  assert.equal(reqs.filter((r) => r.kind === 'pull').length, 2, '서버 요청 목록의 회차 수가 2다(증분 회차마다 당겨 받기 한 번)');
  const pushes = reqs.filter((r) => r.kind === 'push' && r.pushLogs > 0);
  assert.deepEqual(pushes.map((r) => r.pushLogs), [1, 5], '첫 회차는 기록 1건, 합쳐진 회차는 저장 다섯 번의 기록 5건을 한 번에 올린다');
  const live = idsOf((await serverPairs(adapter, key)).map(([id, raw]) => ({ id, raw })));
  assert.ok(saved.every((l) => live.has(l.id)), '여섯 기록이 모두 서버에 올라갔다');
  await assertSameSet(adapter, key, A, 'A');
});

// ════════════════════════════════════════════════════════════════
// 16. 요청 크기 조절 (2.6.2)
// ════════════════════════════════════════════════════════════════
const ledgerLimits = async (device) => (await device.send('readLedger')).ledger.limits;

await scenario('16', '요청 크기 조절: 503이면 절반이 되고 다음 회차는 줄어든 크기로 올리며, 하한 25 아래로 줄지 않는다', ['A'], async (h) => {
  const { adapter, A } = h;
  const key = newKey();
  await createFamily(A, key);
  assert.equal((await syncDone(A)).success, true);
  await A.send('seedLogs', { count: 1200, idPrefix: 'p', timestamp: 1_000_000 });

  // 올리기: 400건 묶음이 503으로 실패하면 limits.push가 200으로 줄고, 다음 회차가 200건 이하 묶음으로 나머지를 올린다.
  await adapter.failHttp({ status: 503, match: { kind: 'push', hasPushItems: true }, times: 1 });
  let mark = await adapter.requestCount();
  const failed = await A.send('syncWithCloud', { allowFamilyCreation: false });
  assert.equal(failed.success, false);
  const failedPush = (await pushesOf(adapter, A, mark))[0];
  assert.deepEqual([failedPush.pushLogs, failedPush.status], [400, 503], '전제: 400건 묶음이 503으로 실패했다');
  assert.equal((await ledgerLimits(A)).push, 200, '장부의 limits.push가 200으로 줄었다');
  await adapter.clearFaults();
  mark = await adapter.requestCount();
  const done = await syncDone(A);
  assert.equal(done.success, true, done.error);
  const sizes = (await pushesOf(adapter, A, mark)).map((r) => r.pushLogs);
  assert.ok(sizes.length >= 6 && sizes.every((n) => n <= 200), `다음 회차는 200건 이하 묶음이다 ${sizes}`);
  assert.equal((await serverPairs(adapter, key)).length, 1200, '나머지도 모두 올라갔다');

  // 당겨 받기: 503이면 limits.pull이 절반으로 줄고, 다음 당겨 받기 요청의 limit이 줄어든 값이다.
  await adapter.failHttp({ status: 503, match: { kind: 'pull' }, times: 1 });
  assert.equal((await A.send('syncWithCloud', { allowFamilyCreation: false })).success, false);
  assert.equal((await ledgerLimits(A)).pull, 250, '장부의 limits.pull이 250으로 줄었다');
  await adapter.clearFaults();
  mark = await adapter.requestCount();
  assert.equal((await syncDone(A)).success, true);
  assert.equal((await pullsOf(adapter, A, mark))[0].pull.limit, 250, '다음 당겨 받기는 250행 단위다');

  // 하한 25: 올리기는 200 -> 100 -> 50 -> 25 -> 25, 당겨 받기는 250 -> 125 -> 62 -> 31 -> 25 -> 25.
  await adapter.failHttp({ status: 503, match: { kind: 'pull' }, times: 'always' });
  const pullSteps = [];
  for (let i = 0; i < 5; i += 1) {
    await A.send('syncWithCloud', { allowFamilyCreation: false });
    pullSteps.push((await ledgerLimits(A)).pull);
  }
  assert.deepEqual(pullSteps, [125, 62, 31, 25, 25], '당겨 받기 크기는 하한 25에서 더 줄지 않는다');
  await adapter.clearFaults();
  await A.send('seedLogs', { count: 30, idPrefix: 'q', timestamp: 2_000_000 });
  await adapter.failHttp({ status: 503, match: { kind: 'push', hasPushItems: true }, times: 'always' });
  const pushSteps = [];
  for (let i = 0; i < 5; i += 1) {
    await A.send('syncWithCloud', { allowFamilyCreation: false });
    pushSteps.push((await ledgerLimits(A)).push);
  }
  assert.deepEqual(pushSteps, [100, 50, 25, 25, 25], '올리기 크기는 하한 25에서 더 줄지 않는다');
  await adapter.clearFaults();
});

await scenario('16', '요청 크기 조절: 서버 힌트는 장부에 저장되어 재시작 뒤 첫 묶음부터 따르고, 연속 10회 성공하면 두 배로 돌아가되 힌트를 넘지 않는다', ['A'], async (h) => {
  const { adapter, A } = h;
  const key = newKey();
  await createFamily(A, key);
  assert.equal((await syncDone(A)).success, true);

  // 서버 상수 maxPushItems를 100으로 낮춘다. 변화가 없는 회차의 응답만으로 힌트가 장부에 저장된다.
  await adapter.setLimits({ maxPushItems: 100 });
  assert.equal((await A.send('syncWithCloud', { allowFamilyCreation: false })).success, true);
  const hinted = await ledgerLimits(A);
  assert.equal(hinted.serverPush, 100, '서버 힌트가 장부에 저장되었다');
  assert.equal(hinted.push, 400, '장부의 크기 값은 그대로 400이다(힌트와 상관없이 적용된다)');
  await A.send('seedLogs', { count: 450, idPrefix: 'h1', timestamp: 1_000_000 });
  let mark = await adapter.requestCount();
  assert.equal((await syncDone(A)).success, true);
  let sizes = (await pushesOf(adapter, A, mark)).map((r) => r.pushLogs);
  assert.ok(sizes.length >= 5 && sizes.every((n) => n <= 100), `장부 값과 상관없이 묶음이 100건 이하다 ${sizes}`);

  // 기기 프로세스를 다시 띄워도 첫 묶음부터 100건 이하다(힌트가 장부에 있으므로).
  await A.restart();
  await A.send('seedLogs', { count: 300, idPrefix: 'h2', timestamp: 2_000_000 });
  mark = await adapter.requestCount();
  assert.equal((await syncDone(A)).success, true);
  const afterRestart = await pushesOf(adapter, A, mark);
  assert.ok(afterRestart.length >= 3 && afterRestart[0].pushLogs <= 100, `재시작 뒤 첫 묶음부터 100건 이하다 (${afterRestart[0]?.pushLogs})`);
  assert.ok(afterRestart.every((r) => r.pushLogs <= 100));

  // 503을 두 번 겪어 크기를 하한 25로 줄인다(유효 크기 100 -> 50 -> 25).
  await A.send('seedLogs', { count: 30, idPrefix: 'h3', timestamp: 3_000_000 });
  await adapter.failHttp({ status: 503, match: { kind: 'push', hasPushItems: true }, times: 2 });
  for (let i = 0; i < 2; i += 1) assert.equal((await A.send('syncWithCloud', { allowFamilyCreation: false })).success, false);
  await adapter.clearFaults();
  assert.equal((await ledgerLimits(A)).push, 25, '전제: 크기가 하한 25까지 줄었다');
  assert.equal((await ledgerLimits(A)).serverPush, 100);

  // 연속 10회 성공할 때마다 두 배로 돌아간다: 25 x 10, 50 x 10, 100 x 10. 힌트가 100이라 그 위로는 늘지 않고 실패 회차도 없다.
  await A.send('seedLogs', { count: 2900, idPrefix: 'g', timestamp: 4_000_000 });
  mark = await adapter.requestCount();
  const grown = await syncDone(A, {}, 120);
  assert.equal(grown.success, true, grown.error);
  const pushes = await pushesOf(adapter, A, mark);
  sizes = pushes.map((r) => r.pushLogs);
  assert.deepEqual(sizes.slice(0, 10), Array(10).fill(25), '연속 10회 성공 전에는 25건 묶음이다');
  assert.deepEqual(sizes.slice(10, 20), Array(10).fill(50), '10회 성공 뒤 두 배(50건)로 돌아갔다');
  assert.deepEqual(sizes.slice(20, 30), Array(10).fill(100), '다시 10회 성공 뒤 두 배(100건)로 돌아갔다');
  assert.ok(sizes.slice(30).every((n) => n <= 100), `힌트 100을 넘지 않는다 ${sizes.slice(30)}`);
  assert.ok(sizes.length > 30, '전제: 힌트 위로 늘어날 기회(연속 10회 성공)를 넘겨 계속 올렸다');
  assert.ok(pushes.every((r) => r.status === 200), '그 뒤 실패 회차가 없다');
  assert.equal((await ledgerLimits(A)).push, 100, '장부의 크기 값은 힌트 100에서 멈춘다');
  assert.equal((await serverPairs(adapter, key)).length, 450 + 300 + 30 + 2900);
});

await scenario('16', '요청 크기 조절: 900KB를 넘는 기록 하나는 oversizedIds로 알리고 나머지 기록은 모두 올라간다', ['A'], async (h) => {
  const { adapter, A } = h;
  const key = newKey();
  await createFamily(A, key);
  assert.equal((await syncDone(A)).success, true);
  const huge = mkLog('huge', 1_000_000, { notes: 'x'.repeat(950 * 1024) });
  await addLogs(A, [huge, ...logsWith('small', 5, 2_000_000)]);
  const result = await A.send('syncWithCloud', { allowFamilyCreation: false });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.oversizedIds, ['huge']);
  assert.deepEqual((await serverPairs(adapter, key)).map(([id]) => id), ['small-0000', 'small-0001', 'small-0002', 'small-0003', 'small-0004'], '나머지 기록은 모두 올라갔다');
  assert.equal(idsOf((await A.send('getLogs')).logs).has('huge'), true, '큰 기록도 기기에는 그대로 있다');
  await A.send('runnerEvents', { clear: true });
  const runner = await A.send('runnerRequest', { request: { syncKey: key } });
  assert.equal(runner.success, true);
  const succeeded = (await A.send('runnerEvents')).events.find((e) => e.type === 'succeeded');
  assert.equal(succeeded.notice, '공유하지 못한 기록이 있습니다(너무 큼)', '동기화 상태에 안내 문구가 실린다');
});

// ════════════════════════════════════════════════════════════════
// 16-a. 당겨 받기 실패 뒤 올리기
// ════════════════════════════════════════════════════════════════
await scenario('16-a', '당겨 받기 실패 뒤 올리기: 503이면 같은 회차에 올리기가 나가고, 네트워크 끊김이면 올리기 없이 끝난다', ['A'], async (h) => {
  const { adapter, server, A } = h;
  const key = newKey();
  await adapter.ensureFamily(key);
  await A.send('setProfile', { patch: { syncKey: key } });
  await addLogs(A, logsWith('own', 5, 1_000_000));

  // 전체 모드 회차의 첫 페이지 요청에 503을 주입한다.
  await adapter.failHttp({ status: 503, match: { kind: 'pull' }, times: 1 });
  let mark = await adapter.requestCount();
  const result = await A.send('syncWithCloud', { allowFamilyCreation: false });
  assert.equal(result.success, false);
  const requests = await syncRequestsOf(adapter, A, mark);
  assert.deepEqual([requests[0].kind, requests[0].status], ['pull', 503], '전제: 전체 모드 첫 페이지 요청이 503이다');
  assert.ok(isFullPull(requests[0]), '전제: 첫 요청은 전체 모드의 당겨 받기다');
  const pushed = requests.filter((r) => r.kind === 'push' && r.pushLogs > 0);
  assert.equal(pushed.length, 1, '같은 회차의 올리기 요청이 나갔다');
  assert.equal((await serverPairs(adapter, key)).length, 5, '새 기록이 서버에 올라갔다');
  assert.equal((await ledgerLimits(A)).pull, 250, 'limits.pull이 절반으로 줄었다');
  await adapter.clearFaults();

  // 네트워크 끊김을 흉내 내면(서버 프로세스가 연결을 끊음) 그 회차는 올리기 없이 끝난다.
  await addLogs(A, logsWith('more', 3, 2_000_000));
  await server.control('fail', { op: 'add', mode: 'drop', match: { kind: 'pull' }, times: 1 });
  mark = await adapter.requestCount();
  const dropped = await A.send('syncWithCloud', { allowFamilyCreation: false });
  assert.equal(dropped.success, false);
  const droppedRequests = await syncRequestsOf(adapter, A, mark);
  assert.equal(droppedRequests.length, 1, '요청이 하나뿐이다');
  assert.deepEqual([droppedRequests[0].kind, droppedRequests[0].dropped], ['pull', true]);
  assert.equal((await serverPairs(adapter, key)).length, 5, '올리기 없이 끝났다(새 기록 3건은 서버에 없다)');
  assert.equal((await ledgerLimits(A)).pull, 250, '네트워크 끊김은 크기를 바꾸지 않는다');
  await adapter.clearFaults();
  assert.equal((await syncDone(A)).success, true);
  assert.equal((await serverPairs(adapter, key)).length, 8, '다음 회차에 모두 올라간다');
});

// ════════════════════════════════════════════════════════════════
// 16-b. 하한에서 시간 초과
// ════════════════════════════════════════════════════════════════
await scenario('16-b', '하한에서 시간 초과: limits.pull이 25인 상태의 시간 초과는 pullTooSlow이고 크기는 그대로다', ['A'], async (h) => {
  const { adapter, A } = h;
  const key = newKey();
  await createFamily(A, key);
  assert.equal((await syncDone(A)).success, true);
  await A.send('runnerReset', {});

  // 대조군: 크기가 25보다 크면 같은 시간 초과는 pullTooSlow가 아니고 크기가 절반으로 준다.
  const slow = await adapter.delay({ kind: 'pull' }, 2500);
  const control = await A.send('runnerRequest', { request: { syncKey: key } });
  assert.equal(control.success, false);
  assert.ok(!control.pullTooSlow, '전제: 크기가 25보다 크면 pullTooSlow가 아니다');
  assert.equal((await ledgerLimits(A)).pull, 250);
  await slow.clear();
  await adapter.quiesce();

  // limits.pull을 25로 맞춘다.
  const ledger = (await A.send('readLedger')).ledger;
  await A.send('writeStorage', { key: LEDGER_KEY, json: { ...ledger, limits: { ...ledger.limits, pull: 25 } } });
  assert.equal((await ledgerLimits(A)).pull, 25);
  await A.send('runnerReset', {});
  const slow2 = await adapter.delay({ kind: 'pull' }, 2500);
  const result = await A.send('runnerRequest', { request: { syncKey: key } });
  assert.equal(result.success, false);
  assert.equal(result.pullTooSlow, true, '결과에 pullTooSlow: true가 있다');
  assert.equal(result.error, '네트워크가 느려 기록을 받지 못했습니다. 와이파이에서 다시 시도해 주세요.');
  assert.equal((await ledgerLimits(A)).pull, 25, '크기는 25 그대로다');
  const { events } = await A.send('runnerEvents');
  assert.ok(events.some((e) => e.type === 'failed' && e.result?.pullTooSlow === true), '러너 사건이 failed다');
  assert.ok(!events.some((e) => e.type === 'succeeded'));
  await slow2.clear();
  await adapter.quiesce();
});

// ════════════════════════════════════════════════════════════════
// 17. 아기 정보 가드 (실제 서버로 할 수 있는 부분)
// ════════════════════════════════════════════════════════════════
await scenario('17', '아기 정보 가드: shared_json이 NULL이면 remoteProfile이 없고, 일부 항목만 있는 pushProfile은 거부되며 shared_json이 바뀌지 않는다', ['A'], async (h) => {
  const { adapter, server } = h;
  const key = newKey();
  const call = (body) => rawCall(server, key, '/api/family/sync', { body });
  assert.equal((await rawCall(server, key, '/api/family/connect', { body: { allowCreate: true } })).json.isNewFamily, true);
  assert.equal((await adapter.family(key)).sharedJson, null, '전제: 아무 기기도 아기 정보를 올리지 않았다(shared_json이 NULL)');

  // 기록만 올린 상태: 응답에 remoteProfile이 없다(빈 객체도 아니다).
  const pushed = await call({ pushLogs: [mkLog('r1', 5)] });
  assert.equal(pushed.status, 200);
  assert.deepEqual(pushed.json.acceptedIds, ['r1']);
  assert.equal('remoteProfile' in pushed.json, false, '올리기 응답에 remoteProfile이 없다');
  const pulled = await call({ pull: { afterUpdatedAt: 0, afterLogId: '', limit: 25 } });
  assert.equal('remoteProfile' in pulled.json, false, '당겨 받기 응답에도 remoteProfile이 없다');

  // 일부 항목만 있거나 형식이 틀린 pushProfile: profileRejected이고 shared_json은 NULL 그대로이며 기록은 그대로 처리된다.
  const complete = { name: '정상', birthDate: '2024-01-02', birthWeight: '3.1', targetFormula: 700, sharedUpdatedAt: 10 };
  const broken = [
    { name: '일부', sharedUpdatedAt: 5 },
    { ...complete, targetFormula: '700' },
    { ...complete, name: 7 },
    { ...complete, birthWeight: undefined },
    { ...complete, targetFormula: null },
    { ...complete, sharedUpdatedAt: 'x' },
    {},
  ];
  for (const [i, pushProfile] of broken.entries()) {
    const res = await call({ pushLogs: [mkLog(`r-broken-${i}`, 6 + i)], pushProfile });
    assert.equal(res.status, 200);
    assert.equal(res.json.profileRejected, true, `불완전한 pushProfile #${i}는 거부된다`);
    assert.equal('remoteProfile' in res.json, false, `거부된 뒤에도 shared_json이 NULL이라 remoteProfile이 없다 #${i}`);
    assert.equal((await adapter.family(key)).sharedJson, null, `shared_json이 바뀌지 않는다 #${i}`);
    assert.ok(res.json.acceptedIds.includes(`r-broken-${i}`), '기록 처리는 그대로 한다');
  }

  // 완전한 아기 정보는 받아들이고, 그 뒤의 불완전한 정보는 더 큰 sharedUpdatedAt이어도 shared_json을 바꾸지 못한다.
  const accepted = await call({ pushProfile: complete });
  assert.ok(!accepted.json.profileRejected);
  assert.deepEqual(accepted.json.remoteProfile, complete);
  const before = await adapter.family(key);
  assert.notEqual(before.sharedJson, null);
  for (const pushProfile of [{ name: '망가짐', sharedUpdatedAt: 999 }, { ...complete, targetFormula: '1', sharedUpdatedAt: 999 }]) {
    const res = await call({ pushProfile });
    assert.equal(res.json.profileRejected, true);
    assert.deepEqual(res.json.remoteProfile, complete, '응답의 remoteProfile은 서버에 저장된 값 그대로다');
  }
  const after = await adapter.family(key);
  assert.equal(after.sharedJson, before.sharedJson, 'shared_json이 바뀌지 않았다');
  assert.equal(after.profileUpdatedAt, before.profileUpdatedAt);
  assert.equal(after.token, before.token, '변경 토큰도 바뀌지 않았다');

  // 빈 문자열 이름도 완전한 아기 정보이고 응답에서 undefined로 바뀌지 않는다.
  const empty = { ...complete, name: '', sharedUpdatedAt: 20 };
  const res = await call({ pushProfile: empty });
  assert.equal(res.json.remoteProfile.name, '', '빈 문자열 이름이 그대로 돌아온다');
});

// 시나리오 17의 응답 조작(불완전한 remoteProfile 주입)과 18(서버 분류가 항상 "받아들이지 않음")은 실제 Worker 코드로는 만들 수 없어
// regression.mjs 의 가짜 Worker 모드가 맡습니다. 위 17은 실제 서버로 판정할 수 있는 부분(shared_json NULL, 불완전한 pushProfile)입니다.
if (!only) console.log('참고: 시나리오 18과 17의 응답 조작 부분은 regression.mjs(가짜 Worker 모드)에서 판정합니다.');

const failedCount = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오(둘째 묶음) ${results.length - failedCount}/${results.length} 통과${failedCount ? `, 실패 ${failedCount}` : ''}`);
process.exit(failedCount ? 1 : 0);
