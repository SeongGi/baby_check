// 상대 기기 기록 알림의 서버 단위 시험(02 설계 6장 "서버 단위 테스트"와 "동기화 보호").
// 실제 Worker 코드(server/src/index.ts, push.ts)를 real-server로 띄우고 가짜 Expo 서버(fake-expo.mjs)만 씁니다.
// 기기 프로세스는 쓰지 않고 HTTP로 직접 부릅니다. 127.0.0.1만 쓰고 외부 네트워크는 호출하지 않습니다.
// 서버 시각은 /__harness/clock으로 고정합니다.
//
// 실행: bash tools/sync-harness/verify.sh push
//       HARNESS_ONLY=R1,R2 bash tools/sync-harness/verify.sh push   (일부만)
import assert from 'node:assert/strict';
import { RealServer } from './real-harness.mjs';

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];
const server = await RealServer.start();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const test = async (id, title, fn) => {
  if (ONLY && !ONLY.includes(id)) return;
  const started = Date.now();
  try {
    await reset();
    await fn();
    results.push(true);
    console.log(`PASS [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL [${id}] ${title} (${((Date.now() - started) / 1000).toFixed(1)}s)\n     ${error?.stack || error}`);
  }
};

// ────────────── 도우미 ──────────────
// 2026-11-13 15:20:00 KST(UTC 06:20)에 고정합니다. 한국 기기(tz 540)에서는 "오후 3:20"입니다.
const T0 = Date.UTC(2026, 10, 13, 6, 20, 0);
const MIN = 60_000;
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const TOKEN_C = 'ExponentPushToken[cccccccccccccccccccccc]';
const TOKEN_D = 'ExponentPushToken[dddddddddddddddddddddd]';
const KEY1 = 'push-family-key-0000000000000001';
const KEY2 = 'push-family-key-0000000000000002';
const KEY3 = 'push-family-key-0000000000000003'; // 서버에 없는 가족

async function reset() {
  await server.adapter.reset();
  await server.control('clock', { set: T0 });
}

async function api(key, clientId, method, path, body) {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

/** 가족을 만들고 기기들을 회원으로 넣습니다. */
async function setupFamily(key, clientIds) {
  for (const [index, clientId] of clientIds.entries()) {
    const res = await api(key, clientId, 'POST', '/api/family/connect', { allowCreate: index === 0 });
    assert.equal(res.status, 200, `${clientId} connect: ${res.text}`);
  }
}

const register = (key, clientId, body = {}) => api(key, clientId, 'POST', '/api/family/push-register', {
  token: TOKEN_B, types: ['formula', 'urine'], quietStart: null, quietEnd: null, tzOffsetMinutes: 540, ...body,
});
const unregister = (key, clientId) => api(key, clientId, 'POST', '/api/family/push-unregister', {});
const pushDevices = async (key) => (await server.control('state', { q: 'pushDevices', key })).rows;
const allPushDevices = async () => (await server.control('state', { q: 'pushDevices' })).rows;

// ════════════════════════════════ R. 등록과 해제 ════════════════════════════════
await test('R1', '등록: 회원 기기의 등록은 한 행으로 저장되고 같은 기기가 다시 등록하면 그 행이 갱신된다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  let res = await register(KEY1, 'dev-b', { types: ['urine', 'formula'], quietStart: 1380, quietEnd: 420, tzOffsetMinutes: 540 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  let rows = await pushDevices(KEY1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, 'dev-b');
  assert.equal(rows[0].token, TOKEN_B);
  assert.deepEqual(JSON.parse(rows[0].types_json), ['formula', 'urine']);
  assert.equal(rows[0].quiet_start, 1380);
  assert.equal(rows[0].quiet_end, 420);
  assert.equal(rows[0].tz_offset_min, 540);
  assert.equal(rows[0].updated_at, T0);

  await server.control('clock', { advance: 5 * MIN });
  res = await register(KEY1, 'dev-b', { token: TOKEN_C, types: ['bath'], quietStart: null, quietEnd: null, tzOffsetMinutes: -300 });
  assert.equal(res.status, 200);
  rows = await pushDevices(KEY1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token, TOKEN_C);
  assert.deepEqual(JSON.parse(rows[0].types_json), ['bath']);
  assert.equal(rows[0].quiet_start, null);
  assert.equal(rows[0].tz_offset_min, -300);
  assert.equal(rows[0].updated_at, T0 + 5 * MIN);
});

