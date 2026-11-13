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

// ════════════════════════════════ 결과 ════════════════════════════════
const passed = results.filter(Boolean).length;
console.log(`\n==== 푸시 단위 검증: ${passed}/${results.length} 통과 ====`);
await server.stop();
process.exit(passed === results.length ? 0 : 1);
