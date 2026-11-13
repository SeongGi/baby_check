// 실제 서버 모드 시나리오: 상대 기기 기록 알림의 device-real 대량 업로드 시험(02 설계 6장 "대량 업로드 시나리오").
// 실제 Worker 코드(server/src/index.ts, push.ts)를 서버 프로세스로 띄우고 기기를 프로세스로 따로 띄웁니다.
// 알림은 서버의 가짜 Expo(fake-expo.mjs, 127.0.0.1)가 받은 메시지 수로 판정합니다. 외부 네트워크는 호출하지 않습니다.
// 기기 앱은 푸시 토큰을 등록하지 않으므로(RN 모듈 없음) 시나리오가 push-register를 직접 부르고, 기기의 clientId를 그대로 씁니다.
//
// 지키려는 것:
//   - 새 기록 한 번의 동기화는 받는 기기마다 메시지 1개이고 보낸 기기에는 가지 않는다(PD1, PD2).
//   - 수정, 삭제, 같은 버전 재전송, 전체 대조, 백업 복원, 오래된 기록의 첫 업로드, 한 요청에 40건을 넘는 업로드는 0개다.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-push.mjs
//       HARNESS_ONLY=PD1,PD5 bash tools/sync-harness/verify.sh scenario real-scenarios-push.mjs   (일부만)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { make179Storage, selfCheckDevices, startRealHarness } from './real-harness.mjs';

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];