await test('R2', '토큰 검증: 문자열이 아니거나 접두어가 다르거나 200자를 넘으면 400 invalid_push_token이고 행이 없다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  const bad = [undefined, null, 123, '', 'abc', 'ExponentPushToken', 'expopushtoken[x]', `ExponentPushToken[${'x'.repeat(200)}]`];
  for (const token of bad) {
    const res = await api(KEY1, 'dev-b', 'POST', '/api/family/push-register', { token, types: ['formula'] });
    assert.equal(res.status, 400, `토큰 ${String(token).slice(0, 20)}`);
    assert.equal(res.json.error, 'invalid_push_token');
  }
  assert.equal((await allPushDevices()).length, 0);
  // 접두어 두 가지와 정확히 200자는 통과한다.
  const ok200 = `ExpoPushToken[${'y'.repeat(200 - 'ExpoPushToken[]'.length)}]`;
  assert.equal(ok200.length, 200);
  assert.equal((await register(KEY1, 'dev-b', { token: ok200 })).status, 200);
  assert.equal((await register(KEY1, 'dev-b', { token: TOKEN_B })).status, 200);
});

await test('R3', '종류 검증: 9종 밖의 값과 중복은 지우고, 빈 배열이면 등록하지 않고 있던 행도 지운다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  await register(KEY1, 'dev-b', { types: ['urine', 'diary', 'urine', 'diaryComment', 'x', 7, 'play'] });
  let rows = await pushDevices(KEY1);
  assert.deepEqual(JSON.parse(rows[0].types_json), ['urine', 'play']);
  const all = ['formula', 'urine', 'stool', 'bath', 'weight', 'temperature', 'sleep', 'tummyTime', 'play'];
  await register(KEY1, 'dev-b', { types: [...all].reverse() });
  rows = await pushDevices(KEY1);
  assert.deepEqual(JSON.parse(rows[0].types_json), all);
  let res = await register(KEY1, 'dev-b', { types: [] });
  assert.equal(res.status, 200);
  assert.equal((await pushDevices(KEY1)).length, 0);
  // 알 수 없는 종류만 있어도 빈 배열과 같다. types가 아예 없어도 마찬가지다.
  await register(KEY1, 'dev-b', { types: undefined });
  res = await register(KEY1, 'dev-b', { types: ['diary'] });
  assert.equal(res.status, 200);
  assert.equal((await pushDevices(KEY1)).length, 0);
});

await test('R4', '방해 금지와 시간대 검증: 범위 밖, 정수 아님, 같은 값, 하나만 유효하면 둘 다 NULL이고 시간대는 540이 된다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  const cases = [
    [{ quietStart: 600, quietEnd: 600 }, [null, null]],
    [{ quietStart: -1, quietEnd: 100 }, [null, null]],
    [{ quietStart: 100, quietEnd: 1440 }, [null, null]],
    [{ quietStart: 10.5, quietEnd: 100 }, [null, null]],
    [{ quietStart: '100', quietEnd: 200 }, [null, null]],
    [{ quietStart: 100, quietEnd: null }, [null, null]],
    [{ quietStart: 0, quietEnd: 1439 }, [0, 1439]],
    [{ quietStart: 1439, quietEnd: 0 }, [1439, 0]],
  ];
  for (const [body, expected] of cases) {
    assert.equal((await register(KEY1, 'dev-b', body)).status, 200);
    const [row] = await pushDevices(KEY1);
    assert.deepEqual([row.quiet_start, row.quiet_end], expected, JSON.stringify(body));
  }
  for (const [tz, expected] of [[841, 540], [-841, 540], [0.5, 540], ['540', 540], [null, 540], [840, 840], [-840, -840], [0, 0]]) {
    assert.equal((await register(KEY1, 'dev-b', { tzOffsetMinutes: tz })).status, 200);
    const [row] = await pushDevices(KEY1);
    assert.equal(row.tz_offset_min, expected, `tz ${tz}`);
  }
});

await test('R5', '회원이 아닌 기기는 403 not_member이고 행이 생기지 않으며, 가족이 없으면 404, 삭제된 가족이면 410이다', async () => {
  await setupFamily(KEY1, ['dev-a']);
  let res = await register(KEY1, 'dev-stranger');
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'not_member');
  assert.equal((await allPushDevices()).length, 0);

  res = await register(KEY2, 'dev-x');
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'family_not_found');

  await server.adapter.markGone(KEY2);
  res = await register(KEY2, 'dev-x');
  assert.equal(res.status, 410);
  assert.equal(res.json.error, 'family_deleted');
  assert.equal((await allPushDevices()).length, 0);
});

