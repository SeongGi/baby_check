// 실제 서버 모드 시나리오: 한줄 육아일기와 댓글의 두 기기 동기화(설계 02 8장 2번).
// 실제 Worker 코드(server/src/index.ts)를 서버 프로세스로 띄우고, 기기마다 프로세스를 따로 띄웁니다.
// 기기 이름은 모두 sd 접두어라서 저장 파일이 겹치지 않습니다.
//   DY1. 엄마 기기가 쓴 줄과 아빠 기기의 댓글이 서로에게 작성자와 함께 보이고, 다시 쓰면 줄이 늘지 않고 고쳐진다. 지우면 사라진다.
//   DY2. 같은 역할 두 기기가 같은 날 쓰면 두 줄 모두 남고, 두 기기 모두 같은 줄을 고른다.
//   DY3. 서버에만 삭제 표식이 있는 상태(새 기기가 첫 동기화 전에 씀)에서 쓴 줄이 동기화 뒤에도 남는다.
//
// 기기 프로세스에는 일기 저장 명령이 없으므로(device-real.mjs는 이 작업의 범위 밖), 짧게 사는 별도 프로세스가 기기의 저장 파일에 대고
// storage.ts의 실제 saveDiaryLine과 deleteDiaryGroup을 실행합니다. 기기는 명령마다 저장 파일을 다시 읽으므로 그 결과를 곧바로 봅니다.
// 이 도우미는 한 번에 프로세스 하나만 띄우고, 끝나기를 기다립니다. 기기 명령이 동시에 저장소를 쓰지 않을 때만 부릅니다.
//
// 실행: bash tools/sync-harness/verify.sh scenario real-scenarios-diary.mjs
//       HARNESS_ONLY=DY2 bash tools/sync-harness/verify.sh scenario real-scenarios-diary.mjs   (일부만)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealHarness, loaderArgs } from './real-harness.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const diary = await import(`${SRC}/utils/diary.ts`);

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

// ────────────── 서버와 기기 도우미 ──────────────
const newKey = async (device) => (await device.send('newFamilyKey')).key;
const joinKey = (device, key) => device.send('setProfile', { patch: { syncKey: key } });
const setRole = (device, diaryRole) => device.send('setProfile', { patch: { diaryRole } });
const roleOf = async (device) => (await device.send('getProfile')).profile.diaryRole;
const createRound = (device, key) => device.send('syncWithCloud', { syncKey: key, allowFamilyCreation: true });

/** 가족이 이미 연결된 기기의 동기화를 한 번 돌립니다. */
async function sync(device) {
  const result = await device.send('syncWithCloud', { allowFamilyCreation: false });
  assert.equal(result.success, true, `${device.name} 동기화 실패: ${result.error}`);
  return result;
}

const logsOf = async (device) => (await device.send('getLogs')).logs;
const TODAY = diary.toDiaryDate(Date.now());

// 기기의 저장 파일에 대고 saveDiaryLine 또는 deleteDiaryGroup을 실행하는 별도 프로세스입니다(위 머리말 참고).
const DIARY_OP_SCRIPT = `
const storage = await import(process.env.DIARY_STORAGE_MODULE);
const { op, args } = JSON.parse(process.env.DIARY_OP);
const value = op === 'save' ? await storage.saveDiaryLine(args) : await storage.deleteDiaryGroup(args);
process.stdout.write('DIARY_RESULT ' + JSON.stringify(value) + '\\n');
`;

