// 실제 서버 모드 시나리오 4부 앞쪽: 07 설계(기존 사용자 이전, 4판) 5.2의 시나리오 1~17.
// 시나리오 18~34는 real-scenarios-4b.mjs가 맡습니다. 이 파일의 기기 이름은 모두 s4a 접두어로 시작합니다(s4aA, s4aB ...).
// 실제 서버(server/src/index.ts)와 가짜 Firestore 위에서 이전 모듈(familyMigration.ts)이 그대로 돕니다.
//
// 공통 판정
//  - 모든 시나리오는 끝에서 auditFirestoreWrites로 불변 조건 2(허용 목록 밖 Firestore 쓰기·삭제 0건)를 확인합니다.
//  - 기기 기록이 줄지 않았는지(불변 조건 1)는 해당하는 시나리오마다 확인합니다.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-4a.mjs
//       HARNESS_ONLY=1,2 bash tools/sync-harness/verify.sh scenario real-scenarios-4a.mjs   (일부만)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  startRealHarness, make179Storage, auditFirestoreWrites, waitFor, waitMigrationComplete,
} from './real-harness.mjs';

const ONLY = process.env.HARNESS_ONLY ? process.env.HARNESS_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PREFIX = 's4a';

// ────────────── 시나리오 뼈대 ──────────────
/**
 * 새 서버와 기기(이름에 s4a 접두어)를 띄워 fn을 돌립니다. 기기는 접두어 없는 이름(A, B ...)으로 받습니다.
 * options: { deviceOptions: { A: { initialStorage, env } }, maxPushItems }. fn이 끝나면 불변 조건 2를 판정합니다.
 */
