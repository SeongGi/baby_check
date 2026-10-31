// 실제 서버 모드 시나리오 4부 보강: 예전 앱 시절에 사용자가 직접 친 짧은 그룹 비밀번호(가족 키)도 이전과 동기화가 되는지 확인합니다.
// 시나리오 접두어는 s4d입니다.
//
//  K1. 짧은 소문자 키(7자)를 쓰는 1.7.9 기기 둘이 같은 Firestore 가족을 이전해도 401 없이 끝나고, 기록의 합집합이 두 기기와 D1에 모두 있다
//  K2. 대소문자가 섞인 짧은 키도 같다: 두 기기가 D1의 같은 가족(소문자 키 기준)으로 들어가고 기록이 하나도 사라지지 않는다
//  K3. 형식이 틀린 키(점 포함)는 실제 서버가 계속 401로 거절하고, 기기는 로컬 기록과 연결 키를 그대로 지킨다
//
// 이 시나리오가 생긴 까닭: 서버가 16~64자 키만 받아서, 짧은 키를 쓰던 실사용자가 이전 단계에서 401을 받았습니다.
// 가짜 서버는 길이를 따지지 않아 오프라인 시험이 이를 놓쳤습니다. 지금은 가짜 서버와 실제 서버가 같은 정규식을 씁니다.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-4d.mjs
//       HARNESS_ONLY=K1,K2 bash tools/sync-harness/verify.sh scenario real-scenarios-4d.mjs   (일부만)
import assert from 'node:assert/strict';
import {
  startRealHarness, make179Storage, auditFirestoreWrites, waitMigrationComplete,
} from './real-harness.mjs';

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];
const DAY = 24 * 60 * 60_000;
const PREFIX = 's4d';

// ────────────── 시나리오 뼈대 ──────────────
/** 실제 서버와 기기(이름에 s4d 접두어)를 띄워 fn을 돌립니다. 끝나면 불변 조건 2(허용 목록 밖 Firestore 쓰기·삭제 0건)를 판정합니다. */
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

// ────────────── 도우미 ──────────────
const BASE = Date.now() - 10 * DAY;
const log = (id, offset) => ({ id, type: 'formula', amount: 90, timestamp: BASE + offset, updatedAt: BASE + offset });
/** A 기기에만, B 기기에만, Firestore에만 있는 기록 */
const SEED = {
  onlyA: [log('a-only-1', 1), log('a-only-2', 2)],
  onlyB: [log('b-only-1', 3)],
  onlyFs: [log('fs-only-1', 4), log('fs-only-2', 5), log('fs-only-3', 6)],
};
const sortedIds = (list) => [...list].sort();
const idsOf = async (device) => sortedIds((await device.send('getLogs')).logs.map((l) => l.id));
const d1Live = async (adapter, key) => sortedIds((await adapter.logs(key)).live.map(([id]) => id));
const syncKeyOf = async (device) => (await device.send('getProfile')).profile.syncKey ?? null;

/**
 * 짧은 키를 쓰는 1.7.9 기기 둘이 차례로 이전하는 공통 흐름입니다.
 * A만 가진 기록, B만 가진 기록, Firestore에만 있는 기록을 두고 이전한 뒤 합집합이 모두 같은지 확인합니다.
 */
const twoDevicesShortKey = async ({ adapter, fs, A, B }, keyA, keyB) => {
  const { onlyA, onlyB, onlyFs } = SEED;
  // Firestore 가족은 기기가 쓰는 키 그대로(원래 대소문자)의 해시로 찾으므로 A의 키로 만든다.
  await fs.seed(keyA, { members: ['legacy-C'], logs: onlyFs });
  await A.send('bootApp');
  await B.send('bootApp');

  const first = await A.send('runMigration');
  assert.equal(first.result.status, 'uploading', `A의 이전이 401 등으로 멈췄다: ${JSON.stringify(first)}`);
  await waitMigrationComplete(A, { syncKey: keyA, timeoutMs: 60_000 });
  const second = await B.send('runMigration');
  assert.equal(second.result.status, 'uploading', `B의 이전이 401 등으로 멈췄다: ${JSON.stringify(second)}`);
  await waitMigrationComplete(B, { syncKey: keyB, timeoutMs: 60_000 });

  for (const device of [A, B]) {
    const state = (await device.send('migrationState', { syncKey: device === A ? keyA : keyB })).state;
    assert.equal(state.mergeSource, 'ok', `${device.name}의 병합 결과`);
    assert.notEqual(state.lastError, '가족 연결 키 형식을 새 서버가 받지 못합니다.', `${device.name}가 키 형식 오류를 냈다`);
  }
  assert.equal(await syncKeyOf(A), keyA, 'A의 연결 키가 유지된다');
  assert.equal(await syncKeyOf(B), keyB, 'B의 연결 키가 유지된다');
  const familyA = await adapter.family(keyA);
  assert.equal(familyA.exists, true, 'D1 가족이 생겼다');
  assert.equal((await adapter.family(keyB)).exists, true, 'B의 키로도 같은 D1 가족이 보인다');
  return { onlyA, onlyB, onlyFs, familyA };
};