await test('R6', '토큰 이동: 같은 토큰을 다른 가족이나 같은 가족의 다른 기기가 등록하면 옛 행이 지워지고 새 행만 남는다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  await setupFamily(KEY2, ['dev-x', 'dev-y']);
  await register(KEY1, 'dev-b', { token: TOKEN_B });
  await register(KEY2, 'dev-y', { token: TOKEN_C });
  // 다른 가족으로 이동
  assert.equal((await register(KEY2, 'dev-x', { token: TOKEN_B })).status, 200);
  assert.deepEqual((await pushDevices(KEY1)).map((r) => r.client_id), []);
  assert.deepEqual((await pushDevices(KEY2)).map((r) => [r.client_id, r.token]), [['dev-x', TOKEN_B], ['dev-y', TOKEN_C]]);
  // 같은 가족의 다른 기기로 이동
  assert.equal((await register(KEY2, 'dev-y', { token: TOKEN_B })).status, 200);
  assert.deepEqual((await pushDevices(KEY2)).map((r) => [r.client_id, r.token]), [['dev-y', TOKEN_B]]);
  // 거부된 등록(회원 아님)은 아무 행도 만들지 않는다.
  assert.equal((await register(KEY1, 'dev-stranger', { token: TOKEN_D })).status, 403);
  assert.equal((await allPushDevices()).filter((r) => r.token === TOKEN_D).length, 0);
  // 거부된 등록(403·404·410)은 다른 가족에 남은 같은 토큰의 행도 지우지 않는다.
  assert.equal((await register(KEY1, 'dev-stranger', { token: TOKEN_B })).status, 403);
  assert.equal((await register(KEY3, 'dev-z', { token: TOKEN_B })).status, 404);
  assert.deepEqual((await pushDevices(KEY2)).map((r) => [r.client_id, r.token]), [['dev-y', TOKEN_B]]);
});

await test('R7', '해제: 내 행만 지우고, 행이 없어도 가족이 없어도 200이다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b', 'dev-c']);
  await register(KEY1, 'dev-b', { token: TOKEN_B });
  await register(KEY1, 'dev-c', { token: TOKEN_C });
  let res = await unregister(KEY1, 'dev-b');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.deepEqual((await pushDevices(KEY1)).map((r) => r.client_id), ['dev-c']);
  assert.equal((await unregister(KEY1, 'dev-b')).status, 200);
  assert.equal((await unregister(KEY1, 'dev-unknown')).status, 200);
  assert.equal((await unregister(KEY2, 'dev-x')).status, 200);
  await server.adapter.markGone(KEY2);
  assert.equal((await unregister(KEY2, 'dev-x')).status, 200);
  assert.deepEqual((await pushDevices(KEY1)).map((r) => r.client_id), ['dev-c']);
});

await test('R8', '영구 삭제: 그 가족의 등록 행만 지워지고 다른 가족의 행은 남으며, 냉각 기간 중 거부된 삭제는 아무것도 지우지 않는다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  await setupFamily(KEY2, ['dev-x', 'dev-y']);
  await register(KEY1, 'dev-b', { token: TOKEN_B });
  await register(KEY2, 'dev-y', { token: TOKEN_C });
  assert.equal((await api(KEY1, 'dev-a', 'POST', '/api/family/delete-schedule')).status, 200);
  // 냉각 기간 중에는 거부되고 행도 그대로다.
  let res = await api(KEY1, 'dev-a', 'POST', '/api/family/delete');
  assert.equal(res.status, 400);
  assert.equal((await pushDevices(KEY1)).length, 1);
  await server.control('clock', { advance: 61 * MIN });
  res = await api(KEY1, 'dev-a', 'POST', '/api/family/delete');
  assert.equal(res.status, 200, res.text);
  assert.equal((await pushDevices(KEY1)).length, 0);
  assert.deepEqual((await pushDevices(KEY2)).map((r) => r.client_id), ['dev-y']);
});

// ════════════════════════════════ P. 새 기록 판정과 발송 ════════════════════════════════
const ALL_TYPES = ['formula', 'urine', 'stool', 'bath', 'weight', 'temperature', 'sleep', 'tummyTime', 'play'];
let logSeq = 0;
/** 서버 시각(clock)을 기준으로 offsetMs만큼 떨어진 기록. 기본 시각은 T0입니다. */
const mkLog = (type, offsetMs, extra = {}, base = T0) => {
  logSeq += 1;
  return { id: `log-${logSeq}`, type, timestamp: base + offsetMs, updatedAt: base + offsetMs, ...extra };
};
const syncAs = (clientId, body, key = KEY1) => api(key, clientId, 'POST', '/api/family/sync', body);
const settle = () => server.control('background', { op: 'wait' });
const expoRequests = async () => (await server.control('expo', { op: 'requests' }));
const expoMessages = async () => (await expoRequests()).messages;
const expoReset = () => server.control('expo', { op: 'reset' });
const lastRequestRecord = async () => {
  const { requests } = await server.control('state', { q: 'requests', from: 0 });
  return requests[requests.length - 1];
};

/** dev-a(보내는 기기)와 받는 기기들을 만들고 등록합니다. receivers: [{ id, token, ...registerBody }] */
async function setupPush(receivers = [{ id: 'dev-b', token: TOKEN_B, types: ALL_TYPES }]) {
  await setupFamily(KEY1, ['dev-a', ...receivers.map((r) => r.id)]);
  for (const { id, ...body } of receivers) {
    const res = await register(KEY1, id, body);
    assert.equal(res.status, 200, `${id} 등록: ${res.text}`);
  }
}

