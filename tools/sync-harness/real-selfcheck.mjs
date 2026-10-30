// 실제 서버 모드 기반 구조의 자체 점검입니다(06 설계 2.10, 계획 A6). 서버의 제어 엔드포인트, D1 흉내의 한도와
// 집계, 기기 명령, 저장 고장 주입, 프로세스 정리, 자기 검사가 의도대로 동작하는지만 봅니다.
// 서버 동작의 판정은 regression.mjs(real 모드)와 real-scenarios.mjs가 합니다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createD1Mock } from './stubs/d1-mock.mjs';
import {
  HARNESS_DIR, startRealHarness, selfCheckDevices, selfCheckMembers,
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
} finally {
  await harness.stop();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n자체 점검 ${results.length - failed}/${results.length} 통과${failed ? `, 실패 ${failed}` : ''}`);
process.exit(failed ? 1 : 0);