// ────────────── 시나리오 뼈대 ──────────────
const scenario = async (id, title, deviceNames, deviceOptions, fn) => {
  if (ONLY && !ONLY.includes(id)) return;
  const started = Date.now();
  let harness = null;
  try {
    harness = await startRealHarness({ devices: deviceNames, deviceOptions });
    const { server, devices } = harness;
    await fn({ harness, server, fs: server.fs, adapter: server.adapter, devices: deviceNames.map((name) => devices[name]) });
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
const MIN = 60_000;
const HOUR = 60 * MIN;
const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const ALL_TYPES = ['formula', 'urine', 'stool', 'bath', 'weight', 'temperature', 'sleep', 'tummyTime', 'play'];
/** 서버 정규식(16~64자 [A-Za-z0-9_-])을 통과하는 32자 키. */
const keyOf = (tag) => tag + createHash('sha256').update(tag).digest('hex').slice(0, 32 - tag.length);
const sum = (items, pick) => items.reduce((n, item) => n + pick(item), 0);
const isFullPull = (r) => Boolean(r.pull) && r.pull.after[0] === 0 && r.pull.after[1] === '';
const pushRequests = (reqs) => reqs.filter((r) => r.kind === 'push');

const newKey = async (device) => (await device.send('newFamilyKey')).key;
const clientIdOf = async (device) => (await device.send('getSyncClientId')).clientId;
const joinKey = (device, key) => device.send('setProfile', { patch: { syncKey: key } });
const createRound = (device, key) => device.send('syncWithCloud', { syncKey: key, allowFamilyCreation: true });
const getLogs = async (device) => (await device.send('getLogs')).logs;
/** 앱과 같은 addLog로 기록을 넣습니다. id는 저장소가 정하므로 저장된 기록을 돌려줍니다. */
const addLog = async (device, fields) => {
  const { saved } = await device.send('addLog', { log: { type: 'formula', amount: 100, ...fields } });
  assert.ok(saved?.id, `${device.name} addLog 실패`);
  return saved;
};

async function sync(device, extra = {}) {
  const result = await device.send('syncWithCloud', { allowFamilyCreation: false, ...extra });
  assert.equal(result.success, true, `${device.name} 동기화 실패: ${result.error}`);
  return result;
}

/** continuing이 끝날 때까지 회차를 반복합니다. */
async function syncUntilDone(device, extra = {}, max = 40) {
  for (let i = 0; i < max; i += 1) {
    const result = await sync(device, extra);
    if (!result.continuing) return result;
  }
  throw new Error(`${device.name}이 ${max}회차 안에 끝나지 않았습니다`);
}

const logOf = (id, extra = {}) => ({ id, type: 'formula', amount: 100, timestamp: Date.now() - 3 * HOUR, updatedAt: Date.now(), ...extra });
/** timestamp가 base부터 1초씩 늘어나는 분유 기록 n건 */
const logsOf = (n, prefix, base) => Array.from({ length: n }, (_, i) => logOf(`${prefix}-${String(i).padStart(4, '0')}`, { timestamp: base + i * 1000 }));

// 가짜 Expo 도우미
const settle = (server) => server.control('background', { op: 'wait' });
const expoRequests = async (server) => { await settle(server); return (await server.control('expo', { op: 'requests' })).requests; };
const expoMessages = async (server) => { await settle(server); return (await server.control('expo', { op: 'requests' })).messages; };
const expoReset = async (server) => { await settle(server); await server.control('expo', { op: 'reset' }); };

async function pushRegister(server, key, clientId, token) {
  const res = await fetch(`${server.url}/api/family/push-register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, types: ALL_TYPES, quietStart: null, quietEnd: null, tzOffsetMinutes: 540 }),
  });
  assert.equal(res.status, 200, `push-register ${clientId}: ${res.status}`);
}

/**
 * 가족 하나에 기기 둘을 만듭니다. A가 가족을 만들고 B가 합류한 뒤 둘 다 회원이 되면 푸시 토큰을 등록하고 가짜 Expo 기록을 비웁니다.
 * `registerA: false`면 B만 등록합니다.
 */
async function setupPair({ server, devices: [A, B] }, key, { registerA = true } = {}) {
  assert.equal((await createRound(A, key)).success, true);
  await joinKey(B, key);
  await sync(B);
  await sync(A);
  if (registerA) await pushRegister(server, key, await clientIdOf(A), TOKEN_A);
  await pushRegister(server, key, await clientIdOf(B), TOKEN_B);
  await expoReset(server);
}

const bodiesOf = (messages) => messages.map((m) => m.body);

// ════════════════════════════════ PD1. 새 기록 한 건 ════════════════════════════════
await scenario('PD1', '새 기록: A가 방금 입력한 분유 기록의 동기화는 B에 메시지 1개이고 A 자신에게는 가지 않는다', ['spA', 'spB'], {}, async (ctx) => {
  const { harness, server, devices: [A, B] } = ctx;
  await selfCheckDevices(harness);
  const key = await newKey(A);
  await setupPair(ctx, key);

  const saved = await addLog(A, { amount: 120, timestamp: Date.now() - 20_000 });
  await sync(A);
  const requests = await expoRequests(server);
  const messages = requests.flatMap((r) => r.messages);
  assert.equal(requests.length, 1, `Expo 요청 수 ${requests.length}`);
  assert.equal(messages.length, 1, `Expo 메시지 수 ${messages.length}`);
  assert.deepEqual(messages.map((m) => m.to), [TOKEN_B], '받는 기기는 B뿐이어야 한다(보낸 기기 A 제외)');
  assert.match(messages[0].body, /분유 120ml/);
  assert.match(messages[0].title, /새 기록$/);
  assert.equal(messages[0].data.kind, 'partnerLog');
  assert.equal(messages[0].data.logId, saved.id);
  assert.equal(messages[0].data.type, 'formula');

  // 알림과 별개로 동기화는 그대로 B에 기록을 전한다.
  await sync(B);
  assert.ok((await getLogs(B)).some((l) => l.id === saved.id), 'B가 기록을 받지 못했다');
  // B의 이어진 동기화는 알림을 더 만들지 않는다.
  assert.equal((await expoMessages(server)).length, 1);
});

// ════════════════════════════════ PD2. 한 번에 여러 건은 한 메시지로 묶는다 ════════════════════════════════
await scenario('PD2', '여러 건: 한 동기화에 새 기록 3건이 함께 올라가면 B에 묶음 메시지 1개(" 외 2건")다', ['spA', 'spB'], {}, async (ctx) => {
  const { server, devices: [A, B] } = ctx;
  const key = await newKey(A);
  await setupPair(ctx, key);

  const now = Date.now();
  const ids = [
    (await addLog(A, { type: 'urine', timestamp: now - 3 * MIN })).id,
    (await addLog(A, { type: 'stool', timestamp: now - 2 * MIN })).id,
    (await addLog(A, { type: 'bath', durationMinutes: 15, timestamp: now - MIN })).id,
  ];
  await sync(A);
  const requests = await expoRequests(server);
  const messages = requests.flatMap((r) => r.messages);
  assert.equal(requests.length, 1);
  assert.equal(messages.length, 1, `묶음이어야 한다: ${JSON.stringify(bodiesOf(messages))}`);
  assert.equal(messages[0].to, TOKEN_B);
  assert.match(messages[0].body, /목욕 15분/, '가장 늦은 기록의 요약이 앞에 온다');
  assert.match(messages[0].body, / 외 2건$/);
  await sync(B);
  assert.equal((await getLogs(B)).filter((l) => ids.includes(l.id)).length, 3);
});

// ════════════════════════════════ PD3. 수정, 삭제, 같은 버전 재전송 ════════════════════════════════
await scenario('PD3', '수정과 재전송: 알린 기록을 고치고 지우고 같은 버전을 다시 올려도 추가 메시지는 0개다', ['spA', 'spB'], {}, async (ctx) => {
  const { adapter, server, devices: [A, B] } = ctx;
  const key = await newKey(A);
  await setupPair(ctx, key);

  // 대조군: 새 기록은 알림이 간다.
  const pd3 = await addLog(A, { amount: 90, timestamp: Date.now() - 30_000 });
  await sync(A);
  assert.equal((await expoMessages(server)).length, 1, '대조군: 새 기록은 메시지 1개');
  await expoReset(server);

  // 수정
  const target = (await getLogs(A)).find((l) => l.id === pd3.id);
  await A.send('updateLog', { log: { ...target, amount: 130, updatedAt: Date.now() + 1 } });
  let mark = await adapter.requestCount();
  await sync(A);
  assert.ok(sum(pushRequests(await adapter.requests(mark)), (r) => r.pushLogs) >= 1, '전제: 수정한 기록이 올라갔다');
  assert.equal((await expoMessages(server)).length, 0, '수정이 알림을 보냈다');

  // 같은 버전 재전송
  assert.ok((await A.send('forgetUploaded', {})).removed >= 1);
  mark = await adapter.requestCount();
  await sync(A);
  assert.ok(sum(pushRequests(await adapter.requests(mark)), (r) => r.pushLogs) >= 1, '전제: 같은 버전을 다시 올렸다');
  assert.equal((await expoMessages(server)).length, 0, '같은 버전 재전송이 알림을 보냈다');

  // 삭제
  await sync(B);
  assert.equal((await A.send('deleteLog', { id: pd3.id })).ok, true);
  await sync(A);
  assert.ok((await adapter.logs(key)).deleted.includes(pd3.id), '전제: 삭제 표식이 서버에 올라갔다');
  assert.equal((await expoMessages(server)).length, 0, '삭제가 알림을 보냈다');
});

// ════════════════════════════════ PD4~PD6. 첫 연결 대량 업로드 ════════════════════════════════
// 이미 알림을 켠 B가 있는 가족에 A가 로컬 기록을 가진 채 처음 합류해 올린다(1.8.x 이전, 다른 가족에서 옮겨 온 기록 등).
async function joinWithLocalLogs(ctx, key, logs) {
  const { devices: [A, B] } = ctx;
  assert.equal((await createRound(B, key)).success, true);
  await pushRegister(ctx.server, key, await clientIdOf(B), TOKEN_B);
  await expoReset(ctx.server);
  await joinKey(A, key);
  await A.send('saveLogs', { logs });
  const mark = await ctx.adapter.requestCount();
  await syncUntilDone(A);
  return { pushed: pushRequests(await ctx.adapter.requests(mark)) };
}

await scenario('PD4', '첫 업로드: 오래된 기록 125건을 처음 올리면 메시지 0개다', ['spA', 'spB'], {}, async (ctx) => {
  const { adapter, server } = ctx;
  const key = await newKey(ctx.devices[0]);
  const { pushed } = await joinWithLocalLogs(ctx, key, logsOf(125, 'pd4-old', Date.now() - 6 * HOUR));
  assert.ok(sum(pushed, (r) => r.pushLogs) >= 125, `전제: 125건이 올라갔다 ${sum(pushed, (r) => r.pushLogs)}`);
  assert.equal((await adapter.logs(key)).live.length, 125);
  assert.equal((await expoMessages(server)).length, 0);
});

await scenario('PD4b', '첫 업로드(상한 아래): 오래된 기록 30건을 처음 올려도 메시지 0개다(40건 상한이 아니라 30분 조건이 막는다)', ['spA', 'spB'], {}, async (ctx) => {
  const { adapter, server } = ctx;
  const key = await newKey(ctx.devices[0]);
  const { pushed } = await joinWithLocalLogs(ctx, key, logsOf(30, 'pd4b-old', Date.now() - 6 * HOUR));
  assert.ok(sum(pushed, (r) => r.pushLogs) >= 30, '전제: 30건이 올라갔다');
  assert.equal((await adapter.logs(key)).live.length, 30);
  assert.equal((await expoMessages(server)).length, 0, '오래된 기록이 알림을 보냈다');
});

await scenario('PD5', '첫 업로드 상한: 30분 안 기록 45건이 한 요청에 올라가면 40건 상한으로 메시지 0개다', ['spA', 'spB'], {}, async (ctx) => {
  const { adapter, server } = ctx;
  const key = await newKey(ctx.devices[0]);
  const now = Date.now();
  const logs = [...logsOf(80, 'pd5-old', now - 6 * HOUR), ...logsOf(45, 'pd5-new', now - 20 * MIN)];
  const { pushed } = await joinWithLocalLogs(ctx, key, logs);
  assert.ok(Math.max(...pushed.map((r) => r.pushLogs)) >= 45, `전제: 30분 안 기록 45건이 한 요청에 들어 있다 ${JSON.stringify(pushed.map((r) => r.pushLogs))}`);
  assert.equal((await adapter.logs(key)).live.length, 125);
  assert.equal((await expoMessages(server)).length, 0, '40건을 넘는 업로드가 알림을 보냈다');
});

await scenario('PD6', '첫 업로드 일부: 오래된 기록 사이에 30분 안 기록 3건이 섞이면 그 3건만 묶은 메시지 1개다', ['spA', 'spB'], {}, async (ctx) => {
  const { server } = ctx;
  const key = await newKey(ctx.devices[0]);
  const now = Date.now();
  const logs = [
    ...logsOf(60, 'pd6-old', now - 6 * HOUR),
    logOf('pd6-new-1', { type: 'urine', timestamp: now - 9 * MIN }),
    logOf('pd6-new-2', { type: 'stool', timestamp: now - 8 * MIN }),
    logOf('pd6-new-3', { amount: 150, timestamp: now - 7 * MIN }),
  ];
  const { pushed } = await joinWithLocalLogs(ctx, key, logs);
  assert.ok(sum(pushed, (r) => r.pushLogs) >= 63, '전제: 63건이 올라갔다');
  const messages = await expoMessages(server);
  assert.equal(messages.length, 1, `메시지 수 ${messages.length}: ${JSON.stringify(bodiesOf(messages))}`);
  assert.equal(messages[0].to, TOKEN_B);
  assert.match(messages[0].body, /분유 150ml/);
  assert.match(messages[0].body, / 외 2건$/, '오래된 기록이 건수에 섞이면 안 된다');
});

// ════════════════════════════════ PD7. 전체 대조 ════════════════════════════════
await scenario('PD7', '전체 대조: 장부를 잊고 전체 모드로 두 기기가 같은 기록을 다시 올려도 메시지 0개다', ['spA', 'spB'], {}, async (ctx) => {
  const { adapter, server, devices: [A, B] } = ctx;
  const key = await newKey(A);
  await setupPair(ctx, key);

  const now = Date.now();
  await addLog(A, { amount: 110, timestamp: now - MIN });
  await addLog(A, { type: 'urine', timestamp: now - 20 * MIN });
  await sync(A);
  assert.equal((await expoMessages(server)).length, 1, '대조군: 처음 올린 최근 기록은 메시지 1개(묶음)');
  await sync(B);
  await expoReset(server);

  // A: 장부를 잊고 같은 기록을 다시 올린다. 이어서 전체 읽기도 돌린다.
  assert.ok((await A.send('forgetUploaded', {})).removed >= 2);
  let mark = await adapter.requestCount();
  await sync(A);
  assert.ok(sum(pushRequests(await adapter.requests(mark)), (r) => r.pushLogs) >= 2, '전제: A가 같은 기록을 다시 올렸다');
  assert.equal((await expoMessages(server)).length, 0, 'A의 재전송이 알림을 보냈다');
  mark = await adapter.requestCount();
  await sync(A, { forceFullRead: true });
  assert.ok((await adapter.requests(mark)).some(isFullPull), '전제: 전체 모드 당겨 받기가 돌았다');
  assert.equal((await expoMessages(server)).length, 0, 'A의 전체 읽기가 알림을 보냈다');

  // B: 받은 기록을 장부 없이 되올린다. A에게도 알림이 가면 안 된다.
  assert.ok((await B.send('forgetUploaded', {})).removed >= 1);
  mark = await adapter.requestCount();
  await sync(B);
  assert.ok(sum(pushRequests(await adapter.requests(mark)), (r) => r.pushLogs) >= 1, '전제: B가 받은 기록을 다시 올렸다');
  mark = await adapter.requestCount();
  await sync(B, { forceFullRead: true });
  assert.ok((await adapter.requests(mark)).some(isFullPull), '전제: B의 전체 모드 당겨 받기가 돌았다');
  assert.equal((await expoMessages(server)).length, 0, 'B의 전체 대조가 알림을 보냈다');
});

// ════════════════════════════════ PD8. 백업 복원 ════════════════════════════════
await scenario('PD8', '백업 복원: 복원한 기록(서버에 있는 최근 기록과 지운 최근 기록 포함)의 동기화는 메시지 0개다', ['spA', 'spB'], {}, async (ctx) => {
  const { adapter, server, devices: [A, B] } = ctx;
  const key = await newKey(A);
  await setupPair(ctx, key);

  const now = Date.now();
  await A.send('saveLogs', { logs: logsOf(5, 'pd8-old', now - 6 * HOUR) });
  const pd8 = await addLog(A, { amount: 105, timestamp: now - 2 * MIN });
  const pd8Kept = await addLog(A, { type: 'urine', timestamp: now - 3 * MIN });
  await sync(A);
  assert.equal((await expoMessages(server)).length, 1, '대조군: 최근 기록은 메시지 1개');
  await sync(B);
  await expoReset(server);

  // 백업 뒤에 최근 기록을 지운다. 복원하면 지운 기록이 updatedAt만 새로 얻어 돌아온다.
  assert.equal((await A.send('backupLocalData')).ok, true);
  assert.equal((await A.send('deleteLog', { id: pd8.id })).ok, true);
  await sync(A);
  assert.ok((await adapter.logs(key)).deleted.includes(pd8.id), '전제: 삭제 표식이 서버에 올라갔다');
  assert.equal((await expoMessages(server)).length, 0);

  assert.equal((await A.send('restoreLocalBackup')).success, true);
  assert.ok((await getLogs(A)).some((l) => l.id === pd8.id), '전제: 복원으로 지운 기록이 돌아왔다');
  assert.ok((await getLogs(A)).some((l) => l.id === pd8Kept.id && l.updatedAt >= now), '전제: 지우지 않은 최근 기록의 updatedAt이 새로워졌다');
  let mark = await adapter.requestCount();
  await syncUntilDone(A);
  assert.ok(sum(pushRequests(await adapter.requests(mark)), (r) => r.pushLogs) >= 1, '전제: 복원한 기록이 올라갔다');
  assert.equal((await expoMessages(server)).length, 0, '백업 복원이 알림을 보냈다');

  // 한 번 더: 지우지 않은 채 백업하고 복원해도(모든 기록의 updatedAt이 새로워짐) 알림이 없다.
  assert.equal((await A.send('backupLocalData')).ok, true);
  assert.equal((await A.send('restoreLocalBackup')).success, true);
  mark = await adapter.requestCount();
  await syncUntilDone(A);
  assert.ok(sum(pushRequests(await adapter.requests(mark)), (r) => r.pushLogs) >= 1, '전제: 두 번째 복원의 기록도 올라갔다');
  assert.equal((await expoMessages(server)).length, 0, '두 번째 백업 복원이 알림을 보냈다');
});

// ════════════════════════════════ PD9. 1.7.9 기기의 이전 ════════════════════════════════
const KPD9 = keyOf('pd9');
await scenario('PD9', '이전: 1.7.9 저장소와 Firestore 기록을 가진 기기가 알림을 켠 B가 있는 가족으로 이전해도 메시지 0개다', ['spA', 'spB'], {
  spA: { initialStorage: make179Storage({ syncKey: KPD9, logs: logsOf(40, 'pd9-own', Date.now() - 8 * HOUR) }) },
}, async (ctx) => {
  const { adapter, fs, server, devices: [A, B] } = ctx;
  await fs.seed(KPD9, { members: ['legacy-X'], logs: logsOf(30, 'pd9-fs', Date.now() - 9 * HOUR) });
  assert.equal((await createRound(B, KPD9)).success, true);
  await pushRegister(server, KPD9, await clientIdOf(B), TOKEN_B);
  await expoReset(server);

  await A.send('bootApp');
  const mark = await adapter.requestCount();
  const run = await A.send('runMigration');
  assert.ok(!['no_key', 'd1_error', 'backup_pending'].includes(run.result.status), `이전이 시작되지 않았다 ${JSON.stringify(run.result)}`);
  const started = Date.now();
  for (;;) {
    const state = await A.send('migrationState', { syncKey: KPD9 });
    if (state.complete) break;
    assert.ok(Date.now() - started < 30_000, `이전이 끝나지 않았다 ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(sum(pushRequests(await adapter.requests(mark)), (r) => r.pushLogs) >= 40, '전제: 이전 기록이 D1에 올라갔다');
  assert.equal((await adapter.logs(KPD9)).live.length >= 70, true, 'D1에 기기와 Firestore 기록이 모두 있다');
  assert.equal((await expoMessages(server)).length, 0, '이전의 대량 업로드가 알림을 보냈다');
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 시나리오 통과`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