/** dev-a가 기록을 올리고 백그라운드까지 끝낸 뒤 가짜 Expo가 받은 메시지를 돌려줍니다. */
async function pushLogs(logs, extra = {}, sender = 'dev-a') {
  const res = await syncAs(sender, { pushLogs: logs, ...extra });
  assert.equal(res.status, 200, res.text);
  await settle();
  return { res, messages: await expoMessages() };
}

await test('P1', '새 기록 하나는 다른 기기에만 알림이 가고, 보낸 기기는 등록돼 있어도 제외된다', async () => {
  await setupPush([
    { id: 'dev-b', token: TOKEN_B, types: ALL_TYPES },
    { id: 'dev-a', token: TOKEN_C, types: ALL_TYPES },
  ]);
  const log = mkLog('formula', -MIN, { amount: 120 });
  const { res, messages } = await pushLogs([log]);
  assert.deepEqual(res.json.acceptedIds, [log.id]);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    to: TOKEN_B,
    title: '아기 새 기록',
    body: '🍼 분유 120ml · 오후 3:19',
    data: { kind: 'partnerLog', logId: log.id, type: 'formula' },
    channelId: 'partner-records',
    priority: 'high',
    sound: 'default',
  });
  // 서버는 응답 본문을 바꾸지 않는다: 기존 응답 필드만 있다.
  assert.deepEqual(Object.keys(res.json).sort(), [
    'acceptedIds', 'maxPageRows', 'maxPushItems', 'ok', 'remoteDeletedIds', 'remoteLogs', 'serverTime',
  ]);
});

await test('P2', '수정, 삭제 표식이 있는 기록, 같은 요청 안에서 삭제한 기록, 다시 올린 같은 기록은 알림이 가지 않는다', async () => {
  await setupPush();
  const first = mkLog('formula', -2 * MIN, { amount: 100 });
  let out = await pushLogs([first]);
  assert.equal(out.messages.length, 1);
  // 같은 기록을 그대로 다시 올림, 고쳐서 올림
  out = await pushLogs([first]);
  assert.equal(out.messages.length, 1, '같은 기록 재전송');
  out = await pushLogs([{ ...first, amount: 130, updatedAt: first.updatedAt + 1000 }]);
  assert.equal(out.messages.length, 1, '수정');
  // 삭제 표식이 있는 기록을 올림
  const dead = mkLog('urine', -3 * MIN);
  await server.adapter.injectTombstone(KEY1, dead.id, T0 - 10 * MIN);
  out = await pushLogs([dead]);
  assert.equal(out.messages.length, 1, '삭제 표식이 있는 기록');
  // 같은 요청 안에서 올리고 삭제
  const gone = mkLog('stool', -4 * MIN);
  out = await pushLogs([gone], { pushDeletedIds: [gone.id] });
  assert.equal(out.messages.length, 1, '같은 요청 안 삭제');
  // 아무 것도 모르는 새 기록은 그대로 알림이 간다.
  const fresh = mkLog('bath', -MIN, { durationMinutes: 10 });
  out = await pushLogs([fresh]);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[1].data.logId, fresh.id);
});

await test('P3', '30분 안의 기록만 알리고(경계 포함), 미래 시각은 허용하며, 30분을 넘은 기록은 알리지 않는다', async () => {
  await setupPush();
  let out = await pushLogs([mkLog('formula', -31 * MIN, { amount: 100 })]);
  assert.equal(out.messages.length, 0, '31분 전');
  out = await pushLogs([mkLog('formula', -30 * MIN - 1, { amount: 100 })]);
  assert.equal(out.messages.length, 0, '30분 1ms 전');
  out = await pushLogs([mkLog('formula', -30 * MIN, { amount: 100 })]);
  assert.equal(out.messages.length, 1, '정확히 30분 전');
  out = await pushLogs([mkLog('formula', -29 * MIN, { amount: 100 })]);
  assert.equal(out.messages.length, 2, '29분 전');
  out = await pushLogs([mkLog('formula', 3 * 60 * MIN, { amount: 100 })]);
  assert.equal(out.messages.length, 3, '3시간 뒤(미래)');
  // 오래된 기록 여러 건(이전, 백업 복원)은 후보가 없어 추가 D1 문장도 없다.
  const old = Array.from({ length: 30 }, (_, i) => mkLog('formula', -(60 + i) * MIN, { amount: 100 }));
  out = await pushLogs(old);
  assert.equal(out.messages.length, 3);
  const record = await lastRequestRecord();
  assert.equal(record.backgroundQueries, 0);
  // timestamp가 없거나 숫자가 아닌 기록은 후보가 아니다.
  out = await pushLogs([
    { id: 'no-ts', type: 'formula', amount: 100, updatedAt: T0 },
    { id: 'str-ts', type: 'formula', amount: 100, timestamp: String(T0), updatedAt: T0 },
  ]);
  assert.equal(out.messages.length, 3);
});

