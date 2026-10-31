// 실제 서버 모드 기반 구조의 자체 점검입니다(06 설계 2.10, 계획 A6). 서버의 제어 엔드포인트, D1 흉내의 한도와
// 집계, 기기 명령, 저장 고장 주입, 프로세스 정리, 자기 검사가 의도대로 동작하는지만 봅니다.
// 서버 동작의 판정은 regression.mjs(real 모드)와 real-scenarios.mjs가 합니다.
// 07 설계 5.1의 가짜 Firestore 점검(규칙 가정 8가지, 쓰기 목록, 읽기 수 집계, 걸쇠, 끝나지 않는 호출과 terminate, 시계,
// 동적 import 기록, 기기 명령)과 시나리오 1·2의 연기 시험도 여기에 있습니다. 연기 시험은 B5b가 정식 시나리오로 다시 씁니다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createD1Mock } from './stubs/d1-mock.mjs';
import {
  HARNESS_DIR, startRealHarness, selfCheckDevices, selfCheckMembers, make179Storage, waitMigrationComplete, waitFor, auditFirestoreWrites,
} from './real-harness.mjs';

const KEY = 's'.repeat(32);
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(true);
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${name}\n     ${error?.stack || error}`);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ────────────── D1 흉내(같은 프로세스) ──────────────
const schemaSql = readFileSync(path.join(HARNESS_DIR, '../../server/schema.sql'), 'utf8');

await check('D1 흉내: 바인딩 값 101개는 오류, 100개는 통과', async () => {
  const d1 = createD1Mock({ schemaSql });
  const ctx = d1.newContext();
  const placeholders = (n) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',');
  const sql = (n) => `SELECT count(*) AS n FROM logs WHERE log_id IN (${placeholders(n)})`;
  await d1.runInvocation(ctx, async () => {
    const ok = await d1.db.prepare(sql(100)).bind(...Array.from({ length: 100 }, (_, i) => `id${i}`)).first();
    assert.equal(ok.n, 0);
    await assert.rejects(
      d1.db.prepare(sql(101)).bind(...Array.from({ length: 101 }, (_, i) => `id${i}`)).first(),
      /too many SQL variables/,
    );
  });
});

await check('D1 흉내: Worker 호출당 쿼리 50회 초과는 오류이고 batch 한 번은 1회다', async () => {
  const d1 = createD1Mock({ schemaSql });
  const ctx = d1.newContext();
  await d1.runInvocation(ctx, async () => {
    const statements = Array.from({ length: 100 }, () => d1.db.prepare('SELECT 1 AS x'));
    await d1.db.batch(statements);
    assert.equal(ctx.queries, 1);
    for (let i = 0; i < 49; i += 1) await d1.db.prepare('SELECT 1 AS x').first();
    assert.equal(ctx.queries, 50);
    await assert.rejects(d1.db.prepare('SELECT 1 AS x').first(), /Too many API requests/);
  });
});

await check('D1 흉내: 실패한 batch는 ROLLBACK하고 쓴 행 집계에서도 빠진다', async () => {
  const d1 = createD1Mock({ schemaSql });
  const ctx = d1.newContext();
  await d1.runInvocation(ctx, async () => {
    const insert = (id) => d1.db.prepare(
      'INSERT INTO deleted_families (id, deleted_at) VALUES (?1, ?2)').bind(id, 1);
    await assert.rejects(d1.db.batch([insert('a'), d1.db.prepare('INSERT INTO nope VALUES (1)')]), /D1_ERROR/);
    assert.equal((await d1.db.prepare('SELECT count(*) AS n FROM deleted_families').first()).n, 0);
    assert.equal(ctx.rowsWritten, 0);
    const done = await d1.db.batch([insert('a'), insert('b')]);
    assert.equal(done[0].meta.changes, 1);
    assert.equal(ctx.rowsWritten, 2, 'WITHOUT ROWID deleted_families는 인덱스가 없어 한 건 1행');
  });
});

// ────────────── 서버 프로세스와 제어 엔드포인트 ──────────────
const harness = await startRealHarness({ devices: ['A', 'B'] });
const { server } = harness;
const { adapter } = server;

const call = async (route, { method = 'POST', body, clientId = 'selfcheck-client', key = KEY } = {}) => {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};
const push = (body, options) => call('/api/family/sync', { body, ...options });
const lastRequest = async () => (await adapter.requests()).at(-1);
const log = (id, updatedAt = 1000, extra = {}) => ({ id, type: 'formula', amount: 90, timestamp: updatedAt, updatedAt, ...extra });

try {
  await adapter.reset();

  await check('서버: 연결로 가족을 만들고 members에 client_id가 남는다', async () => {
    const created = await call('/api/family/connect', { body: { allowCreate: true } });
    assert.equal(created.status, 200);
    assert.equal(created.json.isNewFamily, true);
    const family = await adapter.family(KEY);
    assert.equal(family.exists, true);
    assert.deepEqual(family.members.map((m) => m.clientId), ['selfcheck-client']);
    assert.equal((await lastRequest()).kind, 'connect');
  });

  await check('집계: 새 기록 1건 삽입은 logs 2행(테이블 1 + 인덱스 1), 토큰 갱신은 families 1행', async () => {
    const res = await push({ pushLogs: [log('a1')] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.acceptedIds, ['a1']);
    const r = await lastRequest();
    assert.equal(r.kind, 'push');
    assert.equal(r.writtenByTable.logs, 2);
    assert.equal(r.writtenByTable.families, 1);
    assert.equal(r.logWrites, 1);
    assert.equal(r.committed, true);
    assert.ok(r.queries >= 3 && r.queries <= 7, `쿼리 ${r.queries}회`);
    assert.ok(r.rowsRead >= 1);
    assert.ok(r.bodyBytes > 0 && r.workerMs >= 0);
  });

  await check('집계: 같은 버전 재전송은 쓰기 0행이고, 고친 기록은 2행(테이블 1 + 인덱스 1)', async () => {
    const before = (await adapter.family(KEY)).token;
    await push({ pushLogs: [log('a1')] });
    let r = await lastRequest();
    assert.equal(r.writtenByTable.logs || 0, 0);
    assert.equal(r.committed, false);
    assert.equal((await adapter.family(KEY)).token, before);
    await push({ pushLogs: [log('a1', 2000)] });
    r = await lastRequest();
    assert.equal(r.writtenByTable.logs, 2);
  });

  await check('요청 종류: pull 유무로 push와 pull을 가르고 pull.after를 기록한다', async () => {
    await push({ pull: { afterUpdatedAt: 0, afterLogId: '', limit: 25 } });
    const r = await lastRequest();
    assert.equal(r.kind, 'pull');
    assert.deepEqual(r.pull.after, [0, '']);
  });

  await check('hold: 요청을 멈추면 멈춘 목록에 나타나고 release로 풀린다', async () => {
    const { ruleId } = await server.control('hold', { op: 'add', match: { kind: 'push', clientId: 'holder' } });
    const pending = push({ pushLogs: [log('h1')] }, { clientId: 'holder' });
    let settled = false;
    pending.then(() => { settled = true; });
    for (let i = 0; i < 200 && (await server.control('state', { q: 'held' })).held.length === 0; i += 1) await sleep(5);
    const { held } = await server.control('state', { q: 'held' });
    assert.equal(held.length, 1);
    assert.equal(held[0].kind, 'push');
    assert.equal(held[0].clientId, 'holder');
    await sleep(50);
    assert.equal(settled, false, '풀기 전에는 응답이 오지 않는다');
    const other = await push({ pushLogs: [log('h2')] }, { clientId: 'other' });
    assert.equal(other.status, 200, '조건에 맞지 않는 요청은 멈추지 않는다');
    const released = await server.control('release', { ruleId });
    assert.deepEqual(released.released, [held[0].id]);
    assert.equal((await pending).status, 200);
    assert.equal((await server.control('state', { q: 'held' })).held.length, 0);
  });

  await check('hold: 배치는 BEGIN 전에 멈춰서 확정 전 행이 보이지 않는다', async () => {
    const gate = await adapter.holdNext({ kind: 'push', batch: 'write' });
    const pending = push({ pushLogs: [log('b1')] });
    await gate.held;
    assert.ok(!(await adapter.logs(KEY)).rows.some((r) => r.id === 'b1'));
    await gate.release();
    assert.equal((await pending).status, 200);
    assert.ok((await adapter.logs(KEY)).rows.some((r) => r.id === 'b1'));
  });

  await check('hold: delayMs는 저절로 풀리고 skip은 앞의 요청을 건너뛴다', async () => {
    const delayed = await adapter.delay({ kind: 'push' }, 250);
    const started = Date.now();
    assert.equal((await push({ pushLogs: [log('d1')] })).status, 200);
    assert.ok(Date.now() - started >= 240, '지연이 적용된다');
    await delayed.clear();
    const skipped = await adapter.holdNext({ kind: 'push' }, { skip: 1 });
    const first = push({ pushLogs: [log('s1')] });
    assert.equal((await first).status, 200, '첫 요청은 건너뛴다');
    const second = push({ pushLogs: [log('s2')] });
    await skipped.held;
    await skipped.release();
    assert.equal((await second).status, 200);
  });

  await check('fail: http 503은 한 번만 적용되고 skip을 따른다', async () => {
    await adapter.failHttp({ status: 503, match: { kind: 'push' }, skip: 1, times: 1 });
    assert.equal((await push({ pushLogs: [log('f1')] })).status, 200);
    const failed = await push({ pushLogs: [log('f2')] });
    assert.equal(failed.status, 503);
    assert.equal((await lastRequest()).status, 503);
    assert.ok(!(await adapter.logs(KEY)).rows.some((r) => r.id === 'f2'), '시작 단계 실패는 서버가 처리하지 않는다');
    assert.equal((await push({ pushLogs: [log('f2')] })).status, 200);
    await adapter.clearFaults();
  });

  await check('fail: COMMIT 전 실패는 ROLLBACK, COMMIT 뒤 예외는 확정된 채 500', async () => {
    await adapter.failCommit({ times: 1 });
    const failed = await push({ pushLogs: [log('c1')] });
    assert.equal(failed.status, 500);
    assert.ok(!(await adapter.logs(KEY)).rows.some((r) => r.id === 'c1'));
    const r = await lastRequest();
    assert.equal(r.committed, false);
    assert.equal(r.writtenByTable.logs || 0, 0);
    assert.equal((await push({ pushLogs: [log('c1')] })).status, 200);

    await server.control('fail', { op: 'add', mode: 'afterCommit', match: { batch: 'write' } });
    const after = await push({ pushLogs: [log('c2')] });
    assert.equal(after.status, 500);
    assert.ok((await adapter.logs(KEY)).rows.some((r2) => r2.id === 'c2'), '확정은 되었다');
    assert.equal((await lastRequest()).committed, true);
    await adapter.clearFaults();
  });

  await check('fail: 연결 끊기는 시작 단계와 응답 단계가 다르다', async () => {
    await server.control('fail', { op: 'add', mode: 'drop', match: { kind: 'push' } });
    await assert.rejects(push({ pushLogs: [log('x1')] }));
    assert.ok(!(await adapter.logs(KEY)).rows.some((r) => r.id === 'x1'));
    assert.equal((await lastRequest()).dropped, true);
    await server.control('fail', { op: 'add', mode: 'drop', match: { kind: 'push' }, at: 'response' });
    await assert.rejects(push({ pushLogs: [log('x2')] }));
    assert.ok((await adapter.logs(KEY)).rows.some((r) => r.id === 'x2'), '응답 전 끊기는 서버가 이미 확정한 뒤다');
    await adapter.clearFaults();
  });

  await check('clock: 고정, 진행, 실제 시각 복귀', async () => {
    const set = await server.control('clock', { set: 5_000_000 });
    assert.deepEqual([set.mode, set.now], ['fixed', 5_000_000]);
    assert.equal((await server.control('clock', { advance: 60_000 })).now, 5_060_000);
    await push({ pushLogs: [log('k1')] });
    assert.equal((await adapter.logs(KEY)).rows.find((r) => r.id === 'k1').updatedAt, 5_060_000);
    const real = await server.control('clock', { real: true });
    assert.equal(real.mode, 'real');
    assert.ok(Math.abs(real.now - Date.now()) < 1000);
  });

  await check('config: maxPushItems를 바꾸면 응답과 서버 상수에 반영된다', async () => {
    await adapter.setLimits({ maxPushItems: 100, maxPageRows: 25 });
    await adapter.reset();
    await adapter.injectLog(KEY, log('p0'), 1);
    await push({ pushLogs: Array.from({ length: 30 }, (_, i) => log(`p${i + 1}`)) });
    await adapter.setLimits({ maxPushItems: 100, maxPageRows: 25 });
    const res = await push({ pull: { afterUpdatedAt: 0, afterLogId: '', limit: 500 } });
    assert.equal(res.json.maxPushItems, 100);
    assert.equal(res.json.maxPageRows, 25);
    assert.equal(res.json.remoteLogs.length, 25, '페이지 크기를 25로 둘 수 있다');
    assert.equal(res.json.hasMore, true);
  });

  await check('inject, wipe, snapshot, restore', async () => {
    await adapter.reset();
    await adapter.injectLog(KEY, log('i1', 3000), 123_456);
    await adapter.injectTombstone(KEY, 'i2', 123_457);
    let logs = await adapter.logs(KEY);
    assert.deepEqual(logs.live.map(([id]) => id), ['i1']);
    assert.deepEqual(logs.deleted, ['i2']);
    assert.equal(logs.rows.find((r) => r.id === 'i1').updatedAt, 123_456);
    assert.equal((await adapter.family(KEY)).exists, true);
    await server.control('wipe', { scope: 'snapshot', name: 's' });
    await server.control('wipe', { scope: 'logs' });
    assert.equal((await adapter.logs(KEY)).rows.length, 0);
    assert.equal((await adapter.family(KEY)).exists, true, '기록만 지운다');
    await server.control('wipe', { scope: 'all' });
    assert.equal((await adapter.family(KEY)).exists, false);
    assert.equal((await push({ pull: { afterUpdatedAt: 0, afterLogId: '', limit: 25 } })).status, 404, '비운 서버는 404');
    await server.control('wipe', { scope: 'restore', name: 's' });
    logs = await adapter.logs(KEY);
    assert.equal(logs.rows.length, 2);
    await adapter.markGone(KEY);
    assert.equal((await adapter.family(KEY)).deleted, true);
    assert.equal((await push({ pull: { afterUpdatedAt: 0, afterLogId: '', limit: 25 } })).status, 410);
    await adapter.reset();
  });

  // ────────────── 기기 프로세스 ──────────────
  const { A, B } = harness.devices;

  await check('자기 검사: 기기 clientId와 저장 파일이 서로 다르다', async () => {
    const infos = await selfCheckDevices(harness);
    assert.equal(infos.length, 2);
    assert.equal(
      await selfCheckDevices({ devices: { A, X: { send: async () => ({ clientId: (await A.send('getSyncClientId')).clientId, storageFile: 'x' }) } } }).then(() => 'passed', (e) => e.message.includes('clientId가 겹칩니다')),
      true,
    );
  });

  const keyA = (await A.send('newFamilyKey')).key;
  await check('기기: 러너로 가족을 만들고 합류하면 members에 서로 다른 client_id 두 개', async () => {
    await A.send('setProfile', { patch: { name: '자기검사' } });
    await A.send('addLog', { log: { type: 'formula', amount: 100, timestamp: 1000 } });
    const created = await A.send('runnerRequest', { request: { syncKey: keyA, createBackup: true, allowFamilyCreation: true, connecting: true } });
    assert.equal(created.success, true, created.error);
    await B.send('setProfile', { patch: { syncKey: keyA } });
    const joined = await B.send('syncWithCloud', { allowFamilyCreation: false });
    assert.equal(joined.success, true, joined.error);
    assert.equal(joined.logCount, 1);
    assert.equal((await selfCheckMembers(harness, keyA)).length, 2);
    const { events } = await A.send('runnerEvents', {});
    assert.deepEqual(events.map((e) => e.type).slice(0, 2), ['started', 'succeeded']);
    const set = await B.send('logSet');
    assert.equal(set.count, 1);
  });

  await check('기기: forgetUploaded가 장부의 uploaded를 비우고 다음 회차가 같은 버전을 다시 보낸다', async () => {
    await A.send('syncWithCloud', {});
    const { ledger } = await A.send('readLedger');
    assert.ok(Object.keys(ledger.uploaded).length >= 1);
    const mark = await adapter.requestCount();
    assert.ok((await A.send('forgetUploaded', {})).removed >= 1);
    assert.equal(Object.keys((await A.send('readLedger')).ledger.uploaded).length, 0);
    assert.equal((await A.send('syncWithCloud', {})).success, true);
    const reqs = (await adapter.requests(mark)).filter((r) => r.kind === 'push' && r.pushLogs > 0);
    assert.ok(reqs.length >= 1);
    assert.equal(reqs[0].writtenByTable.logs || 0, 0, '같은 버전 재전송은 기록 행을 쓰지 않는다');
  });

  await check('기기: 저장 고장 주입 throw는 쓰기 뒤 예외, 세는 쓰기는 기록과 장부 키뿐', async () => {
    await A.send('injectStorageFault', { mode: 'throw', nth: 1 });
    await A.send('setProfile', { patch: { name: '프로필 쓰기는 세지 않는다' } });
    assert.equal((await A.send('storageFaultStatus')).counted, 0);
    // 앱의 addLog는 저장 오류를 삼키고 null을 돌려줍니다. 그래도 쓰기는 파일에 반영된 뒤입니다.
    assert.equal((await A.send('addLog', { log: { type: 'formula', amount: 1, timestamp: 2000 } })).saved, null);
    assert.equal((await A.send('storageFaultStatus')).state, 'fired');
    assert.ok((await A.send('getLogs')).logs.some((l) => l.amount === 1), '쓰기는 파일에 반영된 뒤 예외가 난다');
    assert.equal((await A.send('addLog', { log: { type: 'formula', amount: 2, timestamp: 2001 } })).saved.amount, 2, '그 뒤의 쓰기는 정상');
    await A.send('clearStorageFault');
  });

  await check('기기: 저장 고장 주입 delay는 파일 반영 전에 멈추고 releaseWrite로 푼다', async () => {
    await A.send('injectStorageFault', { mode: 'delay', nth: 1 });
    const pending = A.send('addLog', { log: { type: 'formula', amount: 3, timestamp: 3000 } });
    for (let i = 0; i < 200 && (await A.send('storageFaultStatus')).state !== 'delayed'; i += 1) await sleep(5);
    assert.equal((await A.send('storageFaultStatus')).state, 'delayed');
    assert.ok(!(await A.send('peekLogs')).logs.some((l) => l.amount === 3), '풀기 전에는 파일에 없다');
    assert.deepEqual(await A.send('releaseWrite'), { released: true });
    assert.equal((await pending).saved.amount, 3);
    assert.ok((await A.send('getLogs')).logs.some((l) => l.amount === 3));
  });

  await check('기기: 저장 고장 주입 exit는 쓰기 직후 SIGKILL이고 같은 저장 파일로 다시 띄우면 기록이 남아 있다', async () => {
    const before = (await A.send('getLogs')).logs.length;
    await A.send('injectStorageFault', { mode: 'exit', nth: 1 });
    await assert.rejects(A.send('addLog', { log: { type: 'formula', amount: 4, timestamp: 4000 } }), /exited/);
    assert.equal(A.alive, false);
    assert.equal(A.exitInfo.signal, 'SIGKILL');
    await A.restart();
    const logs = (await A.send('getLogs')).logs;
    assert.equal(logs.length, before + 1);
    assert.equal((await A.send('getSyncClientId')).clientId, (await selfCheckDevices(harness)).find((i) => i.name === 'A').clientId, 'clientId도 저장 파일에서 복원된다');
  });

  await check('기기: abort는 진행 중인 syncWithCloud를 중단하고, 시계 진행이 반영된다', async () => {
    const delayed = await adapter.delay({ kind: 'sync' }, 400);
    const pending = A.send('syncWithCloud', { tokenId: 't1', forceFullRead: true });
    await sleep(100);
    assert.deepEqual(await A.send('abort', { tokenId: 't1' }), { aborted: true });
    const result = await pending;
    assert.equal(result.success, false);
    await delayed.clear();
    await adapter.quiesce();
    const clock = await A.send('advanceClock', { ms: 6 * 3600 * 1000 });
    assert.equal(clock.offsetMs, 6 * 3600 * 1000);
    assert.ok(Math.abs(clock.now - Date.now() - 6 * 3600 * 1000) < 2000);
  });

  await check('기기: 요청 상한을 실제의 10분의 1로 줄여서 시작한다', async () => {
    assert.deepEqual(await A.send('getTiming'), { requestTimeoutMs: 1000, pullBudgetMs: 600, cycleBudgetMs: 800 });
  });

  // ════════════════════════════════════════════════════════════════════
  // 가짜 Firestore (07 설계 5.1). 규칙 가정 8가지는 tools/rules-check/rules.test.mjs와 같은 순서와 내용입니다.
  // ════════════════════════════════════════════════════════════════════
  const fs = server.fs;
  const rpc = async (body) => (await fetch(`${server.url}/__fs/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'sc', actor: 'sc', ...body }),
  })).json();
  const fsOk = (res, what) => assert.ok(!res.error && !res.hang, `${what}: ${JSON.stringify(res.error || res)}`);
  const fsDenied = (res, what, code = 'permission-denied') => assert.equal(res.error?.code, code, `${what} 거부여야 합니다: ${JSON.stringify(res)}`);
  const FK = 'F'.repeat(8) + 'abcdef0123456789abcdef01';
  const famPath = (key) => `families/${fs.familyId(key)}`;
  const nowOf = async () => (await fs.clock({})).now;
  const setDocRpc = (uid, path, data, merge = true, extra = {}) => rpc({ op: 'set', uid, path, data, merge, ...extra });
  const joinRpc = (key, uid, hash = fs.inviteHash(key)) =>
    setDocRpc(uid, `${famPath(key)}/members/${uid}`, { inviteHash: hash, joinedAt: { __serverTs: true } });
  const seedBasic = async (key = FK) => {
    await fs.reset();
    return fs.seed(key, { members: ['uid-member'], logs: ['log-a', 'log-b', 'log-c', 'log-d', 'log-e'].map((id, i) => ({ id, type: 'formula', timestamp: 1000 + i })) });
  };

  await check('가짜 Firestore 규칙 1: 초대 해시가 맞으면 회원 문서를 만들 수 있다(틀린 해시와 남의 uid는 거부)', async () => {
    await seedBasic();
    fsOk(await joinRpc(FK, 'uid-joiner'), '해시 일치');
    assert.deepEqual((await fs.snapshot(FK)).members.sort(), ['uid-joiner', 'uid-member']);
    fsDenied(await joinRpc(FK, 'uid-wrong', 'hash-wrong'), '해시 불일치');
    fsDenied(await setDocRpc('uid-someone', `${famPath(FK)}/members/uid-other`, { inviteHash: fs.inviteHash(FK), joinedAt: { __serverTs: true } }), '남의 uid');
  });

  await check('가짜 Firestore 규칙 2: 예전 가족 문서처럼 inviteHash가 없으면 회원 생성이 거부된다', async () => {
    await fs.seed('L'.repeat(32), { family: { inviteHash: 'omit', schemaVersion: 2 }, members: ['uid-member'] });
    fsDenied(await joinRpc('L'.repeat(32), 'uid-joiner'), 'inviteHash 없는 가족');
  });

  await check('가짜 Firestore 규칙 3: 비회원은 가족 문서와 기록을 읽을 수 없고 자기 회원 문서는 읽을 수 있다', async () => {
    await seedBasic();
    const out = 'uid-outsider';
    fsDenied(await rpc({ op: 'get', uid: out, path: famPath(FK) }), '비회원 가족 문서');
    fsDenied(await rpc({ op: 'get', uid: out, path: `${famPath(FK)}/logs/log-a` }), '비회원 기록');
    fsDenied(await rpc({ op: 'list', uid: out, path: `${famPath(FK)}/logs` }), '비회원 기록 목록');
    const own = await rpc({ op: 'get', uid: out, path: `${famPath(FK)}/members/${out}` });
    fsOk(own, '자기 회원 문서');
    assert.equal(own.exists, false);
    fsDenied(await rpc({ op: 'get', uid: out, path: `${famPath(FK)}/members/uid-member` }), '남의 회원 문서');
    fsOk(await rpc({ op: 'get', uid: out, path: `${famPath('M'.repeat(32))}/members/${out}` }), '가족 문서가 없는 곳의 자기 회원 문서');
  });

  await check('가짜 Firestore 규칙 4: 회원은 pendingDeletionAt: null을 쓸 수 있다(비회원 거부, 예전 가족도 가능)', async () => {
    await seedBasic();
    await fs.seed('L'.repeat(32), { family: { inviteHash: 'omit', schemaVersion: 2 }, members: ['uid-member'] });
    fsOk(await setDocRpc('uid-member', famPath(FK), { pendingDeletionAt: null }), '회원 취소 쓰기');
    fsDenied(await setDocRpc('uid-outsider', famPath(FK), { pendingDeletionAt: null }), '비회원 취소 쓰기');
    fsOk(await setDocRpc('uid-member', famPath('L'.repeat(32)), { pendingDeletionAt: null }), '예전 가족의 취소 쓰기');
  });

  await check('가짜 Firestore 규칙 5: 회원 목록 쿼리는 회원이어도 거부된다', async () => {
    await seedBasic();
    fsDenied(await rpc({ op: 'list', uid: 'uid-member', path: `${famPath(FK)}/members` }), '회원의 회원 목록');
    fsDenied(await rpc({ op: 'list', uid: 'uid-outsider', path: `${famPath(FK)}/members` }), '비회원의 회원 목록');
  });

  await check('가짜 Firestore 규칙 6: 가족 문서가 없으면 회원 생성이 거부된다', async () => {
    await fs.reset();
    fsDenied(await joinRpc('N'.repeat(32), 'uid-joiner'), '가족 문서 없음');
    await fs.seed('N'.repeat(32), { family: null, members: ['uid-ghost'] });
    fsDenied(await joinRpc('N'.repeat(32), 'uid-joiner'), '회원 문서만 남은 가족');
  });

  await check('가짜 Firestore 규칙 7: 회원은 logs 목록 쿼리(문서 id 순서, startAfter, limit)를 할 수 있다', async () => {
    await seedBasic();
    const page = (query) => rpc({ op: 'list', uid: 'uid-member', path: `${famPath(FK)}/logs`, query });
    const first = await page({ orderBy: '__name__', limit: 2 });
    assert.deepEqual(first.docs.map((d) => d.id), ['log-a', 'log-b']);
    assert.deepEqual((await page({ orderBy: '__name__', startAfter: 'log-b', limit: 2 })).docs.map((d) => d.id), ['log-c', 'log-d']);
    assert.deepEqual((await page({ orderBy: '__name__', startAfter: 'log-d', limit: 2 })).docs.map((d) => d.id), ['log-e']);
    fsDenied(await rpc({ op: 'list', uid: 'uid-outsider', path: `${famPath(FK)}/logs`, query: { limit: 2 } }), '비회원 같은 쿼리');
  });

  await check('가짜 Firestore 규칙 8: merge로 pendingDeletionAt: null을 쓰면 다른 필드는 그대로이고, 예약 상태에서도 취소된다', async () => {
    await seedBasic();
    const at = await nowOf();
    const read = async () => (await fs.snapshot(FK)).family;
    fsOk(await setDocRpc('uid-member', famPath(FK), { pendingDeletionAt: null }), 'null 쓰기');
    const after = await read();
    assert.equal(after.pendingDeletionAt, null);
    assert.equal(after.inviteHash, fs.inviteHash(FK));
    assert.equal(after.schemaVersion, 3);
    fsOk(await setDocRpc('uid-member', famPath(FK), { pendingDeletionAt: { __ts: at + 3_600_000 } }), '60분 뒤 예약');
    fsDenied(await setDocRpc('uid-member', famPath(FK), { pendingDeletionAt: { __ts: at + 10 * 60_000 } }), '10분 뒤 예약(50분 미만)');
    fsOk(await setDocRpc('uid-member', famPath(FK), { pendingDeletionAt: null }), '예약 중 취소');
    assert.equal((await read()).pendingDeletionAt, null);
  });

  await check('가짜 Firestore 쓰기 목록: 앱의 허용 쓰기는 통과하고 허용 목록 밖 쓰기와 삭제는 forbidden으로 집계된다', async () => {
    await seedBasic();
    const from = await fs.opCount();
    const app = { actor: 'app' };
    fsOk(await joinRpc(FK, 'uid-joiner').then(() => setDocRpc('uid-member', famPath(FK), { pendingDeletionAt: null }, true, app)), '취소 쓰기');
    // uid-new는 아직 회원 문서가 없으므로 이 쓰기는 생성(create)이다. uid-joiner는 위 join이 이미 만들었다.
    const newShape = { inviteHash: fs.inviteHash(FK), joinedAt: { __serverTs: true } };
    fsOk(await setDocRpc('uid-new', `${famPath(FK)}/members/uid-new`, newShape, true, app), '회원 생성 모양');
    let audit = await fs.audit(from);
    assert.equal(audit.appWrites.length, 2);
    assert.deepEqual(audit.appWrites.map((w) => w.op), ['update', 'create'], '쓰기 직전에 문서가 있었는지로 create와 update를 가른다(가족 문서는 있었으므로 update)');
    assert.deepEqual(audit.forbidden, []);
    // 같은 모양을 이미 있는 회원 문서에 다시 쓰면(예: "이미 회원이면 반환"이 빠진 앱) 필드가 같아도 update라 forbidden이다.
    await setDocRpc('uid-new', `${famPath(FK)}/members/uid-new`, newShape, true, app);
    audit = await fs.audit(from);
    assert.deepEqual(audit.forbidden.map((w) => [w.path.split('/').at(-1), w.op]), [['uid-new', 'update']], '있는 회원 문서를 다시 쓴 것만 forbidden');
    // 허용 목록 밖: 회원 문서 갱신(다른 필드), 기록 쓰기, 삭제
    await setDocRpc('uid-joiner', `${famPath(FK)}/members/uid-joiner`, { joinedAt: { __serverTs: true }, extra: 1 }, true, app);
    await setDocRpc('uid-member', `${famPath(FK)}/logs/log-z`, { payload: { id: 'log-z' }, deleted: false }, false, app);
    await rpc({ op: 'delete', uid: 'uid-member', path: `${famPath(FK)}/logs/log-a`, ...app });
    audit = await fs.audit(from);
    assert.equal(audit.forbidden.length, 4, JSON.stringify(audit.forbidden.map((w) => [w.path, w.fields])));
    assert.equal(audit.deletes.length, 1);
    // 1.7.9 흉내의 쓰기는 앱 쓰기에 섞이지 않는다.
    await fs.legacy179Write(FK, { uid: 'uid-member', logs: [{ id: 'log-w', type: 'formula', timestamp: 5 }] });
    assert.equal((await fs.audit(from)).appWrites.length, audit.appWrites.length);
    // 시드와 1.7.9 흉내처럼 앱이 아닌 쓰기는 create여도 감사 대상이 아니다(위에서 appWrites가 늘지 않음).
  });

  await check('가짜 Firestore 읽기 수 집계: 문서 읽기 수와 규칙 평가 읽기 수(요청마다 회원 확인 1회)를 따로 센다', async () => {
    await seedBasic();
    const run = async (body) => { const from = await fs.opCount(); await rpc(body); return fs.stats(from); };
    let st = await run({ op: 'get', uid: 'uid-member', path: famPath(FK) });
    assert.deepEqual([st.docReads, st.ruleReads, st.reads], [1, 1, 2], '가족 문서: 문서 1 + 규칙 평가 1');
    st = await run({ op: 'list', uid: 'uid-member', path: `${famPath(FK)}/logs`, query: { orderBy: '__name__', limit: 3 } });
    assert.deepEqual([st.docReads, st.ruleReads], [3, 1], '기록 3건 목록: 문서 3 + 규칙 평가 1(문서마다가 아님)');
    st = await run({ op: 'list', uid: 'uid-member', path: `${famPath(FK)}/logs`, query: { startAfter: 'zzz' } });
    assert.deepEqual([st.docReads, st.ruleReads], [1, 1], '빈 결과도 문서 1건으로 셈');
    st = await run({ op: 'get', uid: 'uid-member', path: `${famPath(FK)}/members/uid-member` });
    assert.deepEqual([st.docReads, st.ruleReads], [1, 0], '자기 회원 문서는 규칙 평가 읽기가 없다');
    st = await run({ op: 'get', uid: 'uid-outsider', path: famPath(FK) });
    assert.deepEqual([st.docReads, st.ruleReads, st.denied], [1, 1, 1], '거부된 요청도 읽기 1건이다');
    st = await run({ op: 'set', uid: 'uid-joiner', path: `${famPath(FK)}/members/uid-joiner`, merge: true, data: { inviteHash: fs.inviteHash(FK), joinedAt: { __serverTs: true } } });
    assert.deepEqual([st.writes, st.ruleReads], [1, 1], '회원 생성: 규칙이 가족 문서를 한 번 읽는다');
  });

  await check('가짜 Firestore 1.7.9 흉내: 기록 쓰기와 lastChangedAt은 같은 서버 시각, 삭제 표식에도 updatedAt, 예약은 lastChangedAt을 바꾸지 않는다', async () => {
    await seedBasic();
    await fs.reset();
    await fs.seed(FK, { family: { lastChangedAt: 1000 }, members: ['uid-b'], logs: [{ id: 'old', type: 'formula', timestamp: 1 }] });
    const written = await fs.legacy179Write(FK, { uid: 'uid-b', logs: [{ id: 'new1', type: 'formula', timestamp: 2 }], deleteIds: ['old'] });
    const snap = await fs.snapshot(FK);
    const T = written.serverTime;
    assert.equal(snap.family.lastChangedAt.__ts, T);
    assert.equal(snap.family.lastChangedBy, 'uid-b');
    assert.deepEqual(snap.live.map(([id]) => id), ['new1']);
    assert.deepEqual(snap.deleted, ['old']);
    assert.equal((await fs.getDoc(`${famPath(FK)}/logs/new1`)).updatedAt.__ts, T);
    const tomb = await fs.getDoc(`${famPath(FK)}/logs/old`);
    assert.equal(tomb.updatedAt.__ts, T, '삭제 표식에도 updatedAt');
    assert.equal(tomb.deleted, true);
    assert.ok(tomb.payload, '삭제 표식은 merge라서 payload가 남는다');
    const scheduled = await fs.legacy179Schedule(FK, { uid: 'uid-b' });
    const afterSchedule = (await fs.snapshot(FK)).family;
    assert.equal(afterSchedule.pendingDeletionAt.__ts, scheduled.readyAt);
    assert.equal(afterSchedule.lastChangedAt.__ts, T, '예약은 lastChangedAt을 바꾸지 않는다');
    await fs.legacy179Cancel(FK, { uid: 'uid-b' });
    const afterCancel = (await fs.snapshot(FK)).family;
    assert.equal(afterCancel.pendingDeletionAt, null);
    assert.equal(afterCancel.lastChangedAt.__ts, T);
    await assert.rejects(fs.legacy179Write(FK, { uid: 'uid-nobody', logs: [{ id: 'x', type: 'formula', timestamp: 3 }] }), /거부/, '비회원의 1.7.9 쓰기는 규칙이 거부한다');
    const profileWrite = await fs.legacy179Write(FK, { uid: 'uid-b', profile: { name: '바뀐 이름', sharedUpdatedAt: 5 } });
    assert.ok(profileWrite.serverTime > T);
    assert.equal((await fs.snapshot(FK)).family.lastChangedAt.__ts, profileWrite.serverTime, '프로필 쓰기도 lastChangedAt을 갱신한다');
  });

  await check('가짜 Firestore 걸쇠: 페이지 읽기 사이에 다른 기기의 쓰기를 끼워 넣을 수 있다', async () => {
    await fs.reset();
    await fs.seed(FK, { members: ['uid-a', 'uid-b'], logs: ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'formula', timestamp: 1, amount: 1 })) });
    const page = (after) => rpc({ op: 'list', uid: 'uid-a', device: 'reader', path: `${famPath(FK)}/logs`, query: { orderBy: '__name__', limit: 2, ...(after ? { startAfter: after } : {}) } });
    const first = await page();
    assert.deepEqual(first.docs.map((d) => d.id), ['a', 'b']);
    // 두 번째 페이지 요청을 걸쇠로 멈추고, 그 사이 이미 읽은 문서 'a'를 다른 기기가 고친다.
    const second = fs.interleave({ op: 'list', kind: 'logs', device: 'reader' }, {}, {
      call: () => page('b'),
      between: async (item) => {
        assert.equal(item.op, 'list');
        await fs.legacy179Write(FK, { uid: 'uid-b', logs: [{ id: 'a', type: 'formula', timestamp: 1, amount: 99, updatedAt: 50 }] });
      },
    });
    const result = await second;
    assert.deepEqual(result.docs.map((d) => d.id), ['c', 'd']);
    assert.equal((await fs.snapshot(FK)).live.find(([id]) => id === 'a')[1].amount, 99, '걸쇠 사이의 쓰기가 반영됐다');
    assert.equal((await fs.held()).length, 0);
  });

  await check('가짜 Firestore 오류 주입: resource-exhausted, 일반 오류, offline, delay, hang(응답 없음), skip과 times', async () => {
    await seedBasic();
    const get = () => rpc({ op: 'get', uid: 'uid-member', path: famPath(FK) });
    await fs.exhaust({ op: 'get' });
    fsDenied(await get(), 'resource-exhausted', 'resource-exhausted');
    await fs.clearFaults();
    await fs.fail({ match: { op: 'get' }, code: 'unavailable', skip: 1, times: 1 });
    fsOk(await get(), '첫 요청은 건너뜀');
    fsDenied(await get(), 'unavailable', 'unavailable');
    fsOk(await get(), 'times를 다 씀');
    await fs.offline(true);
    fsDenied(await get(), 'offline', 'unavailable');
    await fs.offline(false);
    await fs.delay({ op: 'get' }, 200);
    const started = Date.now();
    fsOk(await get(), 'delay');
    assert.ok(Date.now() - started >= 190);
    await fs.hang({ op: 'get' });
    assert.equal((await get()).hang, true, '끝나지 않는 호출은 hang으로 답한다(기기 SDK는 이때 결코 끝나지 않는 약속을 돌려줌)');
    fsOk(await get(), 'hang도 한 번만');
    await fs.clearFaults();
  });

  await check('가짜 Firestore terminate: 닫힌 인스턴스의 요청은 거부되고 새 인스턴스는 된다. 종료 횟수와 인스턴스 목록이 남는다', async () => {
    await seedBasic();
    const from = await fs.opCount();
    const get = (instance) => rpc({ op: 'get', uid: 'uid-member', path: famPath(FK), instance });
    fsOk(await get('i1'), '새 인스턴스');
    fsOk(await rpc({ op: 'terminate', instance: 'i1' }), 'terminate');
    fsDenied(await get('i1'), '닫힌 인스턴스', 'failed-precondition');
    fsOk(await get('i2'), '다시 만든 인스턴스');
    assert.equal((await fs.stats(from)).terminates, 1);
    const instances = (await fs.instances()).filter((i) => ['i1', 'i2'].includes(i.id));
    assert.deepEqual(instances.map((i) => [i.id, i.terminated]), [['i1', true], ['i2', false]]);
  });

  await check('가짜 Firestore 시계: 서버 시각과 규칙의 request.time이 주입한 시계를 따른다', async () => {
    await seedBasic();
    await fs.clock({ set: 2_000_000_000_000 });
    const written = await fs.legacy179Write(FK, { uid: 'uid-member', logs: [{ id: 'clk', type: 'formula', timestamp: 1 }] });
    assert.ok(written.serverTime >= 2_000_000_000_000 && written.serverTime < 2_000_000_000_100);
    const sched = await fs.legacy179Schedule(FK, { uid: 'uid-member' });
    assert.equal(sched.readyAt, 2_000_000_000_000 + 3_600_000);
    await fs.clock({ advance: 7_200_000 });
    assert.equal((await fs.clock({})).now, 2_000_000_000_000 + 7_200_000);
    // 예약 시각이 지난 뒤(시계가 앞으로 감) 가족 문서를 지울 수 있는 것은 규칙의 time 판정이다.
    const del = await rpc({ op: 'delete', uid: 'uid-member', path: famPath(FK), actor: 'sc' });
    assert.ok(!del.error, '예약 시각이 지나면 규칙이 삭제를 허용한다(앱은 삭제하지 않지만 규칙 흉내가 시계를 따르는지 본다)');
    await fs.clock({ real: true });
  });

  // ── 기기 쪽 ──
  const startFs = (names, options = {}) => startRealHarness({
    devices: names,
    deviceOptions: Object.fromEntries(names.map((n) => [n, options[n] || {}])),
  });
  const fsHarness = await startFs(['fsA', 'fsB', 'fsC', 'fsD', 'fsE'], {
    fsA: { initialStorage: make179Storage({ syncKey: FK }) },
    fsB: { initialStorage: make179Storage({ syncKey: FK }) },
    fsC: { initialStorage: make179Storage({ syncKey: FK }) },
    fsD: { initialStorage: make179Storage({}) },
    fsE: { initialStorage: make179Storage({ syncKey: FK }), env: { HARNESS_LOAD_FIRESTORE: 'inject' } },
  });
  try {
    const { fsA, fsB, fsC, fsD, fsE } = fsHarness.devices;
    const fsSrv = fsHarness.server;
    await fsSrv.adapter.reset();

    await check('기기: 혼자 쓰는 기기는 이전 모듈을 돌려도 firestoreImport.ts와 firebase.ts를 불러오지 않는다(동적 import 기록)', async () => {
      assert.equal((await fsD.send('bootApp')).marker.keys.length, 0, '혼자 쓰는 기기도 표식은 적는다(빈 배열)');
      assert.equal((await fsD.send('runMigration')).result.status, 'no_key', '앱도 키가 없으면 ensure를 부르지 않는다');
      assert.equal((await fsD.send('runMigration', { syncKey: FK })).result.status, 'not_connected', '다른 키를 억지로 넣어도 아무것도 하지 않는다');
      assert.equal((await fsD.send('runnerRequest', { request: { syncKey: FK } })).success !== undefined, true);
      const loads = await fsD.send('moduleLoads');
      assert.deepEqual([loads.firestoreImportLoaded, loads.firebaseLoaded, loads.loads.length], [false, false, 0]);
    });

    await check('기기: 기본 경로(loadFirestore 주입 없음)에서 이전을 돌리면 그 시점에 두 모듈이 불러와지고 로드 시각이 남는다', async () => {
      await fsSrv.fs.seed(FK, { members: ['legacy-B'], logs: [{ id: 'p1', type: 'formula', timestamp: 1000, updatedAt: 1000 }] });
      await fsC.send('bootApp');
      assert.equal((await fsC.send('moduleLoads')).loads.length, 0, '이전 전에는 불러오지 않는다');
      const before = Date.now();
      assert.equal((await fsC.send('runMigration')).result.status, 'uploading');
      const loads = await fsC.send('moduleLoads');
      assert.deepEqual(loads.loads.map((l) => l.module), ['firestoreImport.ts', 'firebase.ts']);
      assert.ok(loads.loads.every((l) => l.at >= before - 50), '로드 시각이 이전을 시작한 뒤다');
      assert.equal(loads.injectedLoads, 0);
      await waitMigrationComplete(fsC);
    });

    await check('기기: HARNESS_LOAD_FIRESTORE=inject 기기는 주입한 loadFirestore가 한 번 불린다', async () => {
      await fsE.send('bootApp');
      await fsE.send('runMigration');
      const loads = await fsE.send('moduleLoads');
      assert.equal(loads.injectedLoads, 1);
      assert.equal(loads.firestoreImportLoaded, true);
      await waitMigrationComplete(fsE);
    });

    await check('기기: 가짜 Firestore 위에서 실제 firestoreImport.ts가 돈다(앱 쓰기 목록은 회원 문서 생성뿐, 같은 uid 재사용)', async () => {
      const audit = await fsSrv.fs.audit();
      assert.deepEqual(audit.forbidden, []);
      assert.deepEqual(audit.deletes, []);
      assert.ok(audit.appWrites.length >= 2 && audit.appWrites.every((w) => w.path.includes('/members/') && w.kind === 'set'));
      assert.ok((await fsSrv.fs.stats()).byDevice.fsC.reads > 0);
    });

    await check('기기: 익명 uid는 재시작해도 유지되고 firestoreUid로 바꿀 수 있다(uid 변경)', async () => {
      const uid1 = (await fsC.send('firestoreUid')).uid;
      assert.match(uid1, /^anon-fsC-/);
      await fsC.restart();
      assert.equal((await fsC.send('firestoreUid')).uid, uid1);
      assert.equal((await fsC.send('firestoreUid', { uid: 'uid-changed' })).uid, 'uid-changed');
      assert.equal((await fsC.send('firestoreUid', { reset: true })).uid, null);
    });

    await check('기기: 끝나지 않는 호출은 상한(스케일 1.5초) 뒤 terminate되고 다음 시도는 새 인스턴스로 돈다', async () => {
      await fsSrv.adapter.reset();
      await fsSrv.fs.seed(FK, { members: ['legacy-B'], logs: [{ id: 'h1', type: 'formula', timestamp: 1000, updatedAt: 1000 }] });
      await fsB.send('bootApp');
      await fsSrv.fs.hang({ op: 'get', kind: 'family', device: 'fsB' });
      const from = await fsSrv.fs.opCount();
      const started = Date.now();
      const first = await fsB.send('runMigration');
      assert.equal(first.result.status, 'firestore_failed', JSON.stringify(first));
      assert.ok(Date.now() - started >= 1_400, '상한까지 기다렸다');
      assert.equal((await fsSrv.fs.stats(from)).terminates, 1, 'terminate가 불렸다');
      const state = await fsB.send('migrationState');
      assert.ok(state.state.nextFirestoreAttemptAt > Date.now(), '가벼운 실패 간격이 적용됐다');
      await fsHarness.advanceClocks(31 * 60_000, { d1: false });
      assert.equal((await fsB.send('runMigration')).result.status, 'uploading');
      const instances = (await fsSrv.fs.instances()).filter((i) => i.device === 'fsB');
      assert.ok(instances.length >= 2 && instances[0].terminated && !instances.at(-1).terminated, JSON.stringify(instances));
      await waitMigrationComplete(fsB);
    });

    await check('기기: setChoiceAnswers 대기열, 답 보류와 answerChoice, 안내 기록, 저장소 읽기 집계', async () => {
      await fsA.send('setChoiceAnswers', { legacyDeletion: [{ hold: true }, 'cancelRequest'], backupFailure: ['continue'] });
      const queued = await fsA.send('setChoiceAnswers', { defaults: { legacyDeletion: 'later' } });
      assert.equal(queued.queued.legacyDeletion, 2);
      await fsSrv.adapter.reset();
      await fsSrv.fs.seed(FK, { members: ['legacy-B'], family: { pendingDeletionAt: Date.now() + 3_600_000 }, logs: [{ id: 'd1', type: 'formula', timestamp: 1000, updatedAt: 1000 }] });
      await fsA.send('bootApp');
      await fsA.send('storageReads', { clear: true });
      const pending = fsA.send('runMigration');
      const log = await waitFor(async () => {
        const entries = await fsA.send('choiceLog');
        return entries.pending.length ? entries : null;
      }, { label: '보류된 선택 화면' });
      assert.equal(log.legacyDeletion[0].context, 'missing');
      assert.deepEqual(log.legacyDeletion[0].options.sort(), ['cancelRequest', 'followDeletion', 'later']);
      assert.equal((await fsA.send('answerChoice', { kind: 'legacyDeletion', answer: 'later' })).answered, true);
      assert.equal((await pending).result.status, 'pending_deletion');
      const reads = await fsA.send('storageReads');
      assert.ok(reads.reads['@baby_cf_migration_v1:' + FK] >= 1 && reads.order.length > 0, '저장소 읽기를 센다');
      const after = await fsA.send('choiceLog', { clear: true });
      assert.equal(after.legacyDeletion[0].answer, 'later');
      assert.equal(after.pending.length, 0);
      assert.deepEqual((await fsA.send('choiceLog')).legacyDeletion, []);
      assert.equal((await fsA.send('migrationMessages')).messages.absent, '가족 정보를 찾지 못했습니다.');
    });

    await check('기기: 저장 고장 주입 reject(용량 부족)와 접두어 키는 백업 저장을 막고 백업 실패 화면을 부른다', async () => {
      await fsC.send('setChoiceAnswers', { backupFailure: ['later', 'continue'] });
      await fsC.send('writeStorage', { key: `@baby_cf_migration_v1:${FK}`, value: null });
      await fsC.send('writeStorage', { key: '@baby_pre_cloudflare_backup_v1', value: null });
      await fsC.send('writeStorage', { key: '@baby_pre_cloudflare_backup_meta_v1', value: null });
      await fsC.send('injectStorageFault', { mode: 'reject', keys: ['@baby_pre_cloudflare_backup_v1'], times: 'always' });
      await fsC.send('bootApp');
      const first = await fsC.send('runMigration');
      assert.equal(first.result.status, 'backup_pending');
      assert.equal((await fsC.send('choiceLog')).backupFailure.length, 1);
      assert.equal((await fsC.send('migrationState')).hasBackupValue, false, '거부된 쓰기는 파일에 반영되지 않는다');
      await fsC.send('clearStorageFault');
      await fsC.send('injectStorageFault', { mode: 'throw', keys: ['@baby_cf_migration_v1:*'], nth: 1 });
      assert.equal((await fsC.send('storageFaultStatus')).state, 'armed');
      await fsC.send('clearStorageFault');
    });

    await check('기기: 표식 명령(setLegacyMarker, clearLegacyMarker)과 migratorReset, 타이머와 이벤트 기록', async () => {
      assert.equal((await fsD.send('setLegacyMarker', { keys: ['abc'] })).marker.keys[0], 'abc');
      assert.equal((await fsD.send('setLegacyMarker', { value: null })).marker, null);
      await fsD.send('bootApp');
      assert.deepEqual((await fsD.send('clearLegacyMarker')).marker.keys, []);
      assert.equal((await fsD.send('bootApp')).marker.keys.length, 0, '비운 뒤에는 다시 계산하지 않는다');
      assert.equal((await fsD.send('migratorReset', { firestoreCallTimeoutMs: 500 })).firestoreCallTimeoutMs, 500);
      assert.ok(Array.isArray((await fsD.send('migrationTimers')).timers));
      assert.ok((await fsA.send('migratorEvents')).events.length >= 0);
    });
  } finally {
    await fsHarness.stop();
  }

  // ════════════════════════════════════════════════════════════════════
  // 연기 시험: 시나리오 1(두 기기 차례 업데이트)과 2(부활 금지)를 끝까지 한 번 돌려 도구가 이어지는지 봅니다.
  // 정식 시나리오는 B5b가 real-scenarios-4a.mjs에서 다시 씁니다.
  // ════════════════════════════════════════════════════════════════════
  const smoke = await startFs(['smA', 'smB', 'smC'], {
    smA: { initialStorage: make179Storage({ syncKey: FK }) },
    smB: { initialStorage: make179Storage({ syncKey: FK }) },
    smC: { initialStorage: make179Storage({ syncKey: 'G'.repeat(8) + 'abcdef0123456789abcdef01' }) },
  });
  try {
    const { smA, smB, smC } = smoke.devices;
    const { server: sv } = smoke;
    const idsOf = async (device) => (await device.send('getLogs')).logs.map((l) => l.id).sort();

    await check('연기 시험 시나리오 1: A가 먼저 이전하고 B가 나중에 이전해도 연결이 유지되고 세 곳의 기록 집합이 같다(3,000건, 삭제 표식 300건)', async () => {
      await sv.adapter.reset();
      const logs = Array.from({ length: 3000 }, (_, i) => ({ id: `fs-${String(i).padStart(4, '0')}`, type: 'formula', amount: 90, timestamp: 1_000_000 + i, updatedAt: 1_000_000 + i }));
      const tombstones = Array.from({ length: 300 }, (_, i) => `gone-${i}`);
      await sv.fs.seed(FK, { members: ['legacy-C'], logs, tombstones });
      await smA.send('bootApp');
      await smB.send('bootApp');
      // 이전 전 첫 동기화는 관문이 막는다: 404 오류도 D1 요청도 없다.
      const mark = await sv.adapter.requestCount();
      const gated = await smA.send('runnerRequest', { request: { syncKey: FK } });
      assert.equal(gated.success, false);
      assert.equal(gated.migrationPending, true);
      assert.equal(gated.error, undefined, '관문이 막은 회차는 오류가 아니다');
      assert.equal((await sv.adapter.requests(mark)).length, 0, 'D1 요청 0회');

      const first = await smA.send('runMigration');
      assert.equal(first.result.status, 'uploading', JSON.stringify(first));
      const aState = await waitMigrationComplete(smA, { timeoutMs: 60_000 });
      assert.equal(aState.state.mergeSource, 'ok');
      assert.equal(aState.gate, 'proceed');
      assert.equal((await sv.adapter.logs(FK)).live.length, 3000, 'D1 가족이 생기고 기록이 모두 올라갔다');
      assert.equal((await smA.send('getProfile')).profile.syncKey, FK, 'A의 연결이 유지된다');

      const second = await smB.send('runMigration');
      assert.equal(second.result.status, 'uploading', JSON.stringify(second));
      await waitMigrationComplete(smB, { timeoutMs: 60_000 });
      assert.equal((await smB.send('getProfile')).profile.syncKey, FK, 'B의 연결이 유지된다');
      for (const device of [smA, smB]) {
        const done = await device.send('runnerRequest', { request: { syncKey: FK }, timeoutMs: 20_000 });
        assert.equal(done.success, true, done.error);
      }
      const expected = logs.map((l) => l.id).sort();
      const fsLive = (await sv.fs.snapshot(FK)).live.map(([id]) => id).sort();
      assert.deepEqual(fsLive, expected, 'Firestore');
      assert.deepEqual((await sv.adapter.logs(FK)).live.map(([id]) => id).sort(), expected, 'D1');
      assert.deepEqual(await idsOf(smA), expected, 'A');
      assert.deepEqual(await idsOf(smB), expected, 'B');
      const audit = await auditFirestoreWrites(smoke);
      assert.ok(audit.appWrites.length >= 2, '회원 문서 생성 쓰기는 기록돼 있다');
      // 가져오기와 로컬 백업 복원은 이전 상태를 지우지 않는다(시나리오 11에 쓰는 명령)
      await smA.send('importData', { logs: [] });
      await smA.send('backupLocalData');
      assert.equal((await smA.send('restoreLocalBackup')).success, true);
      assert.equal((await smA.send('migrationState')).complete, true);
    });

    await check('연기 시험 시나리오 2: 영구 삭제한 가족에 다른 기기가 이전을 시도하면 410이고 D1에 가족이 생기지 않는다', async () => {
      const key2 = 'G'.repeat(8) + 'abcdef0123456789abcdef01';
      await sv.fs.seed(key2, { members: ['legacy-C'], logs: [{ id: 'z1', type: 'formula', timestamp: 5, updatedAt: 5 }] });
      await sv.adapter.markGone(key2);
      await smC.send('bootApp');
      await smC.send('addLog', { log: { type: 'formula', amount: 10, timestamp: 77 } });
      const result = await smC.send('runMigration');
      assert.equal(result.result.status, 'deleted', JSON.stringify(result));
      const family = await sv.adapter.family(key2);
      assert.deepEqual([family.exists, family.deleted], [false, true], 'D1에 가족이 생기지 않는다');
      await waitFor(async () => !(await smC.send('getProfile')).profile.syncKey, { label: 'C의 연결 해제(410 회차)' });
      assert.ok((await smC.send('getLogs')).logs.some((l) => l.timestamp === 77), '기기 기록은 남는다');
      // legacyDeletion 없는 delete는 가족이 없으면 404이고 deleted_families가 그대로다.
      const other = 'H'.repeat(8) + 'abcdef0123456789abcdef01';
      const res = await fetch(`${sv.url}/api/family/delete`, {
        method: 'POST', headers: { Authorization: `Bearer ${other}`, 'X-Client-Id': 'smoke-client', 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 404);
      assert.deepEqual([(await sv.adapter.family(other)).exists, (await sv.adapter.family(other)).deleted], [false, false]);
    });
  } finally {
    await smoke.stop();
  }
} finally {
  await harness.stop();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n자체 점검 ${results.length - failed}/${results.length} 통과${failed ? `, 실패 ${failed}` : ''}`);
process.exit(failed ? 1 : 0);