/** 한 회차씩 평소 동기화를 돌려 서로의 기록을 받게 합니다. */
const runnerSync = async (device, key) => {
  const result = await device.send('runnerRequest', { request: { syncKey: key }, timeoutMs: 30_000 }, { timeoutMs: 90_000 });
  assert.equal(result.success, true, `${device.name} 러너 동기화 실패: ${result.error ?? JSON.stringify(result)}`);
};

const checkUnion = async ({ adapter, A, B }, key, keyB, { onlyA, onlyB, onlyFs }) => {
  await runnerSync(A, key);
  await runnerSync(B, keyB);
  await runnerSync(A, key);
  const expected = sortedIds([...onlyA, ...onlyB, ...onlyFs].map((l) => l.id));
  assert.deepEqual(await d1Live(adapter, key), expected, 'D1에 기록의 합집합이 있다');
  assert.deepEqual(await idsOf(A), expected, 'A에 기록의 합집합이 있다');
  assert.deepEqual(await idsOf(B), expected, 'B에 기록의 합집합이 있다');
};

// ════════════════════════════════ K1. 짧은 소문자 키 ════════════════════════════════
const K1 = 'jjkfam7';
await scenario('K1', '짧은 소문자 키(7자): 두 1.7.9 기기가 이전을 401 없이 끝내고 D1 가족에 둘 다 들어가며 기록의 합집합이 모두에 있다', ['A', 'B'], async (ctx) => {
  assert.equal(K1.length, 7);
  const found = await twoDevicesShortKey(ctx, K1, K1);
  const members = found.familyA.members;
  assert.equal(members.length, 2, `D1 가족의 구성원이 둘이다: ${JSON.stringify(members)}`);
  await checkUnion(ctx, K1, K1, found);
}, { deviceOptions: {
  A: { initialStorage: make179Storage({ syncKey: K1, logs: SEED.onlyA }) },
  B: { initialStorage: make179Storage({ syncKey: K1, logs: SEED.onlyB }) },
} });

// ════════════════════════════════ K2. 대소문자가 섞인 짧은 키 ════════════════════════════════
const K2 = 'JjkFam7';
await scenario('K2', '대소문자가 섞인 짧은 키: 두 기기가 D1의 같은 가족(소문자 키 기준)으로 들어가고 기록이 하나도 사라지지 않는다', ['A', 'B'], async (ctx) => {
  assert.ok(K2 !== K2.toLowerCase() && K2.length < 16);
  const found = await twoDevicesShortKey(ctx, K2, K2);
  assert.equal((await ctx.adapter.family(K2.toLowerCase())).exists, true, 'D1은 소문자 키 기준으로도 같은 가족이다');
  const members = (await ctx.adapter.family(K2.toLowerCase())).members;
  assert.equal(members.length, 2, `D1 가족의 구성원이 둘이다: ${JSON.stringify(members)}`);
  await checkUnion(ctx, K2, K2, found);
}, { deviceOptions: {
  A: { initialStorage: make179Storage({ syncKey: K2, logs: SEED.onlyA }) },
  B: { initialStorage: make179Storage({ syncKey: K2, logs: SEED.onlyB }) },
} });

// ════════════════════════════════ K3. 형식이 틀린 키는 계속 거절 ════════════════════════════════
const K3 = 'bad.key';
await scenario('K3', '점이 든 키는 실제 서버가 계속 401로 거절하고, 기기는 로컬 기록과 연결 키를 그대로 지킨다', ['A'], async ({ adapter, server, A }) => {
  const localLogs = SEED.onlyA;
  const post = (key) => fetch(`${server.url}/api/family/connect`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': 's4d-direct', 'Content-Type': 'application/json' }, body: JSON.stringify({ allowCreate: true }),
  });
  const bad = await post(K3);
  assert.equal(bad.status, 401, '점이 든 키는 401이다');
  assert.equal((await bad.json()).error, 'invalid_or_missing_sync_key');
  assert.equal((await post('bad key')).status, 401, '공백이 든 키도 401이다');
  assert.equal((await post('a'.repeat(257))).status, 401, '257자 키도 401이다');
  assert.equal((await adapter.family(K3)).exists, false, '거절된 키로 D1 가족이 생기지 않았다');

  await A.send('bootApp');
  const result = await A.send('runMigration');
  assert.equal(result.result.status, 'key_format', `형식 오류로 멈춘다: ${JSON.stringify(result)}`);
  assert.deepEqual(await idsOf(A), sortedIds(localLogs.map((l) => l.id)), '로컬 기록이 하나도 지워지지 않았다');
  assert.equal(await syncKeyOf(A), K3, '프로필의 연결 키를 지우지 않았다');
  assert.equal((await adapter.family(K3)).exists, false, '이전이 D1 가족을 만들지 않았다');
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: K3, logs: SEED.onlyA }) } } });

// ════════════════════════════════ 집계 ════════════════════════════════
const failed = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오 4부 보강(s4d): ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