await test('P4', '대상이 아닌 종류(diary, diaryComment, 알 수 없는 종류)는 알림이 가지 않는다', async () => {
  await setupPush();
  const out = await pushLogs([
    mkLog('diary', -MIN, { text: '오늘 일기' }),
    mkLog('diaryComment', -MIN, { text: '댓글', diaryId: 'x' }),
    mkLog('mystery', -MIN),
  ]);
  assert.equal(out.messages.length, 0);
  assert.equal(out.res.json.acceptedIds.length, 3);
});

await test('P5', '한 요청의 새 기록이 40건이면 한 통으로 알리고, 41건이면 알리지 않는다', async () => {
  await setupPush();
  const make = (n) => Array.from({ length: n }, (_, i) => mkLog('formula', -(i % 20) * MIN, { amount: 100 + i }));
  let out = await pushLogs(make(41));
  assert.equal(out.messages.length, 0, '41건');
  assert.equal(out.res.json.acceptedIds.length, 41);
  await reset();
  await setupPush();
  out = await pushLogs(make(40));
  assert.equal(out.messages.length, 1, '40건');
  assert.match(out.messages[0].body, / 외 39건$/);
});

await test('P6', '기기마다 받을 종류로 거른다: 남는 기록이 없는 기기는 건너뛴다', async () => {
  await setupPush([
    { id: 'dev-b', token: TOKEN_B, types: ['urine'] },
    { id: 'dev-c', token: TOKEN_C, types: ['formula', 'stool'] },
    { id: 'dev-d', token: TOKEN_D, types: ['bath'] },
  ]);
  const out = await pushLogs([mkLog('formula', -2 * MIN, { amount: 90 }), mkLog('urine', -MIN)]);
  assert.equal(out.messages.length, 2);
  const byToken = Object.fromEntries(out.messages.map((m) => [m.to, m]));
  assert.equal(byToken[TOKEN_B].body, '💧 소변 · 오후 3:19');
  assert.equal(byToken[TOKEN_C].body, '🍼 분유 90ml · 오후 3:18');
  assert.equal(byToken[TOKEN_D], undefined);
});

/** 시계를 clockMs로 맞추고 기록을 올려 받은 메시지 하나를 돌려줍니다. */
async function messageAt(clockMs, registerBody) {
  await reset();
  await server.control('clock', { set: clockMs });
  await setupPush([{ id: 'dev-b', token: TOKEN_B, types: ALL_TYPES, ...registerBody }]);
  const { messages } = await pushLogs([mkLog('urine', -MIN, {}, clockMs)]);
  assert.equal(messages.length, 1);
  return messages[0];
}

await test('P7', '방해 금지: 자정을 넘는 구간과 넘지 않는 구간, 시작 포함과 끝 제외, 기기 시간대를 따른다', async () => {
  const kst = (h, m) => Date.UTC(2026, 10, 13, h - 9, m, 0); // 한국 시각 h:m
  const quiet = { channelId: 'partner-records-quiet', priority: 'normal', sound: null };
  const loud = { channelId: 'partner-records', priority: 'high', sound: 'default' };
  const night = { quietStart: 1380, quietEnd: 420 }; // 23:00 ~ 07:00
  const day = { quietStart: 840, quietEnd: 960 }; // 14:00 ~ 16:00
  const cases = [
    ['자정 넘는 구간, 한낮', kst(15, 20), night, loud],
    ['자정 넘는 구간, 시작 23:00 포함', kst(23, 0), night, quiet],
    ['자정 넘는 구간, 22:59', kst(22, 59), night, loud],
    ['자정 넘는 구간, 00:30', kst(0, 30) + 24 * 60 * MIN, night, quiet],
    ['자정 넘는 구간, 06:59', kst(6, 59), night, quiet],
    ['자정 넘는 구간, 끝 07:00 제외', kst(7, 0), night, loud],
    ['같은 날 구간, 시작 14:00 포함', kst(14, 0), day, quiet],
    ['같은 날 구간, 15:20', kst(15, 20), day, quiet],
    ['같은 날 구간, 끝 16:00 제외', kst(16, 0), day, loud],
    ['같은 날 구간, 13:59', kst(13, 59), day, loud],
    ['끔(NULL)', kst(23, 30), { quietStart: null, quietEnd: null }, loud],
    // UTC-5 기기: 한국 15:20 = 현지 01:20이므로 23:00~07:00 구간 안이다.
    ['시간대 -300, 현지 01:20', kst(15, 20), { ...night, tzOffsetMinutes: -300 }, quiet],
    // UTC+9 기기와 같은 시각이어도 UTC 기준 06:20이라 시간대를 0으로 두면 night(07:00 끝) 안이다.
    ['시간대 0, 현지 06:20', kst(15, 20), { ...night, tzOffsetMinutes: 0 }, quiet],
  ];
  for (const [name, clockMs, body, expected] of cases) {
    const message = await messageAt(clockMs, body);
    assert.deepEqual(
      { channelId: message.channelId, priority: message.priority, sound: message.sound },
      expected,
      name,
    );
  }
});