const scenario = async (id, title, names, fn, options = {}) => {
  if (ONLY && !ONLY.includes(id)) return;
  const started = Date.now();
  let harness = null;
  try {
    const deviceOptions = Object.fromEntries(Object.entries(options.deviceOptions || {}).map(([n, o]) => [`${PREFIX}${n}`, o]));
    harness = await startRealHarness({ devices: names.map((n) => `${PREFIX}${n}`), deviceOptions, maxPushItems: options.maxPushItems });
    const d = Object.fromEntries(names.map((n) => [n, harness.devices[`${PREFIX}${n}`]]));
    const { server } = harness;
    await server.adapter.reset();
    // reset은 서버 한도를 기본값으로 되돌리므로 한도는 reset 뒤에 다시 적용합니다.
    if (options.maxPushItems !== undefined) await server.adapter.setLimits({ maxPushItems: options.maxPushItems });
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

/** 바로 기다리지 않는 약속입니다. 시나리오가 중간에 실패해 정리되며 거부돼도 하네스가 죽지 않게 표시만 합니다. */
const track = (promise) => {
  promise.catch(() => undefined);
  return promise;
};

// ────────────── 도우미 ──────────────
/** 서버 정규식을 통과하는 32자 16진수 가족 키(시나리오 이름으로 정해져 재현됩니다). */
const hexKey = (tag) => createHash('md5').update(`${PREFIX}:${tag}`).digest('hex');
const famPath = (fs, key) => `families/${fs.familyId(key)}`;
const sortedIds = (list) => [...list].sort();
const seeds = (n, prefix, base = Date.now() - 10 * DAY, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}${String(i).padStart(4, '0')}`, type: 'formula', amount: 90, timestamp: base + i, updatedAt: base + i, ...extra,
}));
const idsOf = async (device) => sortedIds((await device.send('getLogs')).logs.map((l) => l.id));
const d1Live = async (adapter, key) => sortedIds((await adapter.logs(key)).live.map(([id]) => id));
const d1Deleted = async (adapter, key) => sortedIds((await adapter.logs(key)).deleted);
/** 회원 목록(앱이 회원 문서를 만들 수 있음)을 뺀 Firestore 가족의 내용: 가족 문서, 기록, 삭제 표식, 프로필 */
const fsContent = async (fs, key) => {
  const { members: _members, ok: _ok, ...content } = await fs.snapshot(key);
  return content;
};
const fsLive = async (fs, key) => sortedIds((await fs.snapshot(key)).live.map(([id]) => id));
const stateOf = async (device, syncKey) => (await device.send('migrationState', { syncKey }));
const syncKeyOf = async (device) => (await device.send('getProfile')).profile.syncKey ?? null;
const clientIdOf = async (device) => (await device.send('getSyncClientId')).clientId;
const newKeyFamily = async (device, key) => {
  // 1.8.0에서 새로 만드는 가족(D1에만 있음)
  const joined = await device.send('join', { key, allowFamilyCreation: true, createBackup: false });
  assert.equal(joined.outcome, 'joined', `가족 만들기 실패: ${JSON.stringify(joined)}`);
  return joined;
};
/** 러너로 평소 동기화를 한 번 돌립니다. 성공하지 않으면 예외를 던집니다. */
const runnerSync = async (device, key, extra = {}) => {
  const result = await device.send('runnerRequest', { request: { syncKey: key, ...extra }, timeoutMs: 30_000 }, { timeoutMs: 90_000 });
  assert.equal(result.success, true, `${device.name} 러너 동기화 실패: ${result.error ?? JSON.stringify(result)}`);
  return result;
};
/** Firestore 호출 기록에서 기기 하나의 것만 추립니다. */
/** 기기 시계와 Firestore 시계를 함께 옮깁니다(시나리오 안에서 harness를 따로 받지 않는 곳용). */
const harness_advance = async (device, fs, ms) => { await device.send('advanceClock', { ms }); await fs.clock({ advance: ms }); };
/** Firestore 값의 Timestamp({__ts})를 밀리초로 풉니다. */
const tsOf = (value) => value?.__ts;
const opsBy = async (fs, device, from = 0) => (await fs.ops(from)).filter((o) => o.device === device.name);
const listedLogDocs = (ops) => ops.filter((o) => o.op === 'list' && o.kind === 'logs').reduce((n, o) => n + o.returned, 0);

// ════════════════════════════════ 1. 두 기기 차례 업데이트 ════════════════════════════════
await scenario('1', '두 기기 차례 업데이트: A가 이어받아 올리고 B가 나중에 합쳐지며 연결이 끊기지 않고 세 곳의 기록 집합이 같다 (3,000건 + 삭제 표식 300건)', ['A', 'B'], async ({ adapter, fs, A, B, harness }) => {
  const K = hexKey('1');
  const base = Date.now() - 20 * DAY;
  const logs = seeds(3000, 'fs-', base);
  const tombstones = Array.from({ length: 300 }, (_, i) => `gone-${i}`);
  const bLocal = { id: 'b-local-1', type: 'formula', amount: 55, timestamp: Date.now() - HOUR, updatedAt: Date.now() - HOUR };
  await fs.seed(K, { members: ['legacy-C'], logs, tombstones });
  await A.send('bootApp');
  await B.send('bootApp');
  const firestoreBefore = await fs.snapshot(K);

  // 이전 전 첫 동기화는 관문이 막는다: 404 오류도, D1 요청도, 연결 해제도 없다.
  const mark = await adapter.requestCount();
  const gated = await A.send('runnerRequest', { request: { syncKey: K } });
  assert.equal(gated.success, false);
  assert.equal(gated.migrationPending, true, '관문이 이전 준비 중으로 돌려준다');
  assert.equal(gated.error, undefined, '관문이 막은 회차는 오류가 아니다(404 오류를 보이지 않는다)');
  assert.equal((await adapter.requests(mark)).filter((r) => r.kind !== 'connect').length, 0, '러너가 D1 동기화 요청을 보내지 않는다');
  assert.equal(await syncKeyOf(A), K, '관문이 막아도 연결은 유지된다');

  // A가 먼저 업데이트한다: 이어받기로 D1 가족이 생기고 기록이 모두 올라간다.
  const first = await A.send('runMigration');
  assert.equal(first.result.status, 'uploading', JSON.stringify(first));
  const aDone = await waitMigrationComplete(A, { syncKey: K, timeoutMs: 120_000 });
  assert.equal(aDone.state.mergeSource, 'ok');
  assert.equal(aDone.gate, 'proceed');
  assert.equal((await adapter.family(K)).exists, true, 'D1 가족이 생겼다');
  const expected = sortedIds(logs.map((l) => l.id));
  assert.deepEqual(await d1Live(adapter, K), expected, 'D1의 살아 있는 기록이 Firestore와 같다');
  const d1Gone = new Set(await d1Deleted(adapter, K));
  assert.equal(tombstones.filter((id) => d1Gone.has(id)).length, 300, '삭제 표식 300건이 D1에 삭제 표식으로 올라갔다');
  assert.deepEqual(await idsOf(A), expected, 'A의 기록');
  assert.deepEqual(await fsLive(fs, K), expected, 'Firestore의 기록');
  const aProfile = (await A.send('getProfile')).profile;
  assert.ok(tombstones.every((id) => aProfile.deletedLogIds.includes(id)), 'A의 프로필에 삭제 표식 300건');
  assert.equal(aProfile.syncKey, K, 'A의 연결이 유지된다');
  const aEvents = (await A.send('runnerEvents')).events;
  assert.equal(aEvents.filter((e) => e.type === 'disconnected').length, 0, 'A는 연결이 끊긴 적이 없다');

  // A가 이전한 뒤 기록을 하나 지우고 하나 더한다. 이 변경은 B가 업데이트하기 전에 D1에 확정된다.
  const aNew = (await A.send('addLog', { log: { type: 'formula', amount: 120, timestamp: Date.now() } })).saved;
  assert.equal((await A.send('deleteLog', { id: 'fs-0001' })).ok, true);
  await runnerSync(A, K);
  assert.ok(!(await d1Live(adapter, K)).includes('fs-0001'), 'D1에서 fs-0001이 삭제됐다');

  // B가 나중에 업데이트한다: Firestore를 다시 읽고(Firestore에는 fs-0001이 아직 살아 있다) D1 쪽과 합쳐진다.
  await B.send('saveLogs', { logs: [bLocal] });
  const markFs = await fs.opCount();
  const second = await B.send('runMigration');
  assert.equal(second.result.status, 'uploading', JSON.stringify(second));
  await waitMigrationComplete(B, { syncKey: K, timeoutMs: 120_000 });
  const bStats = (await fs.stats(markFs)).byDevice[B.name];
  assert.ok(bStats && bStats.docReads >= 3000, `B가 Firestore를 다시 읽었다 (읽은 문서 ${bStats?.docReads})`);
  assert.equal(await syncKeyOf(B), K, 'B의 연결이 유지된다');
  assert.equal((await B.send('runnerEvents')).events.filter((e) => e.type === 'disconnected').length, 0, 'B는 연결이 끊긴 적이 없다');

  // 한 회차씩 더 돌려 서로의 기록을 받는다. 세 곳(A, B, D1)의 집합이 같고, 지운 기록은 되살아나지 않는다.
  await runnerSync(B, K);
  await runnerSync(A, K);
  const finalExpected = sortedIds([...expected.filter((id) => id !== 'fs-0001'), aNew.id, bLocal.id]);
  assert.deepEqual(await d1Live(adapter, K), finalExpected, 'D1');
  assert.deepEqual(await idsOf(A), finalExpected, 'A');
  assert.deepEqual(await idsOf(B), finalExpected, 'B');
  assert.ok(!(await idsOf(B)).includes('fs-0001'), 'B가 Firestore에서 읽은 fs-0001은 서버의 삭제 표식이 되돌렸다');
  // 기록이 줄지 않았다: A와 B가 가졌던 기록은 (지운 하나를 빼고) 모두 남아 있다.
  assert.ok((await idsOf(A)).includes(aNew.id) && (await idsOf(B)).includes(bLocal.id));
  // Firestore는 읽기만 했다: 기록과 삭제 표식 집합이 그대로다.
  const firestoreAfter = await fs.snapshot(K);
  assert.deepEqual(firestoreAfter.live.map(([id]) => id).sort(), firestoreBefore.live.map(([id]) => id).sort());
  assert.deepEqual([...firestoreAfter.deleted].sort(), [...firestoreBefore.deleted].sort());
  const audit = await auditFirestoreWrites(harness);
  assert.ok(audit.appWrites.length >= 2 && audit.appWrites.every((w) => w.path.includes('/members/')), '앱의 Firestore 쓰기는 회원 문서 생성뿐');
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('1') }) }, B: { initialStorage: make179Storage({ syncKey: hexKey('1') }) } } });

// ════════════════════════════════ 2. 부활 금지 ════════════════════════════════
await scenario('2', '부활 금지: 1.8.0에서 영구 삭제한 가족에 이전을 시도하면 410이고 D1에 가족이 생기지 않으며, legacyDeletion 없는 delete는 아무것도 기록하지 않는다', ['A', 'B', 'C'], async ({ adapter, fs, server, A, B, C }) => {
  const K = hexKey('2');
  await fs.seed(K, { members: ['legacy-C'], logs: seeds(20, 'z-') });
  // 1.8.0 기기 A가 이 키로 가족을 만들고 영구 삭제한다(D1에서 삭제 기록이 남는다). Firestore 사본은 그대로 있다.
  await A.send('bootApp');
  await newKeyFamily(A, K);
  assert.equal((await A.send('scheduleDeletion')).success, true);
  await adapter.advanceClock(HOUR + 5_000);
  const deleted = await A.send('deleteFamily');
  assert.equal(deleted.success ?? deleted.ok, true, JSON.stringify(deleted));
  assert.deepEqual([(await adapter.family(K)).exists, (await adapter.family(K)).deleted], [false, true], '전제: D1에서 영구 삭제됐고 삭제 기록이 있다');
  const fsBefore = await fsContent(fs, K);
  assert.equal(fsBefore.live.length, 20, '전제: Firestore 사본이 남아 있다');

  // 1.7.9 시절 이 가족에 연결돼 있던 다른 기기 C가 이전을 시도한다.
  await C.send('bootApp');
  const mark = await fs.opCount();
  const result = await C.send('runMigration');
  assert.equal(result.result.status, 'deleted', JSON.stringify(result));
  const family = await adapter.family(K);
  assert.deepEqual([family.exists, family.deleted], [false, true], 'D1에 가족이 생기지 않았다');
  assert.equal((await adapter.logs(K)).rows.length, 0, 'D1에 기록 행도 없다');
  // 410 회차가 연결을 해제한다(관문이 deleted를 막지 않는다). 기기 기록은 남는다.
  await waitFor(async () => (await syncKeyOf(C)) === null, { label: 'C의 연결 해제(410 회차)' });
  assert.ok((await C.send('runnerEvents')).events.some((e) => e.type === 'disconnected'), '러너가 disconnected 사건을 냈다');
  assert.deepEqual(await idsOf(C), ['c-own'], '기기 기록은 남는다');
  // 이어받기는 D1 확인에서 멈추므로 Firestore를 읽지 않는다. Firestore 사본은 그대로다.
  assert.equal((await opsBy(fs, C, mark)).length, 0, 'C는 Firestore에 요청하지 않았다');
  assert.deepEqual(await fsContent(fs, K), fsBefore, 'Firestore 사본은 그대로다');

  // 다른 경로(초대 링크 합류, 가족 만들기)도 410에서 멈춘다.
  const joined = await B.send('join', { key: K, allowFamilyCreation: false, createBackup: false });
  assert.equal(joined.outcome, 'deleted', JSON.stringify(joined));
  const created = await B.send('join', { key: K, allowFamilyCreation: true, createBackup: false });
  assert.equal(created.outcome, 'deleted', `가족 만들기도 410에서 멈춘다: ${JSON.stringify(created)}`);
  assert.deepEqual([(await adapter.family(K)).exists, (await adapter.family(K)).deleted], [false, true]);
  assert.equal(await syncKeyOf(B), null, '실패한 합류는 키를 저장하지 않는다');

  // legacyDeletion 없는 delete는 가족이 없으면 404이고 deleted_families가 그대로다. 그 키로 이어서 가족을 만들 수 있다.
  const other = hexKey('2-other');
  const idB = await (async () => (await B.send('getSyncClientId')).clientId)();
  const res = await fetch(`${server.url}/api/family/delete`, {
    method: 'POST', headers: { Authorization: `Bearer ${other}`, 'X-Client-Id': idB, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 404);
  assert.deepEqual([(await adapter.family(other)).exists, (await adapter.family(other)).deleted], [false, false], 'deleted_families에 기록되지 않았다');
  const afterDelete = await B.send('join', { key: other, allowFamilyCreation: true, createBackup: false });
  assert.equal(afterDelete.outcome, 'joined', `삭제 요청이 기록됐다면 410이 된다: ${JSON.stringify(afterDelete)}`);
}, { deviceOptions: { C: { initialStorage: make179Storage({ syncKey: hexKey('2'), logs: [{ id: 'c-own', type: 'formula', timestamp: 77, updatedAt: 77 }] }) } } });

// ════════════════════════════════ 3. 1.7.9 삭제 예약 가족 ════════════════════════════════
await scenario('3', '1.7.9 삭제 예약 가족: 예약(미래·과거)이면 이어받지 않고 연결을 유지하며, null·필드 없음이면 이어받고, 취소는 이어받기까지, 삭제에 따르기는 410과 연결 해제이며 앱이 지운 Firestore 문서는 0건', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], async ({ harness, adapter, fs, A, B, C, D, E, F, G, H }) => {
  const own = (device) => ({ id: `own-${device.name}`, type: 'formula', amount: 70, timestamp: Date.now() - 2 * HOUR, updatedAt: Date.now() - 2 * HOUR });
  const seedFamily = (key, family) => fs.seed(key, { members: ['legacy-B'], family, logs: seeds(5, `p${key.slice(0, 4)}-`) });
  const prompts = async (device) => (await device.send('choiceLog')).legacyDeletion;
  const sortedOptions = (entry) => [...entry.options].sort();

  // (a) 미래 예약, (b) 과거 예약: 이어받지 않고 연결도 끊지 않는다. 선택 화면은 한 번 뜨고 "나중에"는 기록하지 않는다.
  for (const [device, tag, offset] of [[A, '3a', 2 * HOUR], [B, '3b', -3 * HOUR]]) {
    const K = hexKey(tag);
    const value = Date.now() + offset;
    await seedFamily(K, { pendingDeletionAt: value });
    await device.send('bootApp');
    const before = await fs.snapshot(K);
    const mark = await fs.opCount();
    const result = await device.send('runMigration');
    assert.equal(result.result.status, 'pending_deletion', `${tag}: ${JSON.stringify(result)}`);
    assert.equal(await syncKeyOf(device), K, `${tag}: 연결이 유지된다`);
    const family = await adapter.family(K);
    assert.deepEqual([family.exists, family.deleted], [false, false], `${tag}: 이어받지 않았다`);
    const shown = await prompts(device);
    assert.equal(shown.length, 1, `${tag}: 선택 화면이 한 번 뜬다`);
    assert.deepEqual([shown[0].context, shown[0].pendingDeletionAt, sortedOptions(shown[0])], ['missing', value, ['cancelRequest', 'followDeletion', 'later']], tag);
    assert.equal(listedLogDocs(await opsBy(fs, device, mark)), 0, `${tag}: 예약 중에는 기록을 읽지 않는다`);
    assert.deepEqual(await idsOf(device), [], `${tag}: Firestore 기록을 합치지 않았다`);
    assert.equal((await stateOf(device, K)).state.mergeSource, undefined, `${tag}: 병합 완료로 적지 않았다`);
    assert.deepEqual((await fs.snapshot(K)).family, before.family, `${tag}: Firestore 가족 문서는 그대로다`);
  }

  // (c) pendingDeletionAt: null, (d) 필드 없음: 이어받는다. 선택 화면은 뜨지 않는다.
  for (const [device, tag, family] of [[C, '3c', { pendingDeletionAt: null }], [D, '3d', {}]]) {
    const K = hexKey(tag);
    await seedFamily(K, family);
    await device.send('saveLogs', { logs: [own(device)] });
    await device.send('bootApp');
    const result = await device.send('runMigration');
    assert.equal(result.result.status, 'uploading', `${tag}: ${JSON.stringify(result)}`);
    await waitMigrationComplete(device, { syncKey: K });
    assert.equal((await adapter.family(K)).exists, true, `${tag}: 이어받았다`);
    const expected = sortedIds([...(await fsLive(fs, K)), `own-${device.name}`]);
    assert.deepEqual(await d1Live(adapter, K), expected, `${tag}: D1에 Firestore 기록과 기기 기록이 모두 올랐다`);
    assert.equal((await prompts(device)).length, 0, `${tag}: 선택 화면이 뜨지 않는다`);
    assert.equal(await syncKeyOf(device), K);
  }

  // (e) "요청 취소하고 계속 쓰기": Firestore에 pendingDeletionAt: null을 쓰고 이어받기까지 끝난다.
  {
    const K = hexKey('3e');
    await seedFamily(K, { pendingDeletionAt: Date.now() + 3 * HOUR });
    await E.send('saveLogs', { logs: [own(E)] });
    await E.send('bootApp');
    await E.send('setChoiceAnswers', { legacyDeletion: ['cancelRequest'] });
    const result = await E.send('runMigration');
    assert.equal(result.result.status, 'uploading', JSON.stringify(result));
    await waitMigrationComplete(E, { syncKey: K });
    assert.equal((await fs.snapshot(K)).family.pendingDeletionAt, null, 'Firestore의 예약이 null로 취소됐다');
    const writes = (await fs.writes({ actor: 'app' })).filter((w) => w.path === famPath(fs, K));
    assert.equal(writes.length, 1, '앱이 가족 문서에 쓴 것은 취소 한 번뿐이다');
    assert.deepEqual([writes[0].fields, writes[0].data.pendingDeletionAt, writes[0].allowed], [['pendingDeletionAt'], null, true]);
    assert.equal((await adapter.family(K)).exists, true, '이어받기까지 끝났다');
    assert.deepEqual(await d1Live(adapter, K), sortedIds([...(await fsLive(fs, K)), 'own-s4aE']));
    assert.equal((await prompts(E)).length, 1, '취소 뒤 다시 실행한 이전은 같은 화면을 다시 띄우지 않는다');
  }

  // (f) "삭제에 따르기": D1이 410을 돌려주고 이 기기는 연결이 해제되며 기록은 남는다.
  const KF = hexKey('3f');
  {
    await seedFamily(KF, { pendingDeletionAt: Date.now() + 3 * HOUR });
    await F.send('saveLogs', { logs: [own(F)] });
    await F.send('bootApp');
    const before = await fsContent(fs, KF);
    await F.send('setChoiceAnswers', { legacyDeletion: ['followDeletion'] });
    const result = await F.send('runMigration');
    assert.equal(result.result.status, 'deletion_followed', JSON.stringify(result));
    const family = await adapter.family(KF);
    assert.deepEqual([family.exists, family.deleted], [false, true], 'D1에 삭제 기록만 남았다(가족은 생기지 않았다)');
    assert.equal(await syncKeyOf(F), null, '이 기기의 연결이 해제됐다');
    assert.deepEqual(await idsOf(F), ['own-s4aF'], '기기 기록은 남는다');
    const joined = await F.send('join', { key: KF, allowFamilyCreation: false, createBackup: false });
    assert.equal(joined.outcome, 'deleted', `D1이 410을 돌려준다: ${JSON.stringify(joined)}`);
    assert.deepEqual(await fsContent(fs, KF), before, 'Firestore 사본은 건드리지 않았다');
    assert.ok((await F.send('choiceLog')).notices.some((n) => n.code === 'deletionFollowed'), '삭제에 따랐다는 안내');
  }

  // (g) D1이 exists인 가족의 예약: 평소 동기화는 계속하되 선택 화면은 같은 예약으로 한 번만 뜬다(2.4-6).
  {
    const K = hexKey('3g');
    await H.send('bootApp');
    await H.send('saveLogs', { logs: [{ id: 'h-1', type: 'formula', amount: 10, timestamp: Date.now() - HOUR, updatedAt: Date.now() - HOUR }] });
    await newKeyFamily(H, K);
    const value = Date.now() + 4 * HOUR;
    await seedFamily(K, { pendingDeletionAt: value });
    await G.send('saveLogs', { logs: [own(G)] });
    await G.send('bootApp');
    const first = await G.send('runMigration');
    assert.equal(first.result.status, 'uploading', JSON.stringify(first));
    const shown = await prompts(G);
    assert.equal(shown.length, 1, '안내가 한 번 뜬다');
    assert.deepEqual([shown[0].context, shown[0].pendingDeletionAt], ['exists', value]);
    const state = (await stateOf(G, K)).state;
    assert.equal(state.promptedPendingDeletionAt, value);
    assert.equal(typeof state.legacyDeletionNoticeAt, 'number', 'legacyDeletionNoticeAt이 적혔다');
    await waitFor(async () => (await d1Live(adapter, K)).includes('own-s4aG'), { label: '평소 동기화(7단계)가 이 기기의 기록을 올림' });
    // 간격이 지난 뒤 다시 읽어도 같은 예약으로는 다시 묻지 않는다.
    await harness.advanceClocks(31 * MINUTE);
    const mark = await fs.opCount();
    await G.send('runMigration');
    assert.ok((await opsBy(fs, G, mark)).some((o) => o.op === 'get' && o.kind === 'family'), '두 번째 시도가 Firestore를 다시 읽었다');
    assert.equal((await prompts(G)).length, 1, '같은 예약으로 다시 묻지 않는다');
    assert.equal(await syncKeyOf(G), K, '연결이 유지된다');
  }

  // 어느 경우에도 앱이 지운 Firestore 문서는 0건이고, 쓴 것은 회원 문서 생성과 pendingDeletionAt: null뿐이다.
  const audit = await auditFirestoreWrites(harness);
  assert.equal(audit.deletes.length, 0);
  assert.ok(audit.appWrites.every((w) => w.path.includes('/members/') || w.fields.join() === 'pendingDeletionAt'));
}, {
  deviceOptions: Object.fromEntries(['A:3a', 'B:3b', 'C:3c', 'D:3d', 'E:3e', 'F:3f', 'G:3g'].map((x) => {
    const [n, tag] = x.split(':');
    return [n, { initialStorage: make179Storage({ syncKey: hexKey(tag) }) }];
  })),
});

// ════════════════════════════════ 4. 1.7.9 가족 합류 ════════════════════════════════
await scenario('4', '1.7.9 가족 합류: D1에 가족이 없는 1.7.9 가족에 초대 링크로 합류하면 D1 가족, 키 저장, Firestore 기록 병합, 전환기가 생기고, 가족 문서가 없거나 거부되거나 중간에 실패하면 합류가 실패하며 그 가족의 기록이 섞이지 않는다', ['A'], async ({ harness, adapter, fs, A }) => {
  assert.deepEqual((await A.send('bootApp')).marker.keys, [], '새로 설치한 기기의 근거 표식은 비어 있다');
  const aOwn = { id: 'a-local-1', type: 'formula', amount: 66, timestamp: Date.now() - HOUR, updatedAt: Date.now() - HOUR };
  await A.send('saveLogs', { logs: [aOwn] });
  const idA = await clientIdOf(A);

  /** 실패한 합류의 공통 판정: 키 미저장, 기록이 섞이지 않음, D1 가족 없음, Firestore 기록 불변. */
  const assertFailedJoin = async (tag, key, joined, outcomes) => {
    assert.ok(outcomes.includes(joined.outcome), `${tag}: 결과 ${joined.outcome} (${JSON.stringify(joined)})`);
    assert.equal(await syncKeyOf(A), null, `${tag}: 키가 저장되지 않았다`);
    assert.deepEqual(await idsOf(A), ['a-local-1'], `${tag}: 그 가족의 기록이 기기에 섞이지 않았다`);
    const family = await adapter.family(key);
    assert.deepEqual([family.exists, family.deleted], [false, false], `${tag}: D1 가족이 생기지 않았다`);
  };

  // (a) 가족 문서가 없다: 회원 가입이 거부되므로 JOIN_NOT_FOUND로 끝난다.
  const KA = hexKey('4-absent');
  const missing = await A.send('join', { key: KA, allowFamilyCreation: false, createBackup: false });
  await assertFailedJoin('가족 문서 없음', KA, missing, ['not_found']);
  assert.equal((await fs.snapshot(KA)).members.length, 0, '가족 문서가 없으면 회원 문서도 생기지 않는다');

  // (b) 거부된다: inviteHash가 없는 예전 문서, 해시가 다른 문서
  for (const [tag, invite] of [['inviteHash 없음', 'omit'], ['inviteHash 불일치', 'deadbeef']]) {
    const K = hexKey(`4-denied-${invite}`);
    await fs.seed(K, { members: ['legacy-B'], family: { inviteHash: invite }, logs: seeds(6, 'den-') });
    const before = await fsContent(fs, K);
    const mark = await fs.opCount();
    const denied = await A.send('join', { key: K, allowFamilyCreation: false, createBackup: false });
    await assertFailedJoin(`거부(${tag})`, K, denied, ['not_found']);
    assert.equal(listedLogDocs(await opsBy(fs, A, mark)), 0, `거부(${tag}): 기록을 읽지 않았다`);
    assert.deepEqual(await fsContent(fs, K), before, `거부(${tag}): Firestore는 그대로다`);
    assert.equal((await stateOf(A, K)).state.legacyJoinedAt, undefined, `거부(${tag}): 합류 근거를 남기지 않았다`);
  }

  // (c) D1 가족을 만드는 단계가 실패한다(5xx): 합류가 실패하고 그 가족의 기록은 기기에 섞이지 않는다.
  const KM = hexKey('4-mix');
  await fs.seed(KM, { members: ['legacy-B'], logs: seeds(6, 'mix-') });
  await adapter.failHttp({ status: 503, match: { kind: 'connect' }, skip: 1, times: 1 });
  const interrupted = await A.send('join', { key: KM, allowFamilyCreation: false, createBackup: false });
  await assertFailedJoin('D1 가족 만들기 실패', KM, interrupted, ['failed']);
  await adapter.clearFaults();

  // (d) 성공: D1 가족이 생기고, 키가 저장되며, Firestore 기록이 합쳐지고, 전환기가 생긴다.
  const K = hexKey('4-ok');
  const okLogs = seeds(8, 'ok-');
  await fs.seed(K, { members: ['legacy-B'], logs: okLogs });
  const joined = await A.send('join', { key: K, allowFamilyCreation: false, createBackup: false, waitMigration: true });
  assert.equal(joined.outcome, 'joined', JSON.stringify(joined));
  assert.equal(joined.migrationResult?.status, 'uploading', '근거가 있는 합류는 2.4가 시작된다');
  const done = await waitMigrationComplete(A, { syncKey: K });
  assert.equal(await syncKeyOf(A), K, '키가 저장됐다');
  const family = await adapter.family(K);
  assert.equal(family.exists, true, 'D1 가족이 생겼다');
  assert.ok(family.members.some((m) => m.clientId === idA), '이 기기가 회원이다');
  const expected = sortedIds([...okLogs.map((l) => l.id), 'a-local-1']);
  assert.deepEqual(await idsOf(A), expected, 'Firestore 기록이 기기에 합쳐졌다(기기 기록도 남았다)');
  assert.deepEqual(await d1Live(adapter, K), expected, 'D1에도 올랐다');
  assert.equal(done.state.mergeSource, 'ok');
  assert.equal(typeof done.state.legacyJoinedAt, 'number', 'legacyJoinedAt이 적혔다');
  assert.equal(typeof done.transition.seenFamilyChangedAt, 'number', '전환기 상태가 생겼다');
  assert.equal((await A.send('moduleLoads')).firebaseLoaded, true, '합류가 404를 받은 뒤에야 firebase.ts를 불러왔다');
  // 전환기가 실제로 돈다: 1.7.9 상대가 쓴 기록이 다음 전환기 읽기에 들어온다.
  await fs.legacy179Write(K, { uid: 'legacy-B', logs: [{ id: 'late-1', type: 'formula', amount: 5, timestamp: Date.now(), updatedAt: Date.now() }] });
  const tick = await A.send('transitionTick', { force: true });
  assert.equal(tick.status, 'merged', JSON.stringify(tick));
  assert.ok((await idsOf(A)).includes('late-1'), '전환기 읽기로 상대의 기록이 들어왔다');
  // 앱이 Firestore에 쓴 것은 회원 문서 생성뿐이고(거부된 시도 포함) 지운 것은 없다.
  const audit = await auditFirestoreWrites(harness);
  assert.ok(audit.appWrites.length >= 1 && audit.appWrites.every((w) => w.path.includes('/members/')));
  assert.deepEqual((await fsContent(fs, KA)).live, [], '가족 문서가 없던 가족에는 아무것도 생기지 않았다');
});

// ════════════════════════════════ 5. 동시 이어받기 ════════════════════════════════
await scenario('5', '동시 이어받기: 두 기기가 같은 키로 동시에 가족을 만들어도 가족 행은 하나이고 다음 회차 안에 서로의 기록을 받는다', ['A', 'B'], async ({ adapter, fs, A, B }) => {
  const K = hexKey('5');
  const logs = seeds(200, 'c-');
  await fs.seed(K, { members: ['legacy-C'], logs });
  const aOwn = { id: 'a-own', type: 'formula', amount: 11, timestamp: Date.now() - HOUR, updatedAt: Date.now() - HOUR };
  const bOwn = { id: 'b-own', type: 'formula', amount: 22, timestamp: Date.now() - 2 * HOUR, updatedAt: Date.now() - 2 * HOUR };
  await A.send('saveLogs', { logs: [aOwn] });
  await B.send('saveLogs', { logs: [bOwn] });
  for (const device of [A, B]) {
    await device.send('bootApp');
    // 멈춘 요청이 기기의 요청 상한(스케일 1초)에 걸리지 않게 늘린다.
    await device.send('setTiming', { requestTimeoutMs: 10_000, cycleBudgetMs: 10_000, pullBudgetMs: 10_000 });
  }
  const [idA, idB] = [await clientIdOf(A), await clientIdOf(B)];

  // 두 기기의 이어받기 요청(두 번째 connect, allowCreate=true)을 서버에서 멈춰 둘 다 "가족 없음"을 본 채 동시에 만들게 한다.
  const gateA = await adapter.holdNext({ kind: 'connect', clientId: idA }, { skip: 1 });
  const gateB = await adapter.holdNext({ kind: 'connect', clientId: idB }, { skip: 1 });
  const runA = track(A.send('runMigration'));
  const runB = track(B.send('runMigration'));
  await Promise.all([gateA.held, gateB.held]);
  assert.equal((await adapter.family(K)).exists, false, '전제: 둘 다 가족이 없는 상태에서 만들기를 시작했다');
  await Promise.all([gateA.release(), gateB.release()]);
  const [resA, resB] = await Promise.all([runA, runB]);
  assert.equal(resA.result.status, 'uploading', JSON.stringify(resA));
  assert.equal(resB.result.status, 'uploading', JSON.stringify(resB));
  await Promise.all([waitMigrationComplete(A, { syncKey: K }), waitMigrationComplete(B, { syncKey: K })]);

  const family = await adapter.family(K);
  assert.equal(family.exists, true);
  assert.deepEqual(family.members.map((m) => m.clientId).sort(), [idA, idB].sort(), '가족은 하나이고 두 기기가 회원이다');
  assert.equal(await syncKeyOf(A), K);
  assert.equal(await syncKeyOf(B), K);

  // 다음 회차 한 번씩으로 서로의 기록을 받는다.
  await runnerSync(A, K);
  await runnerSync(B, K);
  const expected = sortedIds([...logs.map((l) => l.id), 'a-own', 'b-own']);
  const live = await d1Live(adapter, K);
  assert.equal(new Set(live).size, live.length, 'D1에 중복 행이 없다');
  assert.deepEqual(live, expected, 'D1');
  assert.deepEqual(await idsOf(A), expected, 'A는 B의 기록을 받았다');
  assert.deepEqual(await idsOf(B), expected, 'B는 A의 기록을 받았다');
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('5') }) }, B: { initialStorage: make179Storage({ syncKey: hexKey('5') }) } } });

// ════════════════════════════════ 6. uid 변경과 예전 문서 ════════════════════════════════
await scenario('6', 'uid 변경과 예전 문서: 근거가 있으면 거부여도 연결을 유지하고 간격(30분→6시간 상한) 뒤 다시 시도하며, 근거가 없으면 오류만 보이고, D1 exists면 14일 뒤 읽기를 멈추고 missing이면 멈추지 않는다', ['A', 'B', 'C', 'D', 'H'], async ({ harness, adapter, fs, A, B, C, D, H }) => {
  const M = (await A.send('migrationMessages')).messages;
  const nowOf = async (device) => (await device.send('getClock')).now;
  const oldDoc = (key, logs = 10) => fs.seed(key, { members: ['legacy-old'], family: { inviteHash: 'omit' }, logs: seeds(logs, `u${key.slice(0, 3)}-`) });
  const healFamily = (key) => fs.putDoc(famPath(fs, key), { inviteHash: fs.inviteHash(key) }, { merge: true });

  // (a) 근거가 있는 기기: 회원 생성이 거부돼도(예전 문서) 연결을 유지하고 간격 뒤 다시 시도한다.
  {
    const K = hexKey('6a');
    await oldDoc(K);
    await A.send('bootApp');
    assert.ok((await A.send('migrationState')).marker.keys.includes(K), '전제: 근거가 있다');
    const first = await A.send('runMigration');
    assert.equal(first.result.status, 'firestore_denied', JSON.stringify(first));
    let state = (await stateOf(A, K)).state;
    assert.equal(state.lastError, M.firestoreError, '근거가 있으면 거부를 firestore_error로 낮춘다(초대 링크 안내가 아니다)');
    assert.notEqual(state.lastError, M.deniedNoEvidence);
    assert.equal(await syncKeyOf(A), K, '연결을 유지한다');
    assert.equal((await adapter.family(K)).exists, false);
    const delta = state.nextFirestoreAttemptAt - await nowOf(A);
    assert.ok(delta > 29 * MINUTE && delta <= 30 * MINUTE, `다음 시도는 30분 뒤다: ${delta / MINUTE}분`);
    // 간격 안에서는 Firestore를 다시 부르지 않는다.
    let mark = await fs.opCount();
    const waiting = await A.send('runMigration');
    assert.equal(waiting.result.status, 'waiting', JSON.stringify(waiting));
    assert.equal((await opsBy(fs, A, mark)).length, 0, '간격 안에서는 Firestore 요청이 없다');
    // 간격 뒤 다시 시도한다(아직 거부): 두 번째 간격은 1시간이다.
    await harness.advanceClocks(31 * MINUTE);
    mark = await fs.opCount();
    assert.equal((await A.send('runMigration')).result.status, 'firestore_denied');
    assert.ok((await opsBy(fs, A, mark)).length > 0, '간격 뒤 Firestore를 다시 읽었다');
    state = (await stateOf(A, K)).state;
    assert.equal(state.failureCount, 2);
    const delta2 = state.nextFirestoreAttemptAt - await nowOf(A);
    assert.ok(delta2 > 59 * MINUTE && delta2 <= HOUR, `두 번째 간격은 1시간이다: ${delta2 / MINUTE}분`);
    assert.equal(await syncKeyOf(A), K);
    // 문서가 고쳐지면(예전 문서에 inviteHash가 생김) 다음 시도에서 이어받는다.
    await healFamily(K);
    await harness.advanceClocks(61 * MINUTE);
    assert.equal((await A.send('runMigration')).result.status, 'uploading');
    await waitMigrationComplete(A, { syncKey: K });
    assert.equal((await adapter.family(K)).exists, true);
  }

  // (b) 근거가 없는 기기: 오류만 보이고 앱이 연결을 끊지 않는다.
  {
    const K = hexKey('6b');
    await oldDoc(K);
    await B.send('bootApp');
    await B.send('setProfile', { patch: { syncKey: K } });
    assert.ok(!(await B.send('migrationState')).marker.keys.includes(K), '전제: 이 키는 근거가 아니다');
    const result = await B.send('runMigration');
    assert.equal(result.result.status, 'firestore_denied', JSON.stringify(result));
    const state = (await stateOf(B, K)).state;
    assert.equal(state.lastError, M.deniedNoEvidence, '"가족 연결을 확인할 수 없습니다. 초대 링크를 다시 받아 주세요."');
    assert.ok((await B.send('choiceLog')).notices.some((n) => n.level === 'error' && n.message === M.deniedNoEvidence), '오류 안내가 보인다');
    assert.equal(await syncKeyOf(B), K, '앱이 스스로 연결을 끊지 않는다');
    assert.equal((await adapter.family(K)).exists, false);
    assert.equal((await B.send('runnerEvents')).events.filter((e) => e.type === 'disconnected').length, 0);
  }

  // (c) D1이 exists인 가족: 거부가 14일 넘게 이어지면 Firestore 읽기를 멈추고 mergeSource를 skipped로 적는다.
  {
    const K = hexKey('6c');
    await oldDoc(K);
    await H.send('bootApp');
    await newKeyFamily(H, K);
    await C.send('bootApp');
    const t0 = await nowOf(C);
    assert.equal((await C.send('runMigration')).result.status, 'uploading');
    await waitFor(async () => typeof (await stateOf(C, K)).state.d1UploadedAt === 'number', { label: 'C의 7단계 완료' });
    assert.equal((await stateOf(C, K)).state.mergeSource, undefined, '거부 중에는 병합 완료가 아니다');
    assert.equal((await stateOf(C, K)).complete, false);
    // 13일: 아직 멈추지 않는다. 읽기는 계속 시도하고 7일이 넘었으니 안내가 "다시 확인해 주세요"로 바뀐다.
    await harness.advanceClocks(13 * DAY);
    let mark = await fs.opCount();
    await C.send('runMigration');
    assert.ok((await opsBy(fs, C, mark)).length > 0, '13일째에도 Firestore 읽기를 시도한다');
    let state = (await stateOf(C, K)).state;
    assert.equal(state.mergeSource, undefined, '14일 전에는 멈추지 않는다');
    assert.equal(state.lastError, M.deniedLong, '7일이 넘으면 안내가 바뀐다');
    assert.ok(state.blockedSince <= t0 + 5_000, 'blockedSince는 처음 거부된 시각이다');
    // 15일: 14일을 넘기면 읽기를 멈추고 이전이 끝난다.
    await harness.advanceClocks(2 * DAY);
    mark = await fs.opCount();
    await C.send('runMigration');
    state = (await stateOf(C, K)).state;
    assert.equal(state.mergeSource, 'skipped', '14일 넘게 거부가 이어지면 skipped로 멈춘다');
    assert.equal(typeof state.mergedAt, 'number');
    assert.equal((await stateOf(C, K)).complete, true);
    assert.ok((await C.send('choiceLog')).notices.some((n) => n.code === 'firestoreGaveUp' && n.message === M.gaveUp), '"이전 서버의 기록을 가져오지 못했습니다"를 한 번 보인다');
    // 멈춘 뒤에는 Firestore를 다시 읽지 않는다.
    mark = await fs.opCount();
    await harness.advanceClocks(2 * DAY);
    assert.equal((await C.send('runMigration')).result.status, 'complete');
    assert.equal((await opsBy(fs, C, mark)).length, 0, '멈춘 뒤에는 Firestore 요청이 없다');
    assert.equal(await syncKeyOf(C), K, '연결은 유지된다');
  }

  // (d) D1이 missing인 가족: 14일이 넘어도 멈추지 않는다. 간격은 6시간을 넘지 않는다.
  {
    const K = hexKey('6d');
    await oldDoc(K);
    await D.send('bootApp');
    const deltas = [];
    for (let i = 0; i < 7; i += 1) {
      const mark = await fs.opCount();
      const result = await D.send('runMigration');
      assert.equal(result.result.status, 'firestore_denied', `${i + 1}번째: ${JSON.stringify(result)}`);
      assert.ok((await opsBy(fs, D, mark)).length > 0, `${i + 1}번째 시도가 Firestore를 읽었다`);
      const delta = (await stateOf(D, K)).state.nextFirestoreAttemptAt - await nowOf(D);
      deltas.push(Math.round(delta / MINUTE));
      await harness.advanceClocks(delta + MINUTE);
    }
    assert.deepEqual(deltas, [30, 60, 120, 240, 360, 360, 360], '간격은 30분부터 두 배씩 늘고 6시간을 넘지 않는다(분)');
    // 14일이 훌쩍 지난 뒤에도 읽기를 계속 시도한다(멈추면 이어받을 길이 없다).
    await harness.advanceClocks(15 * DAY);
    const mark = await fs.opCount();
    const late = await D.send('runMigration');
    assert.equal(late.result.status, 'firestore_denied', JSON.stringify(late));
    assert.ok((await opsBy(fs, D, mark)).length > 0, '14일이 지나도 Firestore를 읽는다');
    let state = (await stateOf(D, K)).state;
    assert.equal(state.mergeSource, undefined, 'missing은 멈추지 않는다');
    assert.ok(state.blockedSince <= (await nowOf(D)) - 14 * DAY, '전제: 거부가 14일 넘게 이어졌다');
    assert.ok(state.nextFirestoreAttemptAt - await nowOf(D) <= 360 * MINUTE, '간격 최대값 6시간');
    // 문서가 고쳐지면 이어받을 수 있다.
    await healFamily(K);
    await harness.advanceClocks(7 * HOUR);
    assert.equal((await D.send('runMigration')).result.status, 'uploading');
    await waitMigrationComplete(D, { syncKey: K });
    assert.equal((await adapter.family(K)).exists, true, '멈추지 않았으므로 이어받을 수 있었다');
  }
}, { deviceOptions: Object.fromEntries(['A:6a', 'C:6c', 'D:6d'].map((x) => { const [n, tag] = x.split(':'); return [n, { initialStorage: make179Storage({ syncKey: hexKey(tag) }) }]; })) });

// ════════════════════════════════ 7. 강제 종료 시점 ════════════════════════════════
await scenario('7', '강제 종료 시점: 백업 직후, 페이지 읽기 중간(저장된 위치부터 이어 읽음), 병합 저장 직후, 이어받기 직후, D1 업로드 묶음 중간에 끝내고 다시 띄워도 기록이 줄지 않고 이전이 끝나며, 느린 망에서는 진척이 있으면 5분 뒤 다시 시도한다', ['A', 'B', 'C', 'D', 'E', 'F'], async ({ adapter, fs, A, B, C, D, E, F }) => {
  const localOf = (tag, n = 5) => seeds(n, `loc-${tag}-`, Date.now() - 3 * HOUR);
  const BACKUP_KEY = '@baby_pre_cloudflare_backup_v1';
  const startFamily = async (device, tag, familyLogs) => {
    const K = hexKey(`7${tag}`);
    await fs.seed(K, { members: ['legacy-C'], logs: familyLogs });
    await device.send('bootApp');
    return K;
  };
  const dies = async (promise, label) => {
    await assert.rejects(promise, /exited|SIGKILL/, `${label}: 기기가 종료돼야 한다`);
  };
  const settled = async () => { await waitFor(async () => (await fs.held()).length === 0, { label: '걸쇠가 모두 풀림' }); };
  const completes = async (device, K, expected, label) => {
    const result = await device.send('runMigration');
    assert.ok(['uploading', 'waiting', 'complete'].includes(result.result.status), `${label}: ${JSON.stringify(result)}`);
    await waitMigrationComplete(device, { syncKey: K, timeoutMs: 60_000 });
    await runnerSync(device, K);
    assert.deepEqual(await idsOf(device), expected, `${label}: 기기 기록`);
    assert.deepEqual(await d1Live(adapter, K), expected, `${label}: D1 기록`);
    assert.equal(await syncKeyOf(device), K, `${label}: 연결 유지`);
  };

  // (1) 백업 직후: 백업 값은 적혔고 표지는 아직. 다시 띄우면 백업을 덮어쓰지 않고 표지를 채운 뒤 끝낸다.
  {
    const famLogs = seeds(40, 'fa-');
    const K = await startFamily(A, 'a', famLogs);
    await A.send('saveLogs', { logs: localOf('a') });
    await A.send('injectStorageFault', { mode: 'exit', keys: [BACKUP_KEY] });
    await dies(A.send('runMigration'), '백업 직후');
    await A.restart();
    let state = await stateOf(A, K);
    assert.equal(state.hasBackupValue, true, '백업 값은 저장됐다');
    assert.equal(state.backupMeta, null, '표지는 아직 없다(표지 쓰기 직전 종료)');
    const backupBefore = (await A.send('readStorage', { keys: [BACKUP_KEY] })).items[BACKUP_KEY];
    assert.equal(JSON.parse(backupBefore).logs.length, 5, '백업에는 이전 직전의 기기 기록이 들어 있다');
    assert.deepEqual(await idsOf(A), sortedIds(localOf('a').map((l) => l.id)), '기록이 줄지 않았다');
    await completes(A, K, sortedIds([...famLogs, ...localOf('a')].map((l) => l.id)), '백업 직후');
    state = await stateOf(A, K);
    assert.equal(state.backupMeta?.logCount, 5, '표지가 채워졌다');
    assert.equal((await A.send('readStorage', { keys: [BACKUP_KEY] })).items[BACKUP_KEY], backupBefore, '백업을 덮어쓰지 않았다');
  }

  // (2) Firestore 페이지 읽기 중간: 읽은 페이지는 저장돼 있고, 다음 시도는 저장된 위치부터 읽어 읽은 페이지를 다시 읽지 않는다.
  {
    const famLogs = seeds(1200, 'fb-');
    const K = await startFamily(B, 'b', famLogs);
    await B.send('saveLogs', { logs: localOf('b') });
    const gate = await fs.holdNext({ op: 'list', kind: 'logs', device: B.name }, { skip: 1 });
    const running = track(B.send('runMigration'));
    await gate.held;
    const mid = await stateOf(B, K);
    assert.equal(mid.state.firestoreReadAfter, 'fb-0499', '첫 페이지(500건)를 합치고 위치를 적었다');
    assert.ok((await idsOf(B)).includes('fb-0000') && (await idsOf(B)).includes('fb-0499'), '첫 페이지가 기기에 저장됐다');
    await B.kill();
    await gate.release();
    await dies(running, '페이지 읽기 중간');
    await settled();
    await B.restart();
    await B.send('bootApp');
    assert.equal((await stateOf(B, K)).state.firestoreReadAfter, 'fb-0499', '다시 띄워도 저장된 위치가 남아 있다');
    assert.ok((await idsOf(B)).includes('fb-0499'), '기록이 줄지 않았다');
    const mark = await fs.opCount();
    await completes(B, K, sortedIds([...famLogs, ...localOf('b')].map((l) => l.id)), '페이지 읽기 중간');
    assert.equal(listedLogDocs(await opsBy(fs, B, mark)), 700, '저장된 위치 뒤의 700건만 읽었다(첫 페이지를 다시 읽지 않았다)');
  }

  // (3) 병합 저장 직후: 첫 페이지를 합쳐 저장한 직후 종료(위치는 아직 못 적음). 합친 기록은 남고, 다시 읽어도 중복 없이 끝난다.
  {
    const famLogs = seeds(1200, 'fc-');
    const K = await startFamily(C, 'c', famLogs);
    await C.send('saveLogs', { logs: localOf('c') });
    await C.send('injectStorageFault', { mode: 'exit', keys: ['@baby_logs'] });
    await dies(C.send('runMigration'), '병합 저장 직후');
    await C.restart();
    await C.send('bootApp');
    const afterKill = await idsOf(C);
    assert.ok(afterKill.includes('fc-0000') && afterKill.includes('fc-0499'), '병합한 첫 페이지가 저장돼 있다');
    assert.ok(localOf('c').every((l) => afterKill.includes(l.id)), '기기 기록이 줄지 않았다');
    assert.equal((await stateOf(C, K)).state.firestoreReadAfter, undefined, '위치는 적히기 전에 종료됐다');
    await completes(C, K, sortedIds([...famLogs, ...localOf('c')].map((l) => l.id)), '병합 저장 직후');
    assert.equal(new Set(await idsOf(C)).size, 1205, '중복이 없다');
  }

  // (4) 이어받기 직후: D1 가족이 생기고 병합 결과가 적힌 상태에서, 첫 업로드 요청이 서버에 닿기 전에 종료한다.
  {
    const famLogs = seeds(300, 'fd-');
    const K = await startFamily(D, 'd', famLogs);
    await D.send('saveLogs', { logs: localOf('d') });
    await D.send('setTiming', { requestTimeoutMs: 10_000, cycleBudgetMs: 10_000, pullBudgetMs: 10_000 });
    const gate = await adapter.holdNext({ kind: 'push', clientId: await clientIdOf(D), hasPushItems: true });
    const result = await D.send('runMigration');
    assert.equal(result.result.status, 'uploading', JSON.stringify(result));
    await gate.held;
    assert.equal((await adapter.family(K)).exists, true, '이어받기가 끝났다');
    assert.equal((await d1Live(adapter, K)).length, 0, '첫 업로드는 아직 서버에 닿지 않았다');
    const state = await stateOf(D, K);
    assert.deepEqual([state.state.mergeSource, state.state.d1UploadedAt], ['ok', undefined], '병합은 끝났고 업로드는 아직이다');
    await D.kill();
    await gate.release();
    await settled();
    await D.restart();
    await D.send('bootApp');
    assert.ok((await idsOf(D)).includes('fd-0299'), '기록이 줄지 않았다');
    await completes(D, K, sortedIds([...famLogs, ...localOf('d')].map((l) => l.id)), '이어받기 직후');
  }

  // (5) D1 업로드 묶음 중간: 첫 묶음(100건)이 확정되고 둘째 묶음이 서버에 닿기 전에 종료한다.
  {
    const famLogs = seeds(30, 'fe-');
    const K = await startFamily(E, 'e', famLogs);
    const locals = localOf('e', 350);
    await E.send('saveLogs', { logs: locals });
    await E.send('setTiming', { requestTimeoutMs: 10_000, cycleBudgetMs: 10_000, pullBudgetMs: 10_000 });
    const gate = await adapter.holdNext({ kind: 'push', clientId: await clientIdOf(E), hasPushItems: true }, { skip: 1 });
    await E.send('runMigration');
    await gate.held;
    const partial = (await d1Live(adapter, K)).length;
    assert.ok(partial > 0 && partial < 380, `업로드가 반쯤 끝났다: ${partial}/380`);
    await E.kill();
    await gate.release();
    await settled();
    await E.restart();
    await E.send('bootApp');
    assert.equal((await idsOf(E)).length, 380, '기록이 줄지 않았다');
    await completes(E, K, sortedIds([...famLogs, ...locals].map((l) => l.id)), 'D1 업로드 묶음 중간');
  }

  // (6) 느린 망: 둘째 페이지가 상한에 걸려도 한 페이지를 합쳤으므로 실패 횟수가 0이고 5분 뒤 다시 시도한다. 다음 시도는 페이지 크기를 줄여 이어 읽는다.
  {
    const famLogs = seeds(1200, 'ff-');
    const K = await startFamily(F, 'f', famLogs);
    await fs.hang({ op: 'list', kind: 'logs', device: F.name }, { skip: 1 });
    const mark0 = await fs.opCount();
    const first = await F.send('runMigration');
    assert.equal(first.result.status, 'firestore_failed', JSON.stringify(first));
    assert.equal((await fs.stats(mark0)).terminates, 1, '상한에 걸려 Firestore를 닫았다');
    const state = (await stateOf(F, K)).state;
    assert.equal(state.firestoreReadAfter, 'ff-0499', '첫 페이지까지 합쳤다');
    assert.equal(state.failureCount, 0, '진척이 있으면 실패 횟수를 0으로 되돌린다');
    const delta = state.nextFirestoreAttemptAt - (await F.send('getClock')).now;
    assert.ok(delta > 4.9 * MINUTE && delta <= 5 * MINUTE, `다음 시도는 5분 뒤다(실제 ${delta / MINUTE}분)`);
    await harness_advance(F, fs, 6 * MINUTE);
    const mark = await fs.opCount();
    await completes(F, K, sortedIds(famLogs.map((l) => l.id)), '느린 망');
    const retry = (await opsBy(fs, F, mark)).filter((o) => o.op === 'list' && o.kind === 'logs');
    assert.equal(listedLogDocs(retry), 700, '저장된 위치부터 700건만 읽었다');
    assert.equal(retry.length, 3, '페이지 크기가 500에서 250으로 줄어 세 페이지로 읽었다(250, 250, 200)');
  }
}, {
  maxPushItems: 100,
  deviceOptions: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((t) => [t.toUpperCase(), { initialStorage: make179Storage({ syncKey: hexKey(`7${t}`) }) }])),
});

// ════════════════════════════════ 8. 병합 완료 + D1 missing ════════════════════════════════
await scenario('8', '병합 완료 + D1 missing: mergeSource ok 뒤 이어받기 전에 종료하고 다시 띄우면 기록은 다시 읽지 않고 가족 문서를 다시 확인한 뒤 이어받으며(예약이 생겼으면 이어받지 않음), mergeSource skipped 키에서 D1 가족이 사라지면 오류만 보이고 이어받지 않는다', ['A', 'S', 'H'], async ({ adapter, fs, A, S, H }) => {
  const relaxTiming = (device) => device.send('setTiming', { requestTimeoutMs: 10_000, cycleBudgetMs: 10_000, pullBudgetMs: 10_000 });

  // (a) ok + missing
  {
    const K = hexKey('8a');
    const famLogs = seeds(100, 'ga-');
    const locals = seeds(3, 'loc-a-', Date.now() - 3 * HOUR);
    await fs.seed(K, { members: ['legacy-B'], logs: famLogs });
    await A.send('bootApp');
    await A.send('saveLogs', { logs: locals });
    await relaxTiming(A);
    // 이어받기 요청(두 번째 connect)을 서버에 닿기 전에 멈춘 채 종료한다. 병합 완료(mergeSource ok)는 이미 적혀 있다.
    const gate = await adapter.holdNext({ kind: 'connect', clientId: await clientIdOf(A) }, { skip: 1 });
    const running = track(A.send('runMigration'));
    await gate.held;
    const mid = (await stateOf(A, K)).state;
    assert.equal(mid.mergeSource, 'ok', '병합 완료가 적혔다');
    assert.equal(mid.d1UploadedAt, undefined);
    assert.equal((await adapter.family(K)).exists, false, '전제: 아직 이어받지 못했다');
    await A.kill();
    await assert.rejects(running, /exited/);
    // 상대(1.7.9)가 그 사이 삭제를 예약한다.
    await fs.legacy179Schedule(K, { uid: 'legacy-B' });
    await A.restart();
    await A.send('bootApp');
    const mark = await fs.opCount();
    const pending = await A.send('runMigration');
    assert.equal(pending.result.status, 'pending_deletion', `예약 중이면 이어받지 않는다: ${JSON.stringify(pending)}`);
    assert.equal((await adapter.family(K)).exists, false, '예약 중에는 D1 가족을 만들지 않았다');
    let ops = await opsBy(fs, A, mark);
    assert.ok(ops.some((o) => o.op === 'get' && o.kind === 'family'), '가족 문서를 다시 확인했다');
    assert.equal(listedLogDocs(ops), 0, '기록은 다시 읽지 않았다');
    assert.equal((await A.send('choiceLog')).legacyDeletion.at(-1).context, 'missing', '2.4.1 선택 화면');
    assert.equal(await syncKeyOf(A), K);
    // 상대가 예약을 취소하면 가족 문서를 다시 읽어 이어받는다.
    await fs.legacy179Cancel(K, { uid: 'legacy-B' });
    const adopted = await A.send('runMigration');
    assert.equal(adopted.result.status, 'uploading', JSON.stringify(adopted));
    await waitMigrationComplete(A, { syncKey: K });
    assert.equal((await adapter.family(K)).exists, true, '이어받았다');
    ops = await opsBy(fs, A, mark);
    assert.equal(listedLogDocs(ops), 0, '끝날 때까지 기록을 다시 읽지 않았다(병합은 한 번)');
    assert.equal((await stateOf(A, K)).state.mergeSource, 'ok');
    const expected = sortedIds([...famLogs, ...locals].map((l) => l.id));
    assert.deepEqual(await d1Live(adapter, K), expected, 'D1에 모든 기록이 올랐다');
    assert.deepEqual(await idsOf(A), expected, '기록이 줄지 않았다');
  }

  // (b) skipped + missing: 서버 이상으로 보고 오류만 보인다.
  {
    const K = hexKey('8s');
    await H.send('bootApp');
    await H.send('saveLogs', { logs: [{ id: 'h-1', type: 'formula', amount: 10, timestamp: Date.now() - HOUR, updatedAt: Date.now() - HOUR }] });
    await newKeyFamily(H, K);
    // 근거가 없는 기기: 새로 설치한 뒤 이 키로 연결된 1.8.0 기기(표식은 빈 배열)
    assert.deepEqual((await S.send('bootApp')).marker.keys, []);
    await S.send('setProfile', { patch: { syncKey: K } });
    const locals = seeds(20, 'loc-s-', Date.now() - 3 * HOUR);
    await S.send('saveLogs', { logs: locals });
    await relaxTiming(S);
    // 첫 업로드 요청(7단계)을 서버에 닿기 전에 멈춘 채 종료한다. skipped는 이미 적혀 있다.
    const gate = await adapter.holdNext({ kind: 'push', clientId: await clientIdOf(S), hasPushItems: true });
    const run = await S.send('runMigration');
    assert.equal(run.result.status, 'uploading', JSON.stringify(run));
    await gate.held;
    const mid = (await stateOf(S, K)).state;
    assert.deepEqual([mid.mergeSource, mid.d1UploadedAt], ['skipped', undefined], '근거가 없어 Firestore를 읽지 않고 skipped로 적혔다');
    await S.kill();
    // D1 가족이 사라진다(서버 이상).
    await adapter.removeFamily(K);
    assert.equal((await adapter.family(K)).exists, false);
    await S.restart();
    await S.send('bootApp');
    const result = await S.send('runMigration');
    assert.equal(result.result.status, 'server_anomaly', JSON.stringify(result));
    assert.equal(result.result.message, (await S.send('migrationState')).state.lastError, '오류 문구가 상태에 남는다');
    assert.ok((await S.send('choiceLog')).notices.some((n) => n.level === 'error' && n.code === 'serverAnomaly'), '오류만 보인다');
    const family = await adapter.family(K);
    assert.deepEqual([family.exists, family.deleted], [false, false], '이어받지 않았다(D1 가족을 만들지 않았다)');
    assert.equal(await syncKeyOf(S), K, '연결은 유지된다');
    assert.deepEqual(await idsOf(S), sortedIds([...locals.map((l) => l.id), 'h-1']), '기록이 줄지 않았다(7단계 당겨 받기로 받은 h-1도 남는다)');
    // 평소 동기화도 가족을 만들지 않는다(404 보존).
    const round = await S.send('runnerRequest', { request: { syncKey: K }, timeoutMs: 20_000 });
    assert.equal(round.success, false);
    assert.equal((await adapter.family(K)).exists, false, '평소 동기화도 가족을 만들지 않았다');
    assert.equal(await syncKeyOf(S), K, '404는 연결 해제 근거가 아니다');
    // 근거가 없는 키라 Firestore는 한 번도 부르지 않았다.
    assert.equal((await opsBy(fs, S)).length, 0, 'S는 Firestore에 요청하지 않았다');
    assert.equal((await S.send('moduleLoads')).firestoreImportLoaded, false);
  }
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('8a') }) } } });

// ════════════════════════════════ 9. 이전 중 가족 전환 ════════════════════════════════
await scenario('9', '이전 중 가족 전환: 이전이 도는 동안 키를 바꾸면 앞 가족의 병합 결과가 새 가족에 섞이지 않고, 저장이 거부된 페이지는 위치를 올리지 않아 원래 키로 돌아오면 그 페이지부터 빠짐없이 합쳐진다', ['A', 'B', 'H', 'H2'], async ({ adapter, fs, A, B, H, H2 }) => {
  const setKey = (device, key) => device.send('setProfile', { patch: { syncKey: key } });
  const settled = async () => { await waitFor(async () => (await fs.held()).length === 0, { label: '걸쇠가 모두 풀림' }); };
  // 새 가족(D1에만 있음) 둘: 전환 대상
  const OTHER1 = hexKey('9-other1');
  const OTHER2 = hexKey('9-other2');
  await H.send('bootApp');
  await H2.send('bootApp');
  await newKeyFamily(H, OTHER1);
  await newKeyFamily(H2, OTHER2);

  // (a) 둘째 페이지가 멈춰 있는 사이 키를 바꾼다: 둘째 페이지는 합쳐지지 않고 위치는 첫 페이지에 머문다.
  {
    const K = hexKey('9a');
    const famLogs = seeds(1200, 'fg-');
    const locals = seeds(3, 'loc-a-', Date.now() - 3 * HOUR);
    await fs.seed(K, { members: ['legacy-B'], logs: famLogs });
    await A.send('bootApp');
    await A.send('saveLogs', { logs: locals });
    const gate = await fs.holdNext({ op: 'list', kind: 'logs', device: A.name }, { skip: 1 });
    const running = track(A.send('runMigration'));
    await gate.held;
    assert.equal((await stateOf(A, K)).state.firestoreReadAfter, 'fg-0499', '전제: 첫 페이지까지 합쳤다');
    await setKey(A, OTHER1);
    await gate.release();
    const result = await running;
    assert.equal(result.result.status, 'superseded', JSON.stringify(result));
    await settled();
    const stored = await idsOf(A);
    assert.deepEqual(stored.filter((id) => id.startsWith('fg-') && id >= 'fg-0500'), [], '키를 바꾼 뒤 도착한 둘째 페이지는 합쳐지지 않았다');
    assert.equal(stored.filter((id) => id.startsWith('fg-')).length, 500, '키를 바꾸기 전에 합친 첫 페이지만 있다');
    assert.equal((await stateOf(A, K)).state.firestoreReadAfter, 'fg-0499', '저장이 거부된 페이지는 위치를 올리지 않았다');
    assert.deepEqual((await stateOf(A, OTHER1)).state, {}, '새 가족에는 이전 상태가 생기지 않았다');
    assert.equal((await adapter.family(K)).exists, false, '앞 가족은 이어받지 않았다');
    // 원래 키로 돌아오면 저장된 위치(둘째 페이지)부터 읽어 K의 기록이 빠짐없이 합쳐진다.
    await setKey(A, K);
    const mark = await fs.opCount();
    const again = await A.send('runMigration');
    assert.equal(again.result.status, 'uploading', JSON.stringify(again));
    await waitMigrationComplete(A, { syncKey: K });
    assert.equal(listedLogDocs(await opsBy(fs, A, mark)), 700, '둘째 페이지부터 700건을 읽었다');
    const expected = sortedIds([...famLogs, ...locals].map((l) => l.id));
    assert.deepEqual(await idsOf(A), expected, 'K의 기록이 빠짐없이 합쳐졌다');
    assert.deepEqual(await d1Live(adapter, K), expected);
  }

  // (b) 첫 페이지가 멈춰 있는 사이 키를 바꾼다: 앞 가족의 기록이 기기에도 새 가족에도 전혀 들어가지 않는다.
  {
    const K = hexKey('9b');
    const famLogs = seeds(1200, 'fh-');
    const locals = seeds(3, 'loc-b-', Date.now() - 3 * HOUR);
    await fs.seed(K, { members: ['legacy-B'], logs: famLogs });
    await B.send('bootApp');
    await B.send('saveLogs', { logs: locals });
    const gate = await fs.holdNext({ op: 'list', kind: 'logs', device: B.name }, { skip: 0 });
    const running = track(B.send('runMigration'));
    await gate.held;
    await setKey(B, OTHER2);
    await gate.release();
    assert.equal((await running).result.status, 'superseded');
    await settled();
    assert.deepEqual(await idsOf(B), sortedIds(locals.map((l) => l.id)), '앞 가족의 기록이 기기에 섞이지 않았다');
    assert.equal((await stateOf(B, K)).state.firestoreReadAfter, undefined, '거부된 페이지는 위치를 올리지 않았다(위치 없음)');
    // 새 가족과 동기화해도 앞 가족의 기록은 올라가지 않는다.
    await runnerSync(B, OTHER2);
    assert.ok(!(await d1Live(adapter, OTHER2)).some((id) => id.startsWith('fh-')), '새 가족의 D1에 앞 가족의 기록이 없다');
    assert.ok(!(await idsOf(B)).some((id) => id.startsWith('fh-')));
    // 원래 키로 돌아오면 처음부터 모두 읽어 합친다.
    await setKey(B, K);
    const mark = await fs.opCount();
    assert.equal((await B.send('runMigration')).result.status, 'uploading');
    await waitMigrationComplete(B, { syncKey: K });
    assert.equal(listedLogDocs(await opsBy(fs, B, mark)), 1200, '처음부터 1200건을 모두 읽었다');
    const expected = sortedIds([...famLogs, ...locals].map((l) => l.id));
    assert.deepEqual(await idsOf(B), expected, '누락 없이 합쳐졌다');
    assert.equal((await d1Live(adapter, K)).filter((id) => id.startsWith('fh-')).length, 1200);
  }
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('9a') }) }, B: { initialStorage: make179Storage({ syncKey: hexKey('9b') }) } } });

// ════════════════════════════════ 10. 직전 백업 복원 ════════════════════════════════
await scenario('10', '직전 백업 복원: 이전 뒤 추가·삭제·상대의 수정과 삭제·아기 정보 수정을 한 뒤 복원해도 추가와 상대의 수정이 남고 지운 기록은 어떤 id로도 되살아나지 않으며 아기 정보는 상대 값이고 Firestore를 다시 읽지 않는다', ['A', 'B'], async ({ adapter, fs, A, B }) => {
  const K = hexKey('10');
  const t = Date.now() - 6 * HOUR;
  const mk = (id, extra = {}) => ({ id, type: 'formula', amount: 100, timestamp: t + Math.floor(Math.random() * 1000), updatedAt: t, ...extra });
  const base = ['a_keep', 'a_del', 'a_mod', 'a_bdel'].map((id) => mk(id, id === 'a_del' ? { notes: 'DEL-MARKER' } : id === 'a_bdel' ? { notes: 'BDEL-MARKER' } : {}));
  const lost = mk('a_lost', { amount: 33 });
  await fs.seed(K, {
    members: ['legacy-C'], logs: base,
    profile: { name: '원래이름', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, sharedUpdatedAt: 1_000 },
  });
  await A.send('saveLogs', { logs: [...base, lost] });
  await A.send('bootApp');
  await B.send('bootApp');

  // 이전: A는 기기 기록 5건을 백업하고 올린다. B는 Firestore와 D1에서 받아 합친다.
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  const aDone = await waitMigrationComplete(A, { syncKey: K });
  assert.equal(aDone.backupMeta?.logCount, 5, 'A의 백업에는 이전 직전의 기록 5건이 있다');
  assert.equal((await B.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(B, { syncKey: K });
  await runnerSync(B, K);
  assert.ok((await idsOf(B)).includes('a_lost'), '전제: B도 모든 기록을 가졌다');

  // 이 기기(A): 기록 하나 추가, 백업에 있던 기록(a_del) 삭제. D1에 올린다.
  const added = (await A.send('addLog', { log: { type: 'formula', amount: 150, timestamp: Date.now() } })).saved;
  assert.equal((await A.send('deleteLog', { id: 'a_del' })).ok, true);
  await runnerSync(A, K);
  // 상대(B): 백업에 있던 기록 하나 수정(a_mod), 다른 하나 삭제(a_bdel, A는 아직 이 삭제 표식을 받지 않음), 아기 정보 수정
  const bMod = (await B.send('getLogs')).logs.find((l) => l.id === 'a_mod');
  assert.equal((await B.send('updateLog', { log: { ...bMod, amount: 999, updatedAt: Date.now() } })).ok, true);
  assert.equal((await B.send('deleteLog', { id: 'a_bdel' })).ok, true);
  await B.send('setProfile', { patch: { name: 'B가바꾼이름' } });
  await runnerSync(B, K);
  assert.ok((await adapter.logs(K)).deleted.includes('a_bdel'), '전제: 서버에 a_bdel 삭제 표식이 있다');
  assert.ok((await idsOf(A)).includes('a_bdel'), '전제: A는 아직 a_bdel 삭제 표식을 받지 않았다');

  // A의 기록이 하나 사라진 상황(a_lost)을 만든 뒤 복원한다.
  await A.send('saveLogs', { logs: (await A.send('getLogs')).logs.filter((l) => l.id !== 'a_lost') });
  const beforeIds = await idsOf(A);
  const beforeState = await stateOf(A, K);
  const markFs = await fs.opCount();
  const restored = await A.send('restorePreMigrationBackup');
  assert.deepEqual([restored.success, restored.added], [true, 1], '백업에서 되돌린 것은 사라진 기록 하나뿐이다(지운 기록은 되살리지 않았다)');
  const afterIds = await idsOf(A);
  assert.ok(beforeIds.every((id) => afterIds.includes(id)), '복원이 기록을 줄이지 않았다');
  assert.ok(!afterIds.includes('a_del'), '내가 지운 a_del이 되살아나지 않았다');
  const restoredLog = (await A.send('getLogs')).logs.find((l) => l.id === 'a_lost');
  assert.deepEqual([restoredLog.updatedAt, restoredLog.amount], [lost.updatedAt, 33], '새 id를 만들지 않고 백업 값 그대로 되돌렸다');
  const afterState = await stateOf(A, K);
  assert.deepEqual([afterState.state, afterState.transition, afterState.marker, afterState.backupMeta], [beforeState.state, beforeState.transition, beforeState.marker, beforeState.backupMeta], '이전 상태, 전환기 상태, 근거 표식, 백업 표지는 그대로다');
  assert.equal(afterState.complete, true);

  // 두 기기가 동기화를 마친다.
  await runnerSync(A, K);
  await runnerSync(B, K);
  await runnerSync(A, K);
  await runnerSync(B, K);
  const expected = sortedIds(['a_keep', 'a_mod', 'a_lost', added.id]);
  assert.deepEqual(await idsOf(A), expected, 'A');
  assert.deepEqual(await idsOf(B), expected, 'B');
  assert.deepEqual(await d1Live(adapter, K), expected, 'D1');
  for (const device of [A, B]) {
    const logs = (await device.send('getLogs')).logs;
    assert.ok(!logs.some((l) => /DEL-MARKER|BDEL-MARKER/.test(JSON.stringify(l))), `${device.name}: 지운 기록이 어떤 id로도 되살아나지 않았다`);
    assert.equal(logs.find((l) => l.id === 'a_mod').amount, 999, `${device.name}: 상대의 수정이 남았다`);
    assert.equal((await device.send('getProfile')).profile.name, 'B가바꾼이름', `${device.name}: 아기 정보는 상대 값이다`);
  }
  const rows = (await adapter.logs(K)).rows.filter((r) => r.deletedAt === null);
  assert.ok(!rows.some((r) => /DEL-MARKER|BDEL-MARKER/.test(r.raw)), 'D1에도 지운 기록이 없다');
  // Firestore를 다시 읽지 않았다.
  const stats = (await fs.stats(markFs)).byDevice;
  assert.equal(stats[A.name], undefined, 'A는 복원 뒤 Firestore에 요청하지 않았다');
  assert.equal(stats[B.name], undefined, 'B도 요청하지 않았다');
  assert.equal((await stateOf(A, K)).hasBackupValue, true);
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('10') }) }, B: { initialStorage: make179Storage({ syncKey: hexKey('10') }) } } });

// ════════════════════════════════ 11. 전환기 중 복원과 가져오기 ════════════════════════════════
await scenario('11', '전환기 중 복원과 가져오기: 데이터 가져오기와 로컬 백업 복원 뒤에도 이전 상태와 전환기 상태가 그대로이고 다음 전환기 읽기가 전체 읽기로 바뀌지 않는다', ['A'], async ({ adapter, fs, A }) => {
  const K = hexKey('11');
  const now = Date.now();
  const famLogs = seeds(200, 'ha-', now - 5 * HOUR, { updatedAt: now - 2 * HOUR });
  // 1.7.9의 lastChangedAt은 가장 나중 쓰기의 시각이라 기록의 updatedAt보다 새롭다.
  await fs.seed(K, { members: ['legacy-B'], logs: famLogs, updatedAt: now - 2 * HOUR, family: { lastChangedAt: now - HOUR } });
  await A.send('bootApp');
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(A, { syncKey: K });
  const prepared = await stateOf(A, K);
  assert.equal(prepared.state.mergeSource, 'ok');
  assert.equal(typeof prepared.transition.seenFamilyChangedAt, 'number', '전제: 전환기가 시작됐다');
  const rawKeys = [`@baby_cf_migration_v1:${K}`, `@baby_cf_transition_v1:${K}`, '@baby_cf_legacy_key_v1', '@baby_pre_cloudflare_backup_meta_v1'];
  const rawBefore = (await A.send('readStorage', { keys: rawKeys })).items;
  assert.ok(rawKeys.every((k) => rawBefore[k] !== null), '전제: 네 값이 모두 있다');
  const idleTick = await A.send('transitionTick', { force: true });
  assert.equal(idleTick.status, 'unchanged', JSON.stringify(idleTick));

  // 데이터 가져오기와 로컬 백업 복원
  const imported = await A.send('importData', { logs: [{ id: 'imp-1', type: 'formula', amount: 5, timestamp: now - 10 * HOUR, updatedAt: now - 10 * HOUR }] });
  assert.ok(imported.logCount >= 201, '가져온 기록이 더해졌다');
  assert.deepEqual((await A.send('backupLocalData')), { ok: true });
  assert.equal((await A.send('restoreLocalBackup')).success, true);
  const rawAfter = (await A.send('readStorage', { keys: rawKeys })).items;
  assert.deepEqual(rawAfter, rawBefore, '이전 상태, 전환기 상태, 근거 표식, 백업 표지가 가져오기와 복원에서 지워지거나 바뀌지 않았다');
  assert.equal((await stateOf(A, K)).complete, true);

  // 상대(1.7.9)가 기록을 하나 쓴다. 다음 전환기 읽기는 바뀐 문서만 읽는다.
  const late = { id: 'late-1', type: 'formula', amount: 8, timestamp: Date.now(), updatedAt: Date.now() };
  await fs.legacy179Write(K, { uid: 'legacy-B', logs: [late] });
  const mark = await fs.opCount();
  const tick = await A.send('transitionTick', { force: true });
  assert.equal(tick.status, 'merged', JSON.stringify(tick));
  const lists = (await opsBy(fs, A, mark)).filter((o) => o.op === 'list' && o.kind === 'logs');
  assert.equal(lists.length, 1, '목록 읽기 한 번');
  assert.equal(lists[0].returned, 1, `전체 읽기(200건)가 아니라 바뀐 문서 1건만 읽었다(읽은 ${lists[0].returned}건)`);
  assert.ok((await idsOf(A)).includes('late-1'));
  const next = await stateOf(A, K);
  assert.ok(next.transition.seenFamilyChangedAt > prepared.transition.seenFamilyChangedAt, '커서가 앞으로 갔다');
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('11') }) } } });

// ════════════════════════════════ 12. A→B 전달과 커서 ════════════════════════════════
await scenario('12', 'A→B 전달과 커서: 페이지 읽기 도중 이미 읽은 문서의 수정과 B(1.7.9)의 기록·삭제·프로필 변경이 전환기 읽기로 A에 들어와 D1에 오르고, 프로필만 고친 뒤에는 가족 문서 외의 읽기가 반복되지 않으며, 저장이 실패하면 커서가 앞서가지 않는다', ['A'], async ({ adapter, fs, A }) => {
  const K = hexKey('12');
  const now = Date.now();
  const famLogs = seeds(1100, 'fi-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR });
  const sharedProfile = (name, stamp) => ({ name, birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, sharedUpdatedAt: stamp });
  await fs.seed(K, {
    members: ['legacy-B'], logs: famLogs, updatedAt: now - 3 * HOUR, family: { lastChangedAt: now - 2 * HOUR },
    profile: sharedProfile('원래이름', 5_000),
  });
  await A.send('bootApp');

  // A의 이전: 둘째 페이지 요청을 멈춘 사이, B가 이미 읽은 첫 페이지의 문서(fi-0010)를 고친다.
  const edited = { ...famLogs[10], amount: 777, updatedAt: Date.now() };
  const first = await fs.interleave({ op: 'list', kind: 'logs', device: A.name }, { skip: 1 }, {
    call: () => A.send('runMigration'),
    between: async () => {
      assert.equal((await stateOf(A, K)).state.firestoreReadAfter, 'fi-0499', '전제: 첫 페이지는 이미 읽었다');
      await fs.legacy179Write(K, { uid: 'legacy-B', logs: [edited] });
    },
  });
  assert.equal(first.result.status, 'uploading', JSON.stringify(first));
  await waitMigrationComplete(A, { syncKey: K });
  const getLog = async (id) => (await A.send('getLogs')).logs.find((l) => l.id === id);
  assert.equal((await getLog('fi-0010')).amount, 90, '전제: 이전은 고치기 전 내용으로 끝났다(이미 읽은 페이지)');
  const baseline = (await stateOf(A, K)).transition.seenFamilyChangedAt;

  // B가 기록 추가, 기록 삭제, 프로필 변경을 한다.
  await fs.legacy179Write(K, {
    uid: 'legacy-B', logs: [{ id: 'b-new', type: 'formula', amount: 12, timestamp: Date.now(), updatedAt: Date.now() }],
    deleteIds: ['fi-0020'], profile: sharedProfile('비이름', 9_000),
  });
  const tick1 = await A.send('transitionTick', { force: true });
  assert.equal(tick1.status, 'merged', JSON.stringify(tick1));
  assert.equal((await getLog('fi-0010')).amount, 777, '이미 읽은 페이지의 문서를 B가 고친 것이 첫 전환기 읽기에서 들어왔다');
  assert.ok(await getLog('b-new'), 'B의 새 기록');
  assert.equal(await getLog('fi-0020'), undefined, 'B가 삭제한 기록');
  assert.equal((await A.send('getProfile')).profile.name, '비이름', 'B의 프로필 변경');
  const afterTick1 = (await stateOf(A, K)).transition.seenFamilyChangedAt;
  assert.ok(afterTick1 > baseline, '커서는 처리한 가족 문서의 lastChangedAt으로 올랐다');
  assert.equal(afterTick1, tsOf((await fs.snapshot(K)).family.lastChangedAt), '커서 값이 가족 문서의 lastChangedAt이다');

  // A가 D1에 올린다.
  await runnerSync(A, K);
  const rows = Object.fromEntries((await adapter.logs(K)).rows.map((r) => [r.id, r]));
  assert.equal(JSON.parse(rows['fi-0010'].raw).amount, 777, 'D1에 B의 수정이 올랐다');
  assert.equal(rows['b-new'].deletedAt, null, 'D1에 B의 새 기록이 올랐다');
  assert.notEqual(rows['fi-0020'].deletedAt, null, 'D1에 B의 삭제가 삭제 표식으로 올랐다');
  assert.ok((await adapter.family(K)).sharedJson?.includes('비이름'), 'D1에 B의 프로필 변경이 올랐다');

  // B가 프로필만 고친 뒤에는 가족 문서 외의 읽기가 반복되지 않는다.
  await fs.legacy179Write(K, { uid: 'legacy-B', profile: sharedProfile('프로필만', 12_000) });
  assert.equal((await A.send('transitionTick', { force: true })).status, 'merged');
  assert.equal((await A.send('getProfile')).profile.name, '프로필만');
  for (let i = 0; i < 3; i += 1) {
    const mark = await fs.opCount();
    const idle = await A.send('transitionTick', { force: true });
    assert.equal(idle.status, 'unchanged', JSON.stringify(idle));
    const kinds = new Set((await opsBy(fs, A, mark)).map((o) => `${o.op}:${o.kind}`));
    assert.deepEqual([...kinds].sort(), ['get:family', 'get:members'], `${i + 1}번째 빈 읽기: 가족 문서와 회원 문서 확인뿐이다`);
  }

  // 저장이 실패하면 커서가 앞서가지 않는다: 합치지 못한 변경은 다음 읽기에서 다시 받는다.
  await fs.legacy179Write(K, { uid: 'legacy-B', logs: [{ id: 'b-late', type: 'formula', amount: 4, timestamp: Date.now(), updatedAt: Date.now() }] });
  const cursorBefore = (await stateOf(A, K)).transition.seenFamilyChangedAt;
  await A.send('injectStorageFault', { mode: 'reject', keys: ['@baby_logs'], times: 1 });
  const failedTick = await A.send('transitionTick', { force: true });
  assert.equal(failedTick.status, 'failed', JSON.stringify(failedTick));
  assert.equal((await stateOf(A, K)).transition.seenFamilyChangedAt, cursorBefore, '저장이 실패하면 커서를 올리지 않는다');
  assert.equal(await getLog('b-late'), undefined, '전제: b-late는 저장되지 않았다');
  await A.send('clearStorageFault');
  await harness_advance(A, fs, 31 * MINUTE);
  const retried = await A.send('transitionTick', { force: true });
  assert.equal(retried.status, 'merged', JSON.stringify(retried));
  assert.ok(await getLog('b-late'), '다음 읽기에서 실패했던 변경을 받았다');
  assert.ok((await stateOf(A, K)).transition.seenFamilyChangedAt > cursorBefore);
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('12') }) } } });

// ════════════════════════════════ 13. 전환기 종료 ════════════════════════════════
await scenario('13', '전환기 종료: 혼자일 때는 partnerSeenAt이 적히지 않고, 상대가 1.8.0으로 D1에 연결하면 partnerSeenAt이 적히며 업데이트 직전과 여유 시간 안의 1.7.9 기록을 받은 뒤 24시간에 끝나고, 30일이 지나도 끝난다', ['A', 'B', 'C'], async ({ harness, adapter, fs, A, B, C }) => {
  const K = hexKey('13');
  const now = Date.now();
  const mkLog = (id) => ({ id, type: 'formula', amount: 20, timestamp: Date.now(), updatedAt: Date.now() });
  await fs.seed(K, { members: ['legacy-B'], logs: seeds(20, 'ja-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }), family: { lastChangedAt: now - 2 * HOUR } });
  await A.send('bootApp');
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(A, { syncKey: K });
  const has = async (device, id) => (await device.send('getLogs')).logs.some((l) => l.id === id);

  // 혼자인 동안: 상대가 없으므로(자기 자신은 세지 않는다) partnerSeenAt이 적히지 않는다.
  const solo = await A.send('transitionTick', { force: true });
  assert.equal(solo.status, 'unchanged', JSON.stringify(solo));
  assert.equal((await stateOf(A, K)).transition.partnerSeenAt, undefined, '혼자서 전환기가 끝나지 않는다(otherMembers에 자기 자신을 세지 않는다)');

  // 상대가 업데이트 직전에 1.7.9로 기록을 쓰고, 1.8.0으로 옮겨 D1에 연결한다(아무것도 쓰지 않는다).
  await fs.legacy179Write(K, { uid: 'legacy-B', logs: [mkLog('last-179')] });
  await B.send('bootApp');
  const joined = await B.send('join', { key: K, allowFamilyCreation: false, createBackup: false });
  assert.equal(joined.outcome, 'joined', JSON.stringify(joined));
  assert.equal((await adapter.family(K)).members.length, 2, '전제: D1 회원이 둘이다');
  const seenTick = await A.send('transitionTick', { force: true });
  assert.equal(seenTick.status, 'merged', `상대를 처음 본 읽기가 끝나지 않고 기록을 받는다: ${JSON.stringify(seenTick)}`);
  const seenAt = (await stateOf(A, K)).transition.partnerSeenAt;
  assert.equal(typeof seenAt, 'number', 'partnerSeenAt이 적혔다');
  assert.ok(await has(A, 'last-179'), '업데이트 직전에 1.7.9로 쓴 기록을 받았다');

  // 24시간 여유 안에 1.7.9로 쓴 기록도 받는다.
  await harness.advanceClocks(HOUR);
  await fs.legacy179Write(K, { uid: 'legacy-B', logs: [mkLog('grace-179')] });
  const graceTick = await A.send('transitionTick', { force: true });
  assert.equal(graceTick.status, 'merged', JSON.stringify(graceTick));
  assert.ok(await has(A, 'grace-179'), '여유 시간 안의 기록을 받았다');
  // 23시간째까지는 끝나지 않는다. 24시간이 지나면 끝난다.
  await harness.advanceClocks(22 * HOUR);
  const before = await A.send('transitionTick', { force: true });
  assert.notEqual(before.status, 'ended', `partnerSeenAt부터 23시간째는 끝나지 않는다: ${JSON.stringify(before)}`);
  await harness.advanceClocks(90 * MINUTE);
  const ended = await A.send('transitionTick', { force: true });
  assert.deepEqual([ended.status, ended.reason], ['ended', 'partner_grace'], JSON.stringify(ended));
  const mark = await fs.opCount();
  assert.equal((await A.send('transitionTick', { force: true })).status, 'ended');
  assert.equal((await opsBy(fs, A, mark)).length, 0, '끝난 뒤에는 Firestore를 읽지 않는다');
  await runnerSync(A, K);
  assert.deepEqual((await d1Live(adapter, K)).filter((id) => id.endsWith('-179')), ['grace-179', 'last-179'], '받은 1.7.9 기록이 D1에 올랐다');

  // 30일: 상대가 없는 가족은 30일이 지나면 무조건 끝난다.
  const K2 = hexKey('13-solo');
  await fs.seed(K2, { members: ['legacy-B'], logs: seeds(5, 'jb-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }), family: { lastChangedAt: now - 2 * HOUR } });
  await C.send('bootApp');
  assert.equal((await C.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(C, { syncKey: K2 });
  await harness.advanceClocks(29 * DAY);
  const day29 = await C.send('transitionTick', { force: true });
  assert.notEqual(day29.status, 'ended', `29일째는 끝나지 않는다: ${JSON.stringify(day29)}`);
  assert.equal((await stateOf(C, K2)).transition.partnerSeenAt, undefined);
  await harness.advanceClocks(2 * DAY);
  const day31 = await C.send('transitionTick', { force: true });
  assert.deepEqual([day31.status, day31.reason], ['ended', 'max_duration'], JSON.stringify(day31));
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('13') }) }, C: { initialStorage: make179Storage({ syncKey: hexKey('13-solo') }) } } });

// ════════════════════════════════ 14. 1.7.9 상대의 예약 ════════════════════════════════
await scenario('14', '1.7.9 상대의 예약: 선택 화면은 같은 예약으로 한 번만 뜨고 새 예약에는 다시 뜨며, 취소는 Firestore를 null로, 삭제에 따르기는 D1 예약을 만들되 취소·값 변경·재확인 실패(거부, 오류, 상한)에서는 보내지 않고, 거부와 가족 문서 없음은 삭제로 판정하지 않는다', ['A', 'C', 'D', 'H1', 'H2'], async ({ harness, adapter, fs, A, C, D, H1, H2 }) => {
  const M = (await A.send('migrationMessages')).messages;
  const promptsOf = async (device) => (await device.send('choiceLog')).legacyDeletion;
  const noticesOf = async (device, code) => (await device.send('choiceLog')).notices.filter((n) => n.code === code).length;
  const firestoreNow = async () => (await fs.clock({})).now;
  /** 1.7.9 상대(legacy-B)가 삭제를 예약한다. 값은 호출마다 달라야 같은 예약으로 오인되지 않는다. */
  let scheduleSeq = 0;
  const schedule = async (key) => {
    scheduleSeq += 1;
    const readyAt = (await firestoreNow()) + (2 + scheduleSeq) * HOUR + scheduleSeq * 1_000;
    return (await fs.legacy179Schedule(key, { uid: 'legacy-B', readyAt })).readyAt;
  };
  const answers = (device, list) => device.send('setChoiceAnswers', { legacyDeletion: list, replace: true });
  const waitPrompt = (device) => waitFor(async () => {
    const log = await device.send('choiceLog');
    return log.pending.length > 0 ? log : null;
  }, { label: `${device.name}의 보류된 선택 화면` });
  const tickA = () => A.send('transitionTick', { force: true });
  const d1Pending = async (key) => (await adapter.family(key)).pendingDeletionAt;
  const firestorePending = async (key) => (await fs.snapshot(key)).family.pendingDeletionAt;

  // ── A: 전환기(2.6.3) ──
  const K = hexKey('14');
  const now = Date.now();
  await fs.seed(K, { members: ['legacy-B'], logs: seeds(20, 'ka-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }), family: { lastChangedAt: now - 2 * HOUR } });
  await A.send('bootApp');
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(A, { syncKey: K });
  const familyPath = famPath(fs, K);
  await answers(A, ['later']);

  // (a) 예약이 생기면 선택 화면이 한 번 뜬다. 같은 예약으로 다시 뜨지 않는다.
  const T1 = await schedule(K);
  await tickA();
  let shown = await promptsOf(A);
  assert.equal(shown.length, 1, '선택 화면이 한 번 뜬다');
  assert.deepEqual([shown[0].context, shown[0].pendingDeletionAt, [...shown[0].options].sort()], ['transition', T1, ['cancelRequest', 'followDeletion', 'later']]);
  assert.equal((await stateOf(A, K)).state.promptedPendingDeletionAt, T1);
  await tickA();
  await tickA();
  assert.equal((await promptsOf(A)).length, 1, '같은 예약으로 다시 뜨지 않는다');
  assert.equal(await d1Pending(K), null, '"나중에"는 아무것도 하지 않는다');

  // (b) 취소되면 기록이 지워지고, 새 예약(다른 값)에는 다시 뜬다.
  await fs.legacy179Cancel(K, { uid: 'legacy-B' });
  await tickA();
  assert.equal((await stateOf(A, K)).state.promptedPendingDeletionAt, undefined, '값이 null로 돌아오면 물어본 값을 지운다');
  const T2 = await schedule(K);
  assert.notEqual(T2, T1);
  await tickA();
  shown = await promptsOf(A);
  assert.equal(shown.length, 2, '새 예약에는 다시 뜬다');
  assert.equal(shown[1].pendingDeletionAt, T2);

  // (c) "요청 취소": Firestore 값을 null로 만든다(허용된 쓰기).
  await fs.legacy179Cancel(K, { uid: 'legacy-B' });
  await tickA();
  const T3 = await schedule(K);
  await answers(A, ['cancelRequest']);
  await tickA();
  assert.equal(await firestorePending(K), null, '요청 취소가 Firestore의 예약을 null로 만들었다');
  const cancelWrites = (await fs.writes({ actor: 'app' })).filter((w) => w.path === familyPath);
  assert.ok(cancelWrites.length >= 1 && cancelWrites.every((w) => w.fields.join() === 'pendingDeletionAt' && w.data.pendingDeletionAt === null && w.allowed), '앱의 가족 문서 쓰기는 pendingDeletionAt: null뿐이다');
  assert.equal((await promptsOf(A)).at(-1).pendingDeletionAt, T3);
  assert.equal(await d1Pending(K), null);
  await tickA();

  // (d) "삭제에 따르기": D1 삭제 예약이 만들어진다.
  const T4 = await schedule(K);
  await answers(A, ['followDeletion']);
  await tickA();
  assert.notEqual(await d1Pending(K), null, '삭제에 따르면 D1 예약이 생긴다');
  assert.equal((await stateOf(A, K)).state.promptedPendingDeletionAt, T4);
  assert.equal(await noticesOf(A, 'deletionScheduled'), 1);
  assert.equal(await syncKeyOf(A), K, '앱이 스스로 연결을 끊지 않는다');
  assert.equal((await A.send('cancelDeletion')).success, true);
  assert.equal(await d1Pending(K), null, '(정리) D1 예약을 취소했다');
  await fs.legacy179Cancel(K, { uid: 'legacy-B' });
  await tickA();

  // (e) 선택 화면이 떠 있는 사이 B가 예약을 취소하거나 새 값으로 다시 예약한 뒤 "삭제에 따르기"를 누르면 D1 예약이 생기지 않는다.
  await schedule(K);
  await answers(A, [{ hold: true }]);
  let running = track(tickA());
  await waitPrompt(A);
  await fs.legacy179Cancel(K, { uid: 'legacy-B' });
  await A.send('answerChoice', { kind: 'legacyDeletion', answer: 'followDeletion' });
  await running;
  assert.equal(await d1Pending(K), null, '취소 경쟁: D1 예약이 생기지 않았다');
  assert.equal(await noticesOf(A, 'deletionCancelledElsewhere'), 1, '"다른 기기에서 삭제 요청을 취소했습니다"');
  const T6 = await schedule(K);
  await answers(A, [{ hold: true }, 'later']);
  const promptsBefore = (await promptsOf(A)).length;
  running = track(tickA());
  await waitPrompt(A);
  await fs.legacy179Cancel(K, { uid: 'legacy-B' });
  const T7 = await schedule(K);
  assert.notEqual(T7, T6);
  await A.send('answerChoice', { kind: 'legacyDeletion', answer: 'followDeletion' });
  await running;
  assert.equal(await d1Pending(K), null, '값이 바뀐 경쟁: D1 예약이 생기지 않았다');
  const reshown = (await promptsOf(A)).slice(promptsBefore);
  assert.deepEqual(reshown.map((p) => p.pendingDeletionAt), [T6, T7], '새 값으로 선택 화면을 다시 보여 준다');
  await fs.legacy179Cancel(K, { uid: 'legacy-B' });
  await tickA();

  // (f) 다시 읽기가 거부되거나 오류이거나 상한에 걸려도 D1 예약이 생기지 않는다.
  const familyGet = { op: 'get', kind: 'family', device: A.name };
  for (const [label, arm] of [
    ['거부', () => fs.fail({ match: familyGet, code: 'permission-denied' })],
    ['오류', () => fs.fail({ match: familyGet, code: 'unavailable' })],
    ['상한 초과(끝나지 않는 호출)', () => fs.hang(familyGet)],
  ]) {
    await schedule(K);
    await answers(A, [{ hold: true }]);
    const noticesBefore = await noticesOf(A, 'deletionRecheckFailed');
    running = track(tickA());
    await waitPrompt(A);
    await arm();
    await A.send('answerChoice', { kind: 'legacyDeletion', answer: 'followDeletion' });
    await running;
    assert.equal(await d1Pending(K), null, `재확인 ${label}: D1 예약이 생기지 않았다`);
    assert.equal(await noticesOf(A, 'deletionRecheckFailed'), noticesBefore + 1, `재확인 ${label}: "삭제 요청을 확인하지 못했습니다" 안내`);
    assert.ok((await A.send('choiceLog')).notices.some((n) => n.code === 'deletionRecheckFailed' && n.message === M.deletionRecheckFailed), '안내 문구');
    await fs.clearFaults();
    await fs.legacy179Cancel(K, { uid: 'legacy-B' });
    await tickA();
  }
  assert.ok((await fs.stats()).terminates >= 1, '상한에 걸린 호출은 Firestore를 닫았다');

  // (g) 거부와 가족 문서 없음은 삭제로 판정하지 않는다.
  const promptCount = (await promptsOf(A)).length;
  await fs.fail({ match: familyGet, code: 'permission-denied' });
  const denied = await tickA();
  assert.deepEqual([denied.status, denied.reason], ['failed', 'denied'], JSON.stringify(denied));
  await fs.clearFaults();
  await harness.advanceClocks(13 * HOUR);
  const saved = await fs.getDoc(familyPath);
  await fs.removeDoc(familyPath);
  const absent = await tickA();
  assert.deepEqual([absent.status, absent.reason], ['failed', 'absent'], JSON.stringify(absent));
  await fs.putDoc(familyPath, saved);
  await harness.advanceClocks(13 * HOUR);
  assert.equal(await d1Pending(K), null, '거부와 가족 문서 없음은 D1 예약을 만들지 않았다');
  assert.equal((await promptsOf(A)).length, promptCount, '삭제 안내도 띄우지 않았다');
  assert.equal(await syncKeyOf(A), K, '연결이 유지된다');
  assert.equal((await A.send('runnerEvents')).events.filter((e) => e.type === 'disconnected').length, 0, '연결 해제가 없었다');
  assert.equal((await adapter.family(K)).exists, true);
  assert.equal((await tickA()).status, 'unchanged', '문서가 돌아오면 다시 정상이다');

  // ── C, D: D1이 exists인 가족의 안내 화면(2.4-6)에도 같은 규칙 ──
  const KC = hexKey('14c');
  const KD = hexKey('14d');
  await H1.send('bootApp');
  await H2.send('bootApp');
  await newKeyFamily(H1, KC);
  await newKeyFamily(H2, KD);
  for (const [key, tag] of [[KC, 'kc'], [KD, 'kd']]) {
    await fs.seed(key, { members: ['legacy-B'], logs: seeds(10, `${tag}-`, now - 5 * HOUR, { updatedAt: now - 3 * HOUR }), family: { lastChangedAt: now - 2 * HOUR } });
  }
  await C.send('bootApp');
  await D.send('bootApp');

  // C: 취소 경쟁
  await schedule(KC);
  await answers(C, [{ hold: true }]);
  const runC = track(C.send('runMigration'));
  await waitPrompt(C);
  assert.equal((await C.send('choiceLog')).legacyDeletion[0].context, 'exists', '2.4-6의 안내 화면');
  await fs.legacy179Cancel(KC, { uid: 'legacy-B' });
  await C.send('answerChoice', { kind: 'legacyDeletion', answer: 'followDeletion' });
  await runC;
  assert.equal(await d1Pending(KC), null, 'exists 화면의 취소 경쟁: D1 예약이 생기지 않았다');
  assert.equal(await noticesOf(C, 'deletionCancelledElsewhere'), 1);

  // D: 재확인 실패는 보내지 않고, 다음 시도에서 삭제에 따르면 D1 예약이 생긴다.
  const VD = await schedule(KD);
  await answers(D, [{ hold: true }]);
  const runD = track(D.send('runMigration'));
  await waitPrompt(D);
  await fs.fail({ match: { op: 'get', kind: 'family', device: D.name }, code: 'unavailable' });
  await D.send('answerChoice', { kind: 'legacyDeletion', answer: 'followDeletion' });
  await runD;
  assert.equal(await d1Pending(KD), null, 'exists 화면의 재확인 실패: D1 예약이 생기지 않았다');
  assert.equal(await noticesOf(D, 'deletionRecheckFailed'), 1);
  await fs.clearFaults();
  await harness.advanceClocks(13 * HOUR);
  const VD2 = (await fs.snapshot(KD)).family.pendingDeletionAt.__ts;
  assert.equal(VD2, VD, '전제: 예약은 그대로다');
  await answers(D, ['followDeletion']);
  await D.send('runMigration');
  assert.notEqual(await d1Pending(KD), null, 'exists 화면에서 삭제에 따르면 D1 예약이 생긴다');
  assert.equal((await stateOf(D, KD)).state.promptedPendingDeletionAt, VD);
  assert.equal(typeof (await stateOf(D, KD)).state.legacyDeletionNoticeAt, 'number');
  assert.equal(await syncKeyOf(D), KD, '연결이 유지된다');
}, { deviceOptions: Object.fromEntries([['A', '14'], ['C', '14c'], ['D', '14d']].map(([n, tag]) => [n, { initialStorage: make179Storage({ syncKey: hexKey(tag) }) }])) });

// ════════════════════════════════ 15. 하루 읽기 총량 ════════════════════════════════
/** 미국 서부(태평양) 시간의 다음 자정(밀리초). 앱 코드를 쓰지 않고 Intl로 따로 구합니다. */
const nextPacificMidnight = (ms) => {
  const day = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  const today = day(ms);
  let lo = ms;
  let hi = ms + 26 * HOUR;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (day(mid) === today) lo = mid; else hi = mid;
  }
  return hi;
};

await scenario('15', '하루 읽기 총량: 정상 이전 1회와 하루 동안 저장 100회·90초 주기 동기화·5분 주기 전환기 읽기, 하루 종일 실패(가벼운·무거운·할당량 소진), 1.8.0 신규 가족과 합류 기기(재시작 포함)의 Firestore 읽기 집계가 4.1 표의 상한 이하다', ['A', 'F1', 'F2', 'Q', 'N1', 'N2', 'S', 'P'], async ({ harness, adapter, fs, A, F1, F2, Q, N1, N2, S, P }) => {
  const soft = [];
  /** 표의 상한과 비교하는 판정은 모아서 한꺼번에 보고합니다(앞 판정이 실패해도 나머지를 끝까지 확인하기 위해). */
  const within = (label, actual, limit) => { if (!(actual <= limit)) soft.push(`${label}: ${actual} > 상한 ${limit}`); };
  const readsOf = (stats, device) => stats.byDevice[device.name]?.reads ?? 0;
    const advanceDevice = (device, ms) => harness.advanceClocks(ms, { only: [device.name] });
  const nowOf = async (device) => (await device.send('getClock')).now;
  const N = 3000;
  const now = Date.now();

  // (a) 정상 이전 1회(N=3,000): 첫 이전 N + 페이지 수 + 6
  const K = hexKey('15');
  const logs = seeds(N, 'la-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR });
  await fs.seed(K, { members: ['legacy-B'], logs, updatedAt: now - 3 * HOUR, family: { lastChangedAt: now - 2 * HOUR } });
  await A.send('bootApp');
  const markMigration = await fs.opCount();
  assert.equal((await A.send('runMigration')).result.status, 'uploading');
  await waitMigrationComplete(A, { syncKey: K, timeoutMs: 120_000 });
  const migrationStats = await fs.stats(markMigration);
  console.log(`  [15] 첫 이전 읽기: 문서 ${migrationStats.byDevice[A.name].docReads} + 규칙 ${migrationStats.byDevice[A.name].ruleReads} = ${readsOf(migrationStats, A)}`);
  // 표의 식은 근삿값입니다(마지막 빈 페이지와 프로필 문서 읽기를 어림함). 실제 3,014 대 3,012처럼 1% 안의 차이는 식의 어림으로 보고,
  // 페이지를 다시 읽는 따위의 회귀(두 배)는 잡히도록 1% 여유를 둡니다.
  within('첫 이전(N + 페이지 수 + 6, 어림 1% 여유)', readsOf(migrationStats, A), Math.ceil((N + Math.ceil(N / 500) + 6) * 1.01));
  assert.equal((await d1Live(adapter, K)).length, N);

  // (b) 하루: 저장 100회, 90초 주기 동기화, 5분 주기 전환기 읽기(전환기 읽기는 평소 동기화 뒤에 5분에 한 번 이하).
  // 3,000건 가족의 D1 동기화 한 번이 0.2초라 960번을 모두 돌리면 2분이 넘습니다. 처음 2시간(80번)은 90초마다,
  // 그 뒤는 저장한 때와 9분마다 동기화합니다. 동기화는 Firestore를 부르지 않으므로 Firestore 집계에는 영향이 없고,
  // 전환기 읽기는 90초마다 한 번씩 요청해(5분 간격 제한에 걸리는 것은 흉내 내지 않고 실제 제한이 거릅니다) 하루 전체를 센다.
  const markDay = await fs.opCount();
  let ticks = 0;
  let syncs = 0;
  for (let i = 0; i < 960; i += 1) {
    await advanceDevice(A, 90_000);
    await fs.clock({ advance: 90_000 });
    const saving = i % 10 === 0;
    if (saving) await A.send('addLog', { log: { type: 'formula', amount: 100, timestamp: Date.now() } });
    if (i < 80 || saving || i % 6 === 0) {
      const round = await A.send('runnerRequest', { request: { syncKey: K }, timeoutMs: 30_000 }, { timeoutMs: 90_000 });
      assert.equal(round.success, true, `${i}번째 동기화: ${round.error}`);
      syncs += 1;
    }
    const tick = await A.send('transitionTick');
    if (tick.status !== 'throttled') ticks += 1;
  }
  const dayStats = await fs.stats(markDay);
  const saves = (await A.send('getLogs')).logs.filter((l) => !l.id.startsWith('la-')).length;
  console.log(`  [15] 하루(저장 ${saves}회, 동기화 ${syncs}회, 전환기 읽기 ${ticks}회): 읽기 ${readsOf(dayStats, A)} (문서 ${dayStats.byDevice[A.name].docReads} + 규칙 ${dayStats.byDevice[A.name].ruleReads})`);
  assert.equal(saves, 96, '전제: 저장 96회(10회에 한 번)');
  assert.ok(ticks >= 200 && ticks <= 288, `전환기 읽기는 5분에 한 번 이하다(${ticks}회)`);
  assert.equal((await fs.writes({ actor: 'app', from: markDay })).length, 0, '하루 동안 앱의 Firestore 쓰기가 없다');
  within('전환기 가족 문서(하루 576)', readsOf(dayStats, A), 576);
  assert.equal((await stateOf(A, K)).transition.partnerSeenAt, undefined);

  // (c) Firestore가 하루 종일 실패하는 경우(D1 가족 없음, 근거 있음)
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failDay = async (device, key, label) => {
    const attempts = [];
    const mark = await fs.opCount();
    // 앱은 동기화(관문)와 재시도 타이머가 ensure를 부릅니다. 10분 간격으로 하루(144번) 부르는 것으로 흉내 냅니다.
    for (let i = 0; i < 144; i += 1) {
      await advanceDevice(device, 10 * MINUTE);
      await fs.clock({ advance: 10 * MINUTE });
      const m = await fs.opCount();
      await device.send('runMigration');
      const ops = await opsBy(fs, device, m);
      if (ops.length > 0) attempts.push(ops.reduce((n, o) => n + o.docReads + o.ruleReads, 0));
    }
    await settle(3_000);
    const total = (await fs.stats(mark)).byDevice[device.name]?.reads ?? 0;
    console.log(`  [15] ${label}: 시도 ${attempts.length}회, 읽기 ${total}`);
    return { attempts, total };
  };
  // 가벼운 실패: logs 읽기 전의 실패(가족 문서 읽기 오류)
  await fs.seed(hexKey('15f1'), { members: ['legacy-B'], logs: seeds(N, 'lb-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }) });
  await F1.send('bootApp');
  await fs.fail({ match: { op: 'get', kind: 'family', device: F1.name }, code: 'unavailable', times: 'always' });
  const light = await failDay(F1, hexKey('15f1'), '가벼운 실패 하루');
  assert.ok(light.attempts.length >= 2, '전제: 실패가 간격을 두고 되풀이됐다');
  within('가벼운 실패 시도 횟수(첫날 최대 7회)', light.attempts.length, 7);
  within('가벼운 실패 회당 읽기(6)', Math.max(...light.attempts), 6);
  within('가벼운 실패 하루 합계(7 × 6)', light.total, 42);
  await fs.clearFaults();
  // 무거운 실패: logs 읽기를 시작한 뒤의 실패
  await fs.seed(hexKey('15f2'), { members: ['legacy-B'], logs: seeds(N, 'lc-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }) });
  await F2.send('bootApp');
  // 페이지 응답이 상한(1.5초)보다 늦게 와서 읽은 페이지를 버리는 실패다(서버는 읽고 클라이언트는 버림 = 읽기 비용만 든다).
  await fs.delay({ op: 'list', kind: 'logs', device: F2.name }, 2_500, { times: 'always' });
  const heavy = await failDay(F2, hexKey('15f2'), '무거운 실패 하루');
  assert.equal(heavy.attempts.length, 5, '무거운 실패는 1시간부터 두 배씩이라 첫날 5회(0, 1, 3, 7, 15시간째)');
  assert.ok(heavy.total > 5 * 50, `전제: 버려진 페이지의 읽기 비용이 집계됐다(${heavy.total})`);
  within('무거운 실패 하루 합계(5 × (500 + 6))', heavy.total, 5 * 506);
  await fs.clearFaults();
  // 할당량 소진: 태평양 시간 자정 뒤로 미룬다.
  await fs.seed(hexKey('15q'), { members: ['legacy-B'], logs: seeds(N, 'ld-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }) });
  await Q.send('bootApp');
  await fs.exhaust({ device: Q.name });
  assert.equal((await Q.send('runMigration')).result.status, 'firestore_failed');
  const expectedMidnight = nextPacificMidnight(await nowOf(Q)) + MINUTE;
  assert.equal((await stateOf(Q, hexKey('15q'))).state.nextFirestoreAttemptAt, expectedMidnight, '다음 시도는 태평양 시간 다음 자정 + 1분이다');
  await fs.clearFaults();
  await fs.exhaust({ device: Q.name });
  const quota = await failDay(Q, hexKey('15q'), '할당량 소진 하루');
  assert.ok(quota.attempts.length >= 1 && quota.attempts.length <= 2, `하루에 많아야 두 번(자정 전후): ${quota.attempts.length}회`);
  within('할당량 소진 회당 읽기', Math.max(0, ...quota.attempts), 6);
  await fs.clearFaults();

  // (d) 1.8.0 신규 가족과 그 가족에 합류한 기기: Firestore 요청 0회(재시작을 여러 번 해도)
  const KN = hexKey('15n');
  const noFirestore = async (device, label) => {
    const stats = await fs.stats();
    assert.equal(stats.byDevice[device.name], undefined, `${label}: Firestore 요청이 없다`);
    const loads = await device.send('moduleLoads');
    assert.deepEqual([loads.firestoreImportLoaded, loads.firebaseLoaded], [false, false], `${label}: firestoreImport.ts와 firebase.ts를 불러오지 않았다`);
  };
  await N1.send('bootApp');
  await N1.send('saveLogs', { logs: seeds(3, 'n1-', now - 3 * HOUR) });
  await newKeyFamily(N1, KN);
  await noFirestore(N1, '새 가족을 만든 기기');
  // 새로 설치한 기기가 합류한다. 재시작을 여러 번 해도 0회다.
  assert.deepEqual((await N2.send('bootApp')).marker.keys, []);
  assert.equal((await N2.send('join', { key: KN, allowFamilyCreation: false, createBackup: false })).outcome, 'joined');
  // 혼자 쓰던 기기가 처음 실행 뒤 합류한다(옛 장부에 같은 키가 있어도 근거가 아니다).
  assert.deepEqual((await S.send('bootApp')).marker.keys, [], '혼자 쓰던 기기도 표식은 적는다(빈 배열)');
  await S.send('saveLogs', { logs: seeds(3, 'solo-', now - 3 * HOUR) });
  await S.send('writeStorage', { key: '@baby_sync_ledger_v1', json: { familyKey: KN, cursorMillis: 0, lastFullReadAt: 0, uploaded: {}, tombstoned: [] } });
  assert.equal((await S.send('join', { key: KN, allowFamilyCreation: false, createBackup: false })).outcome, 'joined');
  for (let round = 0; round < 3; round += 1) {
    for (const device of [N1, N2, S]) {
      await device.restart();
      const booted = await device.send('bootApp');
      assert.deepEqual(booted.marker.keys, [], `${device.name}: 재시작해도 표식을 다시 계산하지 않는다(합류한 키가 근거가 되지 않는다)`);
      assert.equal((await device.send('runMigration', { syncKey: KN })).result.status, 'complete');
      await runnerSync(device, KN);
      await device.send('transitionTick', { force: true });
    }
  }
  for (const [device, label] of [[N1, '새 가족을 만든 기기'], [N2, '새로 설치한 합류 기기'], [S, '혼자 쓰던 합류 기기']]) await noFirestore(device, label);
  // 키만 직접 정해진 기기(표식은 빈 배열)가 D1이 exists인 키로 이전을 돌려도 읽지 않는다(근거 판단).
  await P.send('bootApp');
  await P.send('setProfile', { patch: { syncKey: KN } });
  const viaProfile = await P.send('runMigration');
  assert.equal(viaProfile.result.status, 'uploading', JSON.stringify(viaProfile));
  await waitMigrationComplete(P, { syncKey: KN });
  assert.equal((await stateOf(P, KN)).state.mergeSource, 'skipped');
  await noFirestore(P, '근거 없는 exists 키');

  assert.equal(soft.length, 0, `4.1 표의 상한을 넘은 항목:\n  - ${soft.join('\n  - ')}`);
}, { deviceOptions: Object.fromEntries([['A', '15'], ['F1', '15f1'], ['F2', '15f2'], ['Q', '15q']].map(([n, tag]) => [n, { initialStorage: make179Storage({ syncKey: hexKey(tag) }) }])) });

// ════════════════════════════════ 16. 상한과 직렬화 ════════════════════════════════
await scenario('16', '상한과 직렬화: 끝나지 않는 Firestore 호출은 상한 뒤 terminate되고 다음 시도는 새 인스턴스로 돌며 그 사이 평소 동기화는 계속 돌고, 같은 키의 이전은 한 번만 돌며 이전·합류·전환기 읽기가 겹쳐도 한 번에 하나만 돈다', ['A', 'B', 'H'], async ({ harness, adapter, fs, A, B, H }) => {
  const now = Date.now();
  // (a) 상한과 새 인스턴스, 그 사이의 평소 동기화
  {
    const K = hexKey('16a');
    await fs.seed(K, { members: ['legacy-B'], logs: seeds(40, 'na-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }) });
    await H.send('bootApp');
    await newKeyFamily(H, K);
    await A.send('bootApp');
    await A.send('saveLogs', { logs: [{ id: 'a-own', type: 'formula', amount: 9, timestamp: now - HOUR, updatedAt: now - HOUR }] });
    await fs.hang({ op: 'get', kind: 'family', device: A.name });
    const mark = await fs.opCount();
    const started = Date.now();
    let migrationDone = false;
    const running = track(A.send('runMigration').then((r) => { migrationDone = true; return r; }));
    await waitFor(async () => (await fs.ops(mark)).some((o) => o.fault === 'hang'), { label: 'Firestore 호출이 끝나지 않는 상태' });
    // 이전이 멈춰 있는 사이 평소 동기화는 D1로 계속 돈다(D1 가족이 있고 근거가 있어도 관문은 exists라 proceed).
    const round = await A.send('runnerRequest', { request: { syncKey: K }, timeoutMs: 20_000 });
    assert.equal(round.success, true, `이전이 멈춘 사이 평소 동기화가 돈다: ${round.error ?? JSON.stringify(round)}`);
    assert.equal(migrationDone, false, '전제: 동기화가 끝났을 때 이전은 아직 상한을 기다리는 중이다');
    assert.ok((await d1Live(adapter, K)).includes('a-own'), '평소 동기화가 이 기기의 기록을 올렸다');
    const result = await running;
    // D1이 exists라 병합 없이 7단계(평소 동기화 업로드)로 가고, 실패 간격이 적용된다(2.4-6 결정표).
    assert.equal(result.result.status, 'uploading', JSON.stringify(result));
    assert.equal(result.state.failureCount, 1, '상한 초과는 Firestore 실패로 적혔다');
    assert.ok(Date.now() - started >= 1_400, '상한(스케일 1.5초)까지 기다렸다');
    const stats = await fs.stats(mark);
    assert.equal(stats.terminates, 1, '상한에 걸리자 terminate가 불렸다');
    // 다음 시도는 새 인스턴스로 돈다.
    await harness.advanceClocks(31 * MINUTE);
    assert.equal((await A.send('runMigration')).result.status, 'uploading');
    await waitMigrationComplete(A, { syncKey: K });
    const instances = (await fs.instances()).filter((i) => i.device === A.name);
    assert.ok(instances.length >= 2, `인스턴스가 다시 만들어졌다: ${JSON.stringify(instances)}`);
    assert.equal(instances[0].terminated, true, '처음 인스턴스는 닫혔다');
    assert.equal(instances.at(-1).terminated, false, '다음 시도는 새 인스턴스로 동작한다');
    assert.equal((await stateOf(A, K)).state.mergeSource, 'ok');
  }

  // (b) 같은 키의 이전은 한 번만 돈다(Promise 재사용)
  const K = hexKey('16b');
  await fs.seed(K, { members: ['legacy-B'], logs: seeds(600, 'nb-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR }), family: { lastChangedAt: now - 2 * HOUR } });
  await B.send('bootApp');
  await fs.delay({ device: B.name }, 120, { times: 'always' });
  const mark = await fs.opCount();
  const [first, second] = await Promise.all([B.send('runMigration'), B.send('runMigration')]);
  assert.deepEqual([first.result.status, second.result.status], ['uploading', 'uploading'], JSON.stringify([first, second]));
  const ops = await opsBy(fs, B, mark);
  assert.equal(ops.filter((o) => o.op === 'get' && o.kind === 'family').length, 1, '가족 문서를 한 번만 읽었다(중복 이전 없음)');
  assert.equal(listedLogDocs(ops), 600, '기록을 한 번만 읽었다');
  await waitMigrationComplete(B, { syncKey: K });

  // 전환기 읽기와 1.7.9 가족 합류가 겹쳐 요청돼도 Firestore 호출은 한 번에 하나만 돈다.
  // (이미 연결된 기기는 다른 가족에 합류할 수 없으므로 같은 키로 합류 함수를 부릅니다. 잠금 확인이 목적입니다.)
  await fs.legacy179Write(K, { uid: 'legacy-B', logs: [{ id: 'late-1', type: 'formula', amount: 1, timestamp: Date.now(), updatedAt: Date.now() }], profile: { name: '변경', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, sharedUpdatedAt: 9_000 } });
  const markOverlap = await fs.opCount();
  const tick = track(B.send('transitionTick', { force: true }));
  const join = track(B.send('legacyJoin', { key: K, createBackup: false, waitMigration: true }, { timeoutMs: 120_000 }));
  const [tickResult, joinResult] = await Promise.all([tick, join]);
  assert.equal(tickResult.status, 'merged', JSON.stringify(tickResult));
  assert.equal(joinResult.outcome, 'joined', JSON.stringify(joinResult));
  const overlapOps = await opsBy(fs, B, markOverlap);
  const kinds = new Set(overlapOps.map((o) => o.kind));
  assert.ok(kinds.has('logs') && kinds.has('profile'), '전제: 전환기 읽기가 기록과 프로필까지 읽어 합류의 호출과 겹칠 시간이 있었다');
  assert.equal(overlapOps.length, 6, `전제: 전환기 읽기 4건(회원, 가족, 기록, 프로필) + 합류 2건(회원, 가족), 호출마다 120ms 지연: ${overlapOps.length}건`);
  assert.equal((await fs.stats(markOverlap)).byDevice[B.name].maxInflight, 1, 'Firestore 호출이 겹치지 않고 한 번에 하나씩 돌았다');
  assert.ok((await idsOf(B)).includes('late-1'), '전환기 읽기가 결과를 합쳤다');
  assert.equal(await syncKeyOf(B), K, '연결이 유지된다');
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('16a') }) }, B: { initialStorage: make179Storage({ syncKey: hexKey('16b') }) } } });

// ════════════════════════════════ 17. Firestore 오류와 D1 없음 ════════════════════════════════
await scenario('17', 'Firestore 오류와 D1 없음: 연결을 유지하고 러너는 migrationPending을 돌려주며 D1 동기화 요청을 보내지 않고, Firestore가 살아나면 이어받으며 그 직후 7단계 요청은 관문에 막히지 않고, D1 네트워크 실패에는 Firestore 실패 간격을 적용하지 않는다', ['A', 'B'], async ({ harness, adapter, fs, A, B }) => {
  const now = Date.now();
  const migrationPendingEvents = async (device) => (await device.send('runnerEvents')).events.filter((e) => e.type === 'migrationPending').length;

  // (a) Firestore 오류 + D1 가족 없음
  {
    const K = hexKey('17a');
    const famLogs = seeds(400, 'oa-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR });
    const locals = seeds(3, 'loc-a-', now - 3 * HOUR);
    await fs.seed(K, { members: ['legacy-B'], logs: famLogs });
    await A.send('bootApp');
    await A.send('saveLogs', { logs: locals });
    await fs.fail({ match: { device: A.name }, code: 'unavailable', times: 'always' });
    const failed = await A.send('runMigration');
    assert.equal(failed.result.status, 'firestore_failed', JSON.stringify(failed));
    assert.equal(await syncKeyOf(A), K, '연결을 유지한다');
    assert.equal((await adapter.family(K)).exists, false);

    // 러너는 migrationPending을 돌려주고 D1에 동기화 요청을 보내지 않는다(오류 표시도 없다).
    const markD1 = await adapter.requestCount();
    const markFs = await fs.opCount();
    const round = await A.send('runnerRequest', { request: { syncKey: K }, timeoutMs: 20_000 });
    assert.deepEqual([round.success, round.migrationPending, round.error], [false, true, undefined], JSON.stringify(round));
    await new Promise((resolve) => setTimeout(resolve, 300)); // 관문이 부른 ensure가 끝날 시간
    const sent = (await adapter.requests(markD1)).filter((r) => r.kind !== 'connect');
    assert.equal(sent.length, 0, `러너가 D1 동기화 요청(pull, push, token)을 보내지 않았다: ${JSON.stringify(sent.map((r) => r.kind))}`);
    assert.equal((await opsBy(fs, A, markFs)).length, 0, '관문이 부른 이전도 실패 간격 안에서는 Firestore를 부르지 않는다');
    assert.equal(await migrationPendingEvents(A), 1, '러너 사건에 migrationPending이 남았다');
    assert.equal(await syncKeyOf(A), K);
    assert.equal((await adapter.family(K)).exists, false);

    // 다음 시도에 Firestore가 살아나면 이어받는다. 이어받은 직후의 7단계 요청은 관문에 막히지 않는다.
    await fs.clearFaults();
    await harness.advanceClocks(31 * MINUTE);
    const pendingBefore = await migrationPendingEvents(A);
    const result = await A.send('runMigration');
    assert.equal(result.result.status, 'uploading', JSON.stringify(result));
    assert.equal((await adapter.family(K)).exists, true, '이어받았다');
    await waitMigrationComplete(A, { syncKey: K });
    assert.equal(await migrationPendingEvents(A), pendingBefore, '7단계 요청이 관문에 막히지 않았다(migrationPending 사건이 더 생기지 않았다)');
    const expected = sortedIds([...famLogs, ...locals].map((l) => l.id));
    assert.deepEqual(await d1Live(adapter, K), expected, '7단계가 모든 기록을 올렸다');
    assert.equal((await stateOf(A, K)).gate, 'proceed');
    assert.equal(await syncKeyOf(A), K);
  }

  // (b) D1 네트워크 실패: Firestore 실패 간격을 적용하지 않는다(Firestore는 건드리지도 않는다).
  {
    const K = hexKey('17b');
    const famLogs = seeds(60, 'ob-', now - 5 * HOUR, { updatedAt: now - 3 * HOUR });
    await fs.seed(K, { members: ['legacy-B'], logs: famLogs });
    await B.send('bootApp');
    const mark = await fs.opCount();
    await adapter.setOffline(true);
    const offline = await B.send('runMigration');
    assert.equal(offline.result.status, 'd1_error', JSON.stringify(offline));
    await adapter.setOffline(false);
    await adapter.failHttp({ status: 503, match: { kind: 'connect' }, times: 1 });
    const serverError = await B.send('runMigration');
    assert.equal(serverError.result.status, 'd1_error', JSON.stringify(serverError));
    const state = (await stateOf(B, K)).state;
    assert.equal(state.failureCount, undefined, 'D1 실패는 Firestore 실패 횟수에 세지 않는다');
    assert.equal(state.nextFirestoreAttemptAt, undefined, 'Firestore 실패 간격이 적히지 않았다');
    assert.equal((await opsBy(fs, B, mark)).length, 0, 'D1 실패 때는 Firestore를 부르지 않았다');
    assert.equal(await syncKeyOf(B), K);
    // 시계를 옮기지 않아도 D1이 돌아오면 바로 이어 간다.
    const retry = await B.send('runMigration');
    assert.equal(retry.result.status, 'uploading', JSON.stringify(retry));
    await waitMigrationComplete(B, { syncKey: K });
    assert.deepEqual(await d1Live(adapter, K), sortedIds(famLogs.map((l) => l.id)));
  }
}, { deviceOptions: { A: { initialStorage: make179Storage({ syncKey: hexKey('17a') }) }, B: { initialStorage: make179Storage({ syncKey: hexKey('17b') }) } } });

// ════════════════════════════════ 집계 ════════════════════════════════
const failed = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오 4부 앞쪽(1~17): ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