function diaryOp(device, op, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...loaderArgs(), '--input-type=module', '-e', DIARY_OP_SCRIPT], {
      env: {
        ...process.env,
        HARNESS_STORAGE_FILE: device.storageFile,
        DIARY_STORAGE_MODULE: `${SRC}/database/storage.ts`,
        DIARY_OP: JSON.stringify({ op, args }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${device.name}의 일기 ${op}가 20초 안에 끝나지 않았습니다`)); }, 20_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('DIARY_RESULT '));
      if (code !== 0 || !line) { reject(new Error(`${device.name}의 일기 ${op} 실패(${code}): ${stderr || stdout}`)); return; }
      resolve(JSON.parse(line.slice('DIARY_RESULT '.length)));
    });
  });
}

/** 화면이 입력 창을 열 때 하는 일: 빈 줄도 포함해 고치기 대상을 고릅니다. */
const openTarget = async (device, date, role) =>
  diary.pickDiaryLine(await logsOf(device), date, role, { includeEmpty: true })?.id ?? null;

/** 기기에서 일기를 씁니다. 화면과 같은 방식으로 targetId를 정하되, 처음 쓰는 도중 줄이 도착한 경우를 흉내 낼 때는 targetId를 직접 줍니다. */
async function writeDiary(device, role, text, { date = TODAY, targetId, now } = {}) {
  const target = targetId === undefined ? await openTarget(device, date, role) : targetId;
  const saved = await diaryOp(device, 'save', { diaryDate: date, role, text, targetId: target, ...(now ? { now } : {}) });
  assert.ok(saved, `${device.name}의 일기 저장이 실패했습니다`);
  return saved;
}

/** 기기 화면이 보여 줄 날짜별 묶음에서 한 날짜의 역할별 항목을 돌려줍니다. */
async function viewOf(device, date = TODAY) {
  const group = diary.groupDiaryByDate(await logsOf(device)).find((g) => g.date === date);
  return Object.fromEntries((group?.entries ?? []).map((e) => [e.role, e]));
}

const commentLog = (parent, role, text) => ({
  type: 'diaryComment', timestamp: Date.now(), parentId: parent.id, diaryDate: parent.diaryDate, authorRole: role, notes: text,
});

// ════════════════════════════════ DY1. 엄마의 줄과 아빠의 댓글 ════════════════════════════════
await scenario('DY1', '엄마 기기의 줄과 아빠 기기의 댓글이 작성자와 함께 서로에게 보이고, 다시 쓰면 줄이 늘지 않고 고쳐지며, 지우면 사라진다', ['sdA', 'sdB'], async ({ adapter, devices: [A, B] }) => {
  const key = await newKey(A);
  // 일기가 아닌 기존 기록 3건이 일기 작업 전후로 같아야 한다.
  await A.send('seedLogs', { count: 3, idPrefix: 'base', timestamp: 8_000_000 });
  await setRole(A, 'mom');
  assert.equal((await createRound(A, key)).success, true, 'A의 가족 만들기 실패');
  await joinKey(B, key);
  await setRole(B, 'dad');
  await sync(B);
  const baseBefore = (await logsOf(A)).filter((l) => l.type !== 'diary' && l.type !== 'diaryComment');
  assert.equal(baseBefore.length, 3);

  // A(엄마)가 한 줄을 쓰고 서로 동기화한다.
  const line = await writeDiary(A, 'mom', '오늘 처음 뒤집었다');
  assert.equal(line.authorRole, 'mom');
  await sync(A);
  await sync(B);
  let viewB = await viewOf(B);
  assert.equal(viewB.mom?.line.notes, '오늘 처음 뒤집었다', 'B가 엄마의 줄을 보지 못했다');
  assert.equal(viewB.mom.line.authorRole, 'mom', '작성자(엄마)가 B에 보이지 않는다');
  assert.equal(viewB.mom.line.id, line.id);
  assert.equal(viewB.dad, undefined, '아빠는 아직 쓰지 않았다');

  // B(아빠)가 그 줄에 댓글을 단다(앱의 댓글 추가는 기존 addLog 경로다).
  const comment = (await B.send('addLog', { log: commentLog(line, 'dad', '우와 대단해!') })).saved;
  assert.ok(comment?.id, 'B의 댓글 저장 실패');
  await sync(B);
  await sync(A);
  const viewA = await viewOf(A);
  assert.equal(viewA.mom.comments.length, 1, 'A가 아빠의 댓글을 보지 못했다');
  assert.equal(viewA.mom.comments[0].notes, '우와 대단해!');
  assert.equal(viewA.mom.comments[0].authorRole, 'dad', '댓글 작성자(아빠)가 A에 보이지 않는다');
  assert.equal(viewA.mom.comments[0].parentId, line.id);

  // A가 같은 날 다시 쓰면 줄이 늘지 않고 본문이 고쳐지고, B가 받는다.
  const edited = await writeDiary(A, 'mom', '오늘은 두 번 뒤집었다');
  assert.equal(edited.id, line.id, '다시 쓰면 같은 줄을 고쳐야 한다');
  await sync(A);
  await sync(B);
  const diaryLinesA = (await logsOf(A)).filter((l) => l.type === 'diary');
  const diaryLinesB = (await logsOf(B)).filter((l) => l.type === 'diary');
  assert.equal(diaryLinesA.length, 1, 'A의 일기 줄이 늘었다');
  assert.equal(diaryLinesB.length, 1, 'B의 일기 줄이 늘었다');
  viewB = await viewOf(B);
  assert.equal(viewB.mom.line.notes, '오늘은 두 번 뒤집었다', 'B에 고친 본문이 오지 않았다');
  assert.equal(viewB.mom.comments.length, 1, '고친 뒤에도 댓글이 그 줄 아래 남아야 한다');

  // 아빠도 같은 날 자기 줄을 쓴다: 두 줄이 남는다.
  const dadLine = await writeDiary(B, 'dad', '아빠도 한 줄');
  await sync(B);
  await sync(A);
  const viewA2 = await viewOf(A);
  assert.equal(viewA2.dad?.line.id, dadLine.id);
  assert.equal(Object.keys(viewA2).sort().join(), 'dad,mom', '같은 날 엄마·아빠 두 줄이 보여야 한다');

  // 역할은 휴대폰마다 따로이고 동기화가 바꾸지 않는다. 서버에도 올라가지 않는다.
  assert.equal(await roleOf(A), 'mom', '동기화 뒤 A의 역할이 바뀌었다');
  assert.equal(await roleOf(B), 'dad', '동기화 뒤 B의 역할이 바뀌었다');
  const family = await adapter.family(key);
  assert.ok(!JSON.stringify(family.sharedJson ?? null).includes('diaryRole'), '서버의 공유 프로필에 diaryRole이 올라갔다');

  // A가 자기 줄을 지우면 B에서도 그 줄이 빠진다. 댓글 데이터는 지우지 않고, 부모를 잃어 화면에만 나오지 않는다.
  assert.equal(await diaryOp(A, 'delete', { diaryDate: TODAY, role: 'mom' }), true);
  await sync(A);
  await sync(B);
  viewB = await viewOf(B);
  assert.equal(viewB.mom, undefined, '지운 줄이 B에 남아 있다');
  assert.equal(viewB.dad?.line.id, dadLine.id, '아빠의 줄은 그대로여야 한다');
  assert.ok((await logsOf(B)).some((l) => l.id === comment.id), '댓글 데이터까지 지워졌다');
  assert.ok((await adapter.logs(key)).deleted.includes(line.id), '서버에 삭제 표식이 없다');

  // 일기 아닌 기존 기록은 두 기기 모두 그대로다.
  const sameStable = async (device) => {
    const base = (await logsOf(device)).filter((l) => l.type !== 'diary' && l.type !== 'diaryComment');
    return JSON.stringify(base.map((l) => [l.id, l.timestamp, l.amount, l.updatedAt]).sort())
      === JSON.stringify(baseBefore.map((l) => [l.id, l.timestamp, l.amount, l.updatedAt]).sort());
  };
  assert.ok(await sameStable(A), 'A의 기존 기록이 달라졌다');
  assert.ok(await sameStable(B), 'B의 기존 기록이 달라졌다');
});

// ════════════════════════════════ DY2. 같은 역할 두 기기가 같은 날 씀 ════════════════════════════════
await scenario('DY2', '같은 역할(엄마) 두 기기가 같은 날 쓰면 두 줄 모두 남고, 두 기기 모두 같은 줄을 고르며, 숨은 줄 수를 알린다', ['sdA', 'sdB'], async ({ adapter, devices: [A, B] }) => {
  const key = await newKey(A);
  await setRole(A, 'mom');
  await setRole(B, 'mom');
  assert.equal((await createRound(A, key)).success, true);
  await joinKey(B, key);
  await sync(B);

  // 서로의 줄을 보기 전에 각자 쓴다(동시 쓰기). B가 나중에 썼다.
  const t = Date.now();
  const lineA = await writeDiary(A, 'mom', 'A 휴대폰에서 쓴 줄', { now: t });
  const lineB = await writeDiary(B, 'mom', 'B 휴대폰에서 쓴 줄', { now: t + 5_000 });
  assert.notEqual(lineA.id, lineB.id, '두 기기가 같은 id를 만들었다');
  await sync(A);
  await sync(B);
  await sync(A);

  const live = (await adapter.logs(key)).live.map(([id]) => id);
  assert.ok(live.includes(lineA.id) && live.includes(lineB.id), '서버에 두 줄이 모두 있어야 한다');
  const mineA = (await logsOf(A)).filter((l) => l.type === 'diary');
  const mineB = (await logsOf(B)).filter((l) => l.type === 'diary');
  assert.equal(mineA.length, 2, 'A에 두 줄이 모두 남아야 한다');
  assert.equal(mineB.length, 2, 'B에 두 줄이 모두 남아야 한다');

  const pickA = diary.pickDiaryLine(await logsOf(A), TODAY, 'mom');
  const pickB = diary.pickDiaryLine(await logsOf(B), TODAY, 'mom');
  assert.equal(pickA.id, pickB.id, '두 기기가 서로 다른 줄을 골랐다');
  assert.equal(pickA.id, lineB.id, '더 최근에 쓴 줄(B)이 골라져야 한다');
  const entryA = (await viewOf(A)).mom;
  assert.equal(entryA.hidden.length, 1, '숨은 줄이 1개로 알려져야 한다');
  assert.equal(entryA.hidden[0].id, lineA.id);

  // 같은 줄을 고른 상태에서 숨은 줄에 단 댓글도 보이는 줄 아래에 모인다.
  const onHidden = (await B.send('addLog', { log: commentLog(lineA, 'dad', '숨은 줄에 단 댓글') })).saved;
  assert.ok(onHidden?.id);
  await sync(B);
  await sync(A);
  assert.equal((await viewOf(A)).mom.comments.length, 1, '숨은 줄의 댓글이 보이는 줄 아래에 모여야 한다');

  // 한 기기가 묶음을 지우면 숨은 줄까지 함께 지워지며, 다른 기기에도 그 결과가 전해진다.
  assert.equal(await diaryOp(B, 'delete', { diaryDate: TODAY, role: 'mom' }), true);
  await sync(B);
  await sync(A);
  assert.equal((await logsOf(A)).filter((l) => l.type === 'diary').length, 0, '묶음 삭제 뒤 A에 줄이 남아 있다');
  assert.equal((await logsOf(B)).filter((l) => l.type === 'diary').length, 0);
  assert.deepEqual((await adapter.logs(key)).live.filter(([, raw]) => JSON.parse(raw).type === 'diary'), [], '서버에 일기 줄이 살아 있다');
});

// ════════════════════════════════ DY3. 서버에만 삭제 표식이 있는 상태에서 새 기기가 씀 ════════════════════════════════
await scenario('DY3', '서버에만 삭제 표식이 있는 상태(새 기기가 첫 동기화 전에 씀)에서 쓴 줄이 동기화 뒤에도 남는다', ['sdA', 'sdB'], async ({ adapter, devices: [A, B] }) => {
  const key = await newKey(A);
  await setRole(A, 'mom');
  assert.equal((await createRound(A, key)).success, true);

  // A가 줄을 쓰고 올린 뒤 지워 서버에 삭제 표식을 만든다.
  const old = await writeDiary(A, 'mom', '곧 지울 줄');
  await sync(A);
  assert.equal(await diaryOp(A, 'delete', { diaryDate: TODAY, role: 'mom' }), true);
  await sync(A);
  assert.ok((await adapter.logs(key)).deleted.includes(old.id), '전제: 서버에 삭제 표식이 있다');

  // 새 기기 B는 첫 동기화 전이라 그 삭제 표식을 모른다. 같은 날짜·역할로 쓴다.
  await joinKey(B, key);
  await setRole(B, 'mom');
  const knownTombstones = (await B.send('getProfile')).profile.deletedLogIds ?? [];
  assert.ok(!knownTombstones.includes(old.id), '전제: B는 삭제 표식을 아직 모른다');
  const fresh = await writeDiary(B, 'mom', '새 휴대폰에서 쓴 줄');
  assert.notEqual(fresh.id, old.id, '새 줄의 id가 지운 줄의 id와 같으면 서버가 조용히 지운다');

  await sync(B);
  await sync(A);
  await sync(B);
  const liveIds = (await adapter.logs(key)).live.map(([id]) => id);
  assert.ok(liveIds.includes(fresh.id), '서버가 새 줄을 지웠다');
  for (const device of [A, B]) {
    const pick = diary.pickDiaryLine(await logsOf(device), TODAY, 'mom');
    assert.equal(pick?.id, fresh.id, `${device.name}의 동기화 뒤 화면에 새 줄이 보이지 않는다`);
    assert.equal(pick.notes, '새 휴대폰에서 쓴 줄');
  }
  assert.ok((await adapter.logs(key)).deleted.includes(old.id), '옛 삭제 표식은 그대로여야 한다');
});

// ════════════════════════════════ 집계 ════════════════════════════════
const failed = results.filter((ok) => !ok).length;
console.log(`\n실제 서버 시나리오 일기: ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
process.exit(failed ? 1 : 0);