await test('P8', '메시지 요약: 9종 형식과 결측, 0 이하, 숫자가 아닌 수치는 수치를 뺀다', async () => {
  await setupPush();
  const cases = [
    ['formula', { amount: 120 }, '🍼 분유 120ml'],
    ['formula', { amount: 120, feedingType: 'formula' }, '🍼 분유 120ml'],
    ['formula', { amount: 120, feedingType: 'breast' }, '🍼 모유 120ml'],
    ['formula', { amount: 120, feedingType: 'mixed' }, '🍼 혼합 120ml'],
    ['formula', { amount: 87.5 }, '🍼 분유 87.5ml'],
    ['formula', {}, '🍼 분유'],
    ['formula', { amount: 0 }, '🍼 분유'],
    ['formula', { amount: -5 }, '🍼 분유'],
    ['formula', { amount: '120' }, '🍼 분유'],
    ['formula', { amount: null }, '🍼 분유'],
    ['urine', {}, '💧 소변'],
    ['stool', {}, '💩 대변'],
    ['bath', { durationMinutes: 15 }, '🛁 목욕 15분'],
    ['bath', {}, '🛁 목욕'],
    ['bath', { durationMinutes: 0 }, '🛁 목욕'],
    ['weight', { weightKg: 4.25 }, '⚖️ 체중 4.25kg'],
    ['weight', { weightKg: 4.2 }, '⚖️ 체중 4.2kg'],
    ['weight', { weightKg: 4 }, '⚖️ 체중 4kg'],
    ['weight', { weightKg: 4.256 }, '⚖️ 체중 4.26kg'],
    ['weight', {}, '⚖️ 체중'],
    ['weight', { weightKg: -1 }, '⚖️ 체중'],
    ['temperature', { temperatureC: 37.2 }, '🌡️ 체온 37.2℃'],
    ['temperature', { temperatureC: 36.84 }, '🌡️ 체온 36.8℃'],
    ['temperature', { temperatureC: 37 }, '🌡️ 체온 37℃'],
    ['temperature', {}, '🌡️ 체온'],
    ['sleep', {}, '😴 수면 시작'],
    ['sleep', { endedAt: T0 - 2 * MIN - 1 }, '😴 수면'], // 끝이 시작보다 앞서면 수치를 뺀다
    ['tummyTime', {}, '🧸 터미타임 시작'],
    ['play', {}, '🎈 놀이 시작'],
  ];
  for (const [type, extra, expected] of cases) {
    await expoReset();
    const { messages } = await pushLogs([mkLog(type, -2 * MIN, extra)]);
    assert.equal(messages.length, 1, `${type} ${JSON.stringify(extra)}`);
    assert.equal(messages[0].body, `${expected} · 오후 3:18`, `${type} ${JSON.stringify(extra)}`);
    assert.equal(messages[0].data.type, type);
  }
  // 기간이 있는 기록의 길이
  const spans = [
    ['sleep', 80, '😴 수면 1시간 20분'],
    ['sleep', 60, '😴 수면 1시간'],
    ['sleep', 25, '😴 수면 25분'],
    ['tummyTime', 10, '🧸 터미타임 10분'],
    ['play', 30, '🎈 놀이 30분'],
  ];
  for (const [type, minutes, expected] of spans) {
    await expoReset();
    const start = -2 * MIN;
    const { messages } = await pushLogs([mkLog(type, start, { endedAt: T0 + start + minutes * MIN })]);
    assert.equal(messages[0].body, `${expected} · 오후 3:18`, `${type} ${minutes}`);
  }
});

await test('P9', '시각은 받는 기기의 시간대로 "오전/오후 h:mm"을 만들고, 12시와 0시, 분 자리 0 채움을 지킨다', async () => {
  const at = (hour, minute) => Date.UTC(2026, 10, 13, hour, minute, 0); // UTC 시각
  const cases = [
    // [UTC 시각, tz, 기대]
    [at(15, 5), 540, '오전 12:05'], // 한국 00:05
    [at(3, 0), 540, '오후 12:00'], // 한국 12:00
    [at(0, 7), 540, '오전 9:07'], // 한국 09:07
    [at(14, 59), 540, '오후 11:59'],
    [at(6, 20), 540, '오후 3:20'],
    [at(1, 30), -300, '오후 8:30'], // 전날 20:30
    [at(23, 45), 330, '오전 5:15'], // 다음 날 05:15
    [at(12, 0), 0, '오후 12:00'],
  ];
  for (const [utc, tz, expected] of cases) {
    await reset();
    await server.control('clock', { set: utc });
    await setupPush([{ id: 'dev-b', token: TOKEN_B, types: ALL_TYPES, tzOffsetMinutes: tz }]);
    const { messages } = await pushLogs([mkLog('urine', 0, {}, utc)]);
    assert.equal(messages[0].body, `💧 소변 · ${expected}`, `utc ${new Date(utc).toISOString()} tz ${tz}`);
  }
});

await test('P10', '여러 건은 가장 늦은 기록을 보이고 " 외 N건"을 붙이며, 아기 이름이 제목에 들어간다', async () => {
  await setupPush();
  const logs = [
    mkLog('formula', -20 * MIN, { amount: 100 }),
    mkLog('urine', -5 * MIN),
    mkLog('formula', -10 * MIN, { amount: 110 }),
  ];
  const profile = { name: '하늘', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 120, sharedUpdatedAt: T0 };
  const { messages } = await pushLogs(logs, { pushProfile: profile });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, '하늘 새 기록');
  assert.equal(messages[0].body, '💧 소변 · 오후 3:15 외 2건');
  assert.equal(messages[0].data.logId, logs[1].id);
  // 아기 정보만 올리는 요청은 알림이 없다.
  await expoReset();
  const res = await syncAs('dev-a', { pushProfile: { ...profile, name: '바다', sharedUpdatedAt: T0 + 1 } });
  assert.equal(res.status, 200);
  await settle();
  assert.equal((await expoMessages()).length, 0);
});

await test('P11', 'DeviceNotRegistered를 받은 토큰의 행만 지우고, 다른 오류 ticket과 정상 ticket의 행은 남긴다', async () => {
  await setupPush([
    { id: 'dev-b', token: TOKEN_B, types: ALL_TYPES },
    { id: 'dev-c', token: TOKEN_C, types: ALL_TYPES },
    { id: 'dev-d', token: TOKEN_D, types: ALL_TYPES },
  ]);
  await server.control('expo', { op: 'mode', mode: 'deviceNotRegistered', tokens: [TOKEN_C] });
  const { messages } = await pushLogs([mkLog('urine', -MIN)]);
  assert.equal(messages.length, 3);
  assert.deepEqual((await pushDevices(KEY1)).map((r) => r.client_id), ['dev-b', 'dev-d']);
  const record = await lastRequestRecord();
  assert.equal(record.backgroundQueries, 2, '받을 기기 조회 + 정리 배치');
  // 모든 토큰이 죽었다고 하면 모두 지운다.
  await server.control('expo', { op: 'mode', mode: 'deviceNotRegistered', tokens: null });
  await pushLogs([mkLog('stool', -MIN)]);
  assert.equal((await pushDevices(KEY1)).length, 0);
});

await test('P12', '같은 기록 id를 담은 동시 요청 두 개에서 알림은 한 번만 간다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-a2', 'dev-b']);
  assert.equal((await register(KEY1, 'dev-b', { types: ALL_TYPES })).status, 200);
  const log = mkLog('formula', -MIN, { amount: 100 });
  // 두 요청의 쓰기 배치를 모두 멈춰 둔 뒤 함께 풀어 겹치게 한다.
  await server.control('hold', { op: 'add', match: { kind: 'push', batch: 'write' }, at: 'batch', times: 2 });
  const first = syncAs('dev-a', { pushLogs: [log] });
  const second = syncAs('dev-a2', { pushLogs: [log] });
  const deadline = Date.now() + 10_000;
  while ((await server.control('state', { q: 'held' })).held.length < 2) {
    assert.ok(Date.now() < deadline, '두 요청이 쓰기 배치에서 멈추지 않았습니다');
    await sleep(10);
  }
  await server.control('release', { all: true });
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.deepEqual(r1.json.acceptedIds, [log.id]);
  assert.deepEqual(r2.json.acceptedIds, [log.id]);
  await settle();
  const messages = await expoMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.logId, log.id);
});

await test('P13', '배치가 98개 항목으로 나뉘어도 새 기록 판정이 이어지고, 같은 id가 두 배치에 걸치면 한 번만 새 기록으로 센다', async () => {
  // 40건을 넘으면 알림이 없으므로 여러 배치를 보려면 오래된 기록과 섞는다: 새 기록은 3건, 나머지는 30분 넘은 기록.
  await setupPush();
  const filler = Array.from({ length: 150 }, (_, i) => mkLog('formula', -(60 + i) * MIN, { amount: 100 }));
  const fresh = [mkLog('urine', -3 * MIN), mkLog('stool', -2 * MIN), mkLog('bath', -MIN, { durationMinutes: 5 })];
  // 새 기록을 배치 경계(98)에 걸치게 둔다: 앞 97개 + 새 기록 3개 + 나머지
  const logs = [...filler.slice(0, 97), fresh[0], fresh[1], fresh[2], ...filler.slice(97)];
  const { res, messages } = await pushLogs(logs);
  assert.equal(res.json.acceptedIds.length, 153);
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /외 2건$/);
  // 같은 id가 서로 다른 배치에 두 번 들어 있어도 한 건이다.
  await expoReset();
  const dup = mkLog('formula', -MIN, { amount: 77 });
  const spread = [dup, ...filler.slice(0, 120).map((l, i) => ({ ...l, id: `dupfill-${i}` })), dup];
  const out = await pushLogs(spread);
  assert.equal(out.messages.length, 1);
  assert.doesNotMatch(out.messages[0].body, /외/);
});

await test('P14', '백그라운드 집계: 후보가 없으면 0, 받을 기기가 없으면 1(기기 조회), 요청 쿼리 수는 푸시 때문에 늘지 않는다', async () => {
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  // 후보 없음
  await pushLogs([mkLog('formula', -90 * MIN, { amount: 100 })]);
  let record = await lastRequestRecord();
  assert.equal(record.backgroundQueries, 0);
  const oldQueries = record.queries;
  // 새 기록이 있지만 받을 기기가 없음
  await pushLogs([mkLog('formula', -MIN, { amount: 100 })]);
  record = await lastRequestRecord();
  assert.equal(record.backgroundQueries, 1);
  assert.equal(record.queries, oldQueries, '요청 쿼리 수(쓰기 배치 문장 추가는 쿼리 수가 아니다)');
  // 받을 기기가 있음
  assert.equal((await register(KEY1, 'dev-b', { types: ALL_TYPES })).status, 200);
  await pushLogs([mkLog('formula', -MIN, { amount: 100 })]);
  record = await lastRequestRecord();
  assert.equal(record.backgroundQueries, 1);
  assert.equal(record.queries, oldQueries);
});

// ════════════════════════════════ S. 동기화 보호 ════════════════════════════════
/** 같은 요청을 푸시가 없는 경우(받을 기기 없음)와 푸시가 있는 경우(가짜 Expo의 방식 지정)에 보내 비교합니다. */
async function protectionRun(expoMode, { maxElapsedMs = 2000 } = {}) {
  const body = () => ({ pushLogs: [{ id: 'prot-1', type: 'formula', amount: 120, timestamp: T0 - MIN, updatedAt: T0 - MIN }] });
  await reset();
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  const baseline = await syncAs('dev-a', body());
  await settle();
  const baselineRecord = await lastRequestRecord();

  await reset();
  await setupFamily(KEY1, ['dev-a', 'dev-b']);
  assert.equal((await register(KEY1, 'dev-b', { types: ALL_TYPES })).status, 200);
  await server.control('expo', { op: 'mode', ...expoMode });
  const started = Date.now();
  const withPush = await syncAs('dev-a', body());
  const elapsed = Date.now() - started;
  const record = await lastRequestRecord();
  const waitStarted = Date.now();
  await settle();
  const backgroundMs = Date.now() - waitStarted;

  assert.equal(withPush.status, baseline.status);
  assert.equal(withPush.text, baseline.text, '응답 본문이 푸시 없는 경우와 같아야 한다');
  assert.equal(record.queries, baselineRecord.queries);
  assert.ok(elapsed < maxElapsedMs, `응답이 푸시를 기다렸다: ${elapsed}ms`);
  return { baseline, withPush, elapsed, backgroundMs, requests: (await expoRequests()).requests };
}

await test('S1', '가짜 Expo가 500을 돌려줘도 sync 응답 상태와 본문은 푸시가 없을 때와 같고 등록 행은 남는다', async () => {
  const run = await protectionRun({ mode: 'error500' });
  assert.equal(run.withPush.status, 200);
  assert.equal(run.requests.length, 1);
  assert.equal((await pushDevices(KEY1)).length, 1);
});

await test('S2', '가짜 Expo가 6초 늦게 답해도 sync 응답은 기다리지 않고, 발송은 5초 제한에서 끝나며 행은 남는다', async () => {
  const run = await protectionRun({ mode: 'ok', delayMs: 6000 }, { maxElapsedMs: 1500 });
  assert.equal(run.withPush.status, 200);
  assert.equal(run.requests.length, 1);
  assert.ok(run.backgroundMs >= 3000, `백그라운드가 지연을 기다리지 않았다: ${run.backgroundMs}ms`);
  assert.ok(run.backgroundMs < 5900, `발송이 5초 제한에서 끝나지 않았다: ${run.backgroundMs}ms`);
  assert.equal((await pushDevices(KEY1)).length, 1);
});

await test('S3', '가짜 Expo가 연결을 거부해도 sync 응답 상태와 본문은 푸시가 없을 때와 같고 행은 남는다', async () => {
  const run = await protectionRun({ mode: 'refuse' });
  assert.equal(run.withPush.status, 200);
  assert.equal(run.requests.length, 0);
  assert.equal((await pushDevices(KEY1)).length, 1);
  await expoReset();
});

// ════════════════════════════════ 결과 ════════════════════════════════
const passed = results.filter(Boolean).length;
console.log(`\n==== 푸시 단위 검증: ${passed}/${results.length} 통과 ====`);
await server.stop();
process.exit(passed === results.length ? 0 : 1);
