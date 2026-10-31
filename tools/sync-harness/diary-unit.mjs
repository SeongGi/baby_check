// 한줄 육아일기와 댓글의 단위 시험입니다(네트워크 없음).
// loader.mjs가 AsyncStorage를 HARNESS_STORAGE_FILE 파일로 흉내 내므로, storage.ts의 실제 함수를 그대로 불러 시험합니다.
// 실행: bash tools/sync-harness/verify.sh diary   (또는 npm run test:diary)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const stub = await import('./stubs/async-storage.mjs');
const AsyncStorage = stub.default;
const { rawStorage, storageFaults } = stub;
const storage = await import(`${SRC}/database/storage.ts`);
const diary = await import(`${SRC}/utils/diary.ts`);
const { isDiaryType } = await import(`${SRC}/types.ts`);

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${!passed && detail ? `: ${detail}` : ''}`);
};

// 네트워크 0회를 확인하려고 fetch를 세는 가짜로 바꿉니다. 시험 전체에서 한 번도 불리면 안 됩니다.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error('시험 중 네트워크를 부르면 안 됩니다'); };

const LOGS_KEY = '@baby_logs';
const PROFILE_KEY = '@baby_profile';
const DAY = '2026-11-01';
const NOW = new Date(2026, 10, 1, 10, 30).getTime(); // 2026-11-01 10:30 현지

const readLogsRaw = async () => JSON.parse((await rawStorage.getItem(LOGS_KEY)) ?? '[]');
const readProfileRaw = async () => JSON.parse((await rawStorage.getItem(PROFILE_KEY)) ?? '{}');
const diariesOf = (logs, date = DAY, role) =>
  logs.filter((l) => l.type === 'diary' && l.diaryDate === date && (!role || l.authorRole === role));
const setLogs = (logs) => rawStorage.setItem(LOGS_KEY, JSON.stringify(logs));
const reset = async (logs = [], profile) => {
  await AsyncStorage.clear();
  await setLogs(logs);
  if (profile) await rawStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
};
/** 화면이 입력 창을 열 때 하는 일: 빈 줄도 포함해 고치기 대상을 고릅니다. */
const openTarget = async (date, role) =>
  diary.pickDiaryLine(await storage.getLogs(), date, role, { includeEmpty: true })?.id ?? null;
const save = async (text, { date = DAY, role = 'mom', targetId = undefined, now = NOW } = {}) =>
  storage.saveDiaryLine({
    diaryDate: date, role, text, now,
    targetId: targetId === undefined ? await openTarget(date, role) : targetId,
  });
const diaryLine = (id, date, role, notes, updatedAt, extra = {}) => ({
  id, type: 'diary', timestamp: updatedAt, updatedAt, diaryDate: date, authorRole: role, notes, ...extra,
});
const formula = (i) => ({ id: `f${i}`, type: 'formula', amount: 90 + (i % 7), timestamp: 1_700_000_000_000 + i * 1000, updatedAt: 1_700_000_000_000 + i * 1000, notes: `메모${i}` });
const sameById = (before, after) => {
  const map = new Map(after.map((l) => [l.id, storage.stableValue(l)]));
  return before.length === after.length && before.every((l) => map.get(l.id) === storage.stableValue(l));
};

// ═════════ 순수 함수 ═════════
check('countCodePoints: 한글과 이모지가 한 글자씩', diary.countCodePoints('아기😀') === 3 && diary.countCodePoints('😀'.repeat(200)) === 200);
check('clampCodePoints: 코드 포인트 기준으로 자른다(이모지가 반으로 잘리지 않음)',
  diary.clampCodePoints('😀'.repeat(5), 3) === '😀😀😀' && diary.clampCodePoints('abc', 5) === 'abc');
check('toDiaryDate: 기기 현지 날짜', diary.toDiaryDate(new Date(2026, 0, 5, 23, 59).getTime()) === '2026-01-05');
check('shiftDiaryDate: 월 경계와 연 경계', diary.shiftDiaryDate('2026-03-01', -1) === '2026-02-28' && diary.shiftDiaryDate('2026-12-31', 1) === '2027-01-01');
check('diaryDateBounds: 생일이 하한, 오늘이 상한', JSON.stringify(diary.diaryDateBounds('2026-10-01', NOW)) === JSON.stringify({ min: '2026-10-01', max: DAY }));
check('diaryDateBounds: 생일 형식이 틀리거나 미래면 하한 없음', diary.diaryDateBounds('abc', NOW).min === null && diary.diaryDateBounds('2027-01-01', NOW).min === null && diary.diaryDateBounds('2027-01-01', NOW).max === DAY);
check('diaryTimestampFor: 오늘은 저장 시각, 지난 날짜는 그날 21:00(현지)',
  diary.diaryTimestampFor(DAY, NOW) === NOW && diary.diaryTimestampFor('2026-10-30', NOW) === new Date(2026, 9, 30, 21, 0).getTime());
check('makeDiaryId: diary_<날짜8자리>_<역할>_<무작위> 모양', /^diary_20261101_mom_[0-9a-z]+$/.test(diary.makeDiaryId(DAY, 'mom')));
check('makeDiaryId: 매번 다르다', new Set(Array.from({ length: 200 }, () => diary.makeDiaryId(DAY, 'mom'))).size === 200);

{
  const a = diaryLine('a', DAY, 'mom', '가', 100);
  const b = diaryLine('b', DAY, 'mom', '나', 200);
  check('pickDiaryLine: updatedAt이 가장 큰 줄', diary.pickDiaryLine([a, b], DAY, 'mom')?.id === 'b' && diary.pickDiaryLine([b, a], DAY, 'mom')?.id === 'b');
  const t1 = diaryLine('id-1', DAY, 'mom', '가', 300);
  const t2 = diaryLine('id-2', DAY, 'mom', '나', 300);
  check('pickDiaryLine: 동점이면 id가 큰 쪽, 배열 순서와 무관', diary.pickDiaryLine([t1, t2], DAY, 'mom')?.id === 'id-2' && diary.pickDiaryLine([t2, t1], DAY, 'mom')?.id === 'id-2');
  const emoji = diaryLine('\u{1F600}', DAY, 'mom', 'x', 300); // U+1F600
  const bmp = diaryLine('�', DAY, 'mom', 'x', 300); // U+FFFD (UTF-16 순서로는 이모지가 더 작음)
  check('pickDiaryLine: 동점 id 비교는 코드 포인트 순서', diary.pickDiaryLine([bmp, emoji], DAY, 'mom')?.id === '\u{1F600}');
  const empty = diaryLine('e', DAY, 'dad', '', 500);
  const older = diaryLine('o', DAY, 'dad', '아빠글', 100);
  check('pickDiaryLine: 보여 줄 때는 고른 줄이 비면 아직 안 씀(null)', diary.pickDiaryLine([empty, older], DAY, 'dad') === null);
  check('pickDiaryLine: 저장할 때(includeEmpty)는 빈 줄도 고른다', diary.pickDiaryLine([empty, older], DAY, 'dad', { includeEmpty: true })?.id === 'e');
  check('pickDiaryLine: notes 없는 줄은 빈 본문', diary.pickDiaryLine([{ ...empty, notes: undefined }], DAY, 'dad') === null);
  check('pickDiaryLine: 다른 날짜·역할은 섞이지 않는다', diary.pickDiaryLine([a, b], '2026-10-31', 'mom') === null && diary.pickDiaryLine([a, b], DAY, 'dad') === null);
}

{
  const logs = [
    diaryLine('m1', DAY, 'mom', '엄마 옛 줄', 100),
    diaryLine('m2', DAY, 'mom', '엄마 새 줄', 200),
    diaryLine('m3', DAY, 'mom', '', 300), // 빈 줄이 가장 최근이면 묶음 전체가 안 씀
    diaryLine('d1', DAY, 'dad', '아빠 줄', 150),
    diaryLine('p1', '2026-10-31', 'mom', '어제 줄', 90),
    { id: 'c1', type: 'diaryComment', timestamp: 120, parentId: 'm1', diaryDate: DAY, authorRole: 'dad', notes: '숨은 줄에 단 댓글' },
    { id: 'c2', type: 'diaryComment', timestamp: 110, parentId: 'd1', diaryDate: DAY, authorRole: 'mom', notes: '아빠 줄에 단 댓글' },
    { id: 'c3', type: 'diaryComment', timestamp: 111, parentId: 'gone', diaryDate: DAY, authorRole: 'mom', notes: '부모 없는 댓글' },
  ];
  const groups = diary.groupDiaryByDate(logs);
  check('groupDiaryByDate: 최근 날짜부터, 빈 줄이 고른 묶음은 빠진다',
    groups.map((g) => g.date).join() === `${DAY},2026-10-31` && groups[0].entries.map((e) => e.role).join() === 'dad',
    JSON.stringify(groups.map((g) => [g.date, g.entries.map((e) => e.role)])));
  const logs2 = logs.filter((l) => l.id !== 'm3');
  const g2 = diary.groupDiaryByDate(logs2)[0];
  const momEntry = g2.entries.find((e) => e.role === 'mom');
  check('groupDiaryByDate: 아빠, 엄마 순서', g2.entries.map((e) => e.role).join() === 'dad,mom');
  check('groupDiaryByDate: 보이는 줄은 최근 줄, 숨은 줄은 따로 센다', momEntry.line.id === 'm2' && momEntry.hidden.map((l) => l.id).join() === 'm1');
  check('groupDiaryByDate: 숨은 줄에 달린 댓글도 보이는 줄 아래에 모은다(부모 없는 댓글은 안 나옴)',
    momEntry.comments.map((c) => c.id).join() === 'c1' && g2.entries.find((e) => e.role === 'dad').comments.map((c) => c.id).join() === 'c2');
  check('diaryGroupLines: 빈 줄을 포함해 고르는 순서대로', diary.diaryGroupLines(logs, DAY, 'mom').map((l) => l.id).join() === 'm3,m2,m1');
  const hiddenWithEmpty = diary.groupDiaryByDate([diaryLine('x1', DAY, 'mom', '본문', 200), diaryLine('x0', DAY, 'mom', '', 100)])[0].entries[0];
  check('숨은 줄 수에는 본문이 빈 줄을 넣지 않는다', hiddenWithEmpty.hidden.length === 0);
}

// ═════════ 형식 검사 ═════════
{
  const broken = [
    { id: 'b1', type: 'diary', timestamp: 1, authorRole: 'mom', notes: '날짜 없음' },
    { id: 'b2', type: 'diary', timestamp: 1, diaryDate: DAY, authorRole: 'uncle', notes: '역할 이상' },
    { id: 'b3', type: 'diary', timestamp: 1, diaryDate: DAY, authorRole: 'mom', notes: 123 },
    { id: 'b4', type: 'diary', timestamp: 1, diaryDate: '2026/11/01', authorRole: 'mom', notes: '날짜 모양 이상' },
    { id: 'b5', type: 'diaryComment', timestamp: 1, diaryDate: DAY, authorRole: 'mom', notes: '부모 없음' },
    { id: 'b6', type: 'diaryComment', timestamp: 1, parentId: 7, diaryDate: DAY, authorRole: 'mom', notes: '부모 id가 숫자' },
    null, 'text', 5,
  ];
  check('isDiaryLog/isDiaryComment: 깨진 기록은 모두 통과하지 못한다',
    broken.every((l) => !diary.isDiaryLog(l) && !diary.isDiaryComment(l)));
  check('isDiaryLog: notes가 없는 줄은 통과(빈 본문으로 본다)', diary.isDiaryLog({ id: 'n', type: 'diary', timestamp: 1, diaryDate: DAY, authorRole: 'dad' }));
  let threw = false;
  let picked = 'unset'; let groups = [];
  try {
    const mixed = [...broken, diaryLine('ok', DAY, 'mom', '정상', 10)];
    picked = diary.pickDiaryLine(mixed, DAY, 'mom')?.id;
    groups = diary.groupDiaryByDate(mixed);
    diary.diaryGroupLines(mixed, DAY, 'mom');
  } catch { threw = true; }
  check('깨진 일기를 섞어도 고르기·묶기가 예외 없이 그 기록을 무시한다', !threw && picked === 'ok' && groups.length === 1 && groups[0].entries.length === 1);
}

// ═════════ 저장 함수 ═════════
{
  // 새로 쓰기 → 같은 날 다시 쓰기
  await reset();
  const first = await save('오늘 처음 뒤집었다');
  let logs = await readLogsRaw();
  check('새로 쓰기: 줄 1개가 생기고 필드가 설계대로다',
    first && logs.length === 1 && diariesOf(logs).length === 1
    && first.type === 'diary' && first.diaryDate === DAY && first.authorRole === 'mom'
    && first.notes === '오늘 처음 뒤집었다' && first.timestamp === NOW && first.updatedAt === NOW
    && /^diary_20261101_mom_[0-9a-z]+$/.test(first.id), JSON.stringify(first));
  const second = await save('오늘은 두 번 뒤집었다', { now: NOW + 5000 });
  logs = await readLogsRaw();
  check('같은 날 다시 쓰기: 줄은 1개 그대로, 본문 교체, 같은 id, updatedAt 갱신',
    second && logs.length === 1 && logs[0].notes === '오늘은 두 번 뒤집었다' && logs[0].id === first.id
    && logs[0].updatedAt === NOW + 5000 && logs[0].timestamp === first.timestamp, JSON.stringify(logs));

  // 엄마·아빠가 같은 날
  const dad = await save('아빠도 한 줄', { role: 'dad' });
  logs = await readLogsRaw();
  check('엄마·아빠가 같은 날 쓰면 줄 2개', dad && diariesOf(logs).length === 2 && diariesOf(logs, DAY, 'dad').length === 1 && diariesOf(logs, DAY, 'mom').length === 1);

  // 지난 날짜
  const past = await save('어제 쓰는 일기', { date: '2026-10-30' });
  check('지난 날짜에 쓰면 timestamp가 그날 21:00(현지)', past && past.timestamp === new Date(2026, 9, 30, 21, 0).getTime() && past.updatedAt === NOW);

  // 삭제 후 다시 쓰기
  const removed = await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
  logs = await readLogsRaw();
  let profile = await readProfileRaw();
  check('내 줄 지우기: 그 줄이 빠지고 삭제 표식에 오른다(아빠 줄은 그대로)',
    removed === true && diariesOf(logs, DAY, 'mom').length === 0 && diariesOf(logs, DAY, 'dad').length === 1
    && (profile.deletedLogIds || []).includes(first.id));
  const again = await save('지운 뒤 다시 쓴 줄');
  logs = await readLogsRaw();
  profile = await readProfileRaw();
  check('삭제 후 다시 쓰기: 새 id가 지운 id와 다르고 화면 고르기에서 보인다',
    again && again.id !== first.id && !(profile.deletedLogIds || []).includes(again.id)
    && diary.pickDiaryLine(await storage.getLogs(), DAY, 'mom')?.id === again.id, JSON.stringify(again));
}

{
  // 1.8.0에서 메모를 지운 줄(본문 없음)
  const empty = { id: 'old-empty', type: 'diary', timestamp: NOW, updatedAt: NOW - 1000, diaryDate: DAY, authorRole: 'mom', notes: '' };
  await reset([empty, formula(1)]);
  const saved = await save('빈 줄을 고쳐 쓴다');
  const logs = await readLogsRaw();
  check('1.8.0에서 메모를 지운 줄: 저장하면 그 줄을 고치고 줄 수가 늘지 않는다',
    saved && saved.id === 'old-empty' && logs.length === 2 && logs.find((l) => l.id === 'old-empty').notes === '빈 줄을 고쳐 쓴다');
  // notes 필드가 아예 없는 줄도 같다
  const { notes: _drop, ...noNotes } = empty;
  await reset([noNotes]);
  const saved2 = await save('notes가 없던 줄');
  check('notes 필드가 없는 줄도 고친다', saved2 && saved2.id === 'old-empty' && (await readLogsRaw()).length === 1);
}

{
  // 같은 날짜·역할 줄 2개(동시 쓰기 흉내)
  const x = diaryLine('diary_20261101_mom_aaa', DAY, 'mom', '폰 A의 줄', 1000);
  const y = diaryLine('diary_20261101_mom_bbb', DAY, 'mom', '폰 B의 줄', 1000);
  const other = diaryLine('diary_20261101_dad_ccc', DAY, 'dad', '아빠 줄', 1000);
  const otherDay = diaryLine('diary_20261031_mom_ddd', '2026-10-31', 'mom', '어제', 1000);
  const comment = { id: 'cm1', type: 'diaryComment', timestamp: 2000, parentId: x.id, diaryDate: DAY, authorRole: 'dad', notes: '댓글' };
  await reset([x, y, other, otherDay, comment, formula(1)]);
  check('동시 쓰기 흉내: 동점이면 id가 큰 쪽을 고른다', diary.pickDiaryLine(await storage.getLogs(), DAY, 'mom')?.id === y.id);
  await setLogs([{ ...x, updatedAt: 3000 }, y, other, otherDay, comment, formula(1)]);
  check('동시 쓰기 흉내: 더 최근에 고친 줄이 이긴다', diary.pickDiaryLine(await storage.getLogs(), DAY, 'mom')?.id === x.id);
  const ok = await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
  const logs = await readLogsRaw();
  const profile = await readProfileRaw();
  check('deleteDiaryGroup: 같은 날짜·역할의 줄을 모두 지우고 삭제 표식에 올린다',
    ok && diariesOf(logs, DAY, 'mom').length === 0 && [x.id, y.id].every((id) => profile.deletedLogIds.includes(id)));
  check('deleteDiaryGroup: 다른 역할·다른 날짜의 일기, 댓글, 다른 기록은 그대로',
    logs.length === 4 && sameById([other, otherDay, comment, formula(1)], logs));
  check('deleteDiaryGroup: 줄이 없으면 아무것도 바꾸지 않고 true', await storage.deleteDiaryGroup({ diaryDate: '2026-01-01', role: 'dad' }) === true && sameById(logs, await readLogsRaw()));
}

{
  // 종류 조건: 같은 날짜·역할 필드를 가졌어도 일기가 아니면 지우지 않는다
  const lookalike = { id: 'urine-1', type: 'urine', timestamp: NOW, wetness: 'light', color: 'normal', diaryDate: DAY, authorRole: 'mom' };
  const commentSame = { id: 'cm-same', type: 'diaryComment', timestamp: NOW, parentId: 'zzz', diaryDate: DAY, authorRole: 'mom', notes: '내 댓글' };
  await reset([lookalike, commentSame, diaryLine('mine', DAY, 'mom', '내 줄', 10)]);
  await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
  const logs = await readLogsRaw();
  check('deleteDiaryGroup: type이 diary가 아닌 기록(소변, 댓글)은 날짜·역할이 같아도 지우지 않는다',
    logs.length === 2 && logs.some((l) => l.id === 'urine-1') && logs.some((l) => l.id === 'cm-same'));
}

{
  // 일기 아닌 기록 2,439건을 넣고 쓰기·삭제를 반복
  const base = Array.from({ length: 2439 }, (_, i) => formula(i));
  await reset(base);
  const baseProfile = await readProfileRaw();
  for (let round = 0; round < 6; round += 1) {
    const day = diary.shiftDiaryDate(DAY, -round);
    await save(`${round}번째 줄`, { date: day, role: 'mom', now: NOW + round });
    await save(`${round}번째 수정`, { date: day, role: 'mom', now: NOW + round + 1 });
    await save(`${round}번째 아빠`, { date: day, role: 'dad', now: NOW + round });
    if (round % 2 === 0) await storage.deleteDiaryGroup({ diaryDate: day, role: 'mom' });
  }
  const logs = await readLogsRaw();
  const nonDiary = logs.filter((l) => l.type !== 'diary');
  check('일기 아닌 기록 2,439건이 쓰기·삭제를 반복한 뒤에도 id별 내용이 같다', nonDiary.length === 2439 && sameById(base, nonDiary), `non-diary=${nonDiary.length}`);
  check('반복 뒤 일기 줄 수가 맞다(아빠 6 + 엄마 3)', logs.filter((l) => l.type === 'diary').length === 9);
  void baseProfile;
}

{
  // 글자 수
  await reset();
  check('201자는 거부(null)', await save('가'.repeat(201)) === null && (await readLogsRaw()).length === 0);
  check('공백만은 거부(null)', await save('   \n  ') === null && await save('') === null && (await readLogsRaw()).length === 0);
  const emoji200 = await save('😀'.repeat(200));
  check('이모지 200개는 허용', emoji200 && emoji200.notes === '😀'.repeat(200));
  check('이모지 201개는 거부', await save('😀'.repeat(201), { role: 'dad' }) === null);
  const trimmed = await save('   앞뒤 공백   ', { role: 'dad' });
  check('앞뒤 공백은 제거하고 저장', trimmed && trimmed.notes === '앞뒤 공백');
  check('이미 200자를 넘는 줄도 자르지 않고 보존한다(저장 시도는 거부)', await (async () => {
    const longLine = diaryLine('long', '2026-10-01', 'mom', '가'.repeat(230), 100);
    await reset([longLine]);
    const refused = await save('나'.repeat(230), { date: '2026-10-01' });
    return refused === null && (await readLogsRaw())[0].notes === '가'.repeat(230);
  })());
  check('잘못된 날짜·역할은 거부', await storage.saveDiaryLine({ diaryDate: '2026-1-1', role: 'mom', text: 'a', targetId: null }) === null
    && await storage.saveDiaryLine({ diaryDate: DAY, role: 'uncle', text: 'a', targetId: null }) === null);
}

{
  // 손상된 저장 값
  for (const [label, raw] of [
    ['JSON이 깨진 값', '{broken'],
    ['배열이 아닌 값', '{"a":1}'],
    ['일부 기록이 손상된 배열', JSON.stringify([formula(1), { id: 5, type: 'formula' }])],
  ]) {
    await AsyncStorage.clear();
    await rawStorage.setItem(LOGS_KEY, raw);
    const result = await save('쓰면 안 되는 글');
    check(`손상된 저장 값(${label}): null을 돌려주고 저장 값이 그대로다`, result === null && (await rawStorage.getItem(LOGS_KEY)) === raw);
    const del = await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
    check(`손상된 저장 값(${label}): 묶음 삭제도 false이고 저장 값이 그대로다`, del === false && (await rawStorage.getItem(LOGS_KEY)) === raw);
  }
  await AsyncStorage.clear();
  await setLogs([formula(1)]);
  await rawStorage.setItem(PROFILE_KEY, '[1,2');
  check('프로필이 손상됐으면 저장하지 않고 null', await save('글') === null && (await readLogsRaw()).length === 1);
}

{
  // 고치는 도중 같은 역할 줄이 도착
  await reset();
  const mine = await save('내가 쓴 줄');
  const targetId = await openTarget(DAY, 'mom'); // 입력 창을 열 때 고른 줄
  const arrived = diaryLine('diary_20261101_mom_zzzzzzz', DAY, 'mom', '동기화로 도착한 줄', NOW + 10_000);
  await setLogs([...(await readLogsRaw()), arrived]);
  const saved = await storage.saveDiaryLine({ diaryDate: DAY, role: 'mom', text: '고친 글', targetId, now: NOW + 20_000 });
  const logs = await readLogsRaw();
  check('고치는 도중 도착한 줄: targetId로 저장하면 도착한 줄의 본문이 그대로다',
    saved && saved.id === mine.id && logs.find((l) => l.id === arrived.id).notes === '동기화로 도착한 줄'
    && logs.find((l) => l.id === mine.id).notes === '고친 글' && logs.length === 2);

  // 처음 쓰는 도중 줄이 도착(targetId null)
  await reset([diaryLine('diary_20261101_mom_arrived', DAY, 'mom', '먼저 도착한 줄', NOW - 1000)]);
  const fresh = await storage.saveDiaryLine({ diaryDate: DAY, role: 'mom', text: '처음 쓴 줄', targetId: null, now: NOW });
  const logs2 = await readLogsRaw();
  check('처음 쓰는 도중 줄이 도착(targetId null): 두 줄 모두 남고 하나만 고른다',
    fresh && diariesOf(logs2, DAY, 'mom').length === 2
    && logs2.some((l) => l.id === 'diary_20261101_mom_arrived' && l.notes === '먼저 도착한 줄')
    && diary.pickDiaryLine(logs2, DAY, 'mom')?.id === fresh.id);

  // targetId가 있어도 그 사이에 지워졌으면 새 줄
  await reset();
  const gone = await save('곧 지워질 줄');
  await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
  const revived = await storage.saveDiaryLine({ diaryDate: DAY, role: 'mom', text: '지운 뒤 저장', targetId: gone.id, now: NOW + 1 });
  check('targetId의 줄이 그 사이 지워졌으면 새 id의 새 줄을 만든다', revived && revived.id !== gone.id && diariesOf(await readLogsRaw()).length === 1);

  // targetId의 날짜·역할이 입력과 다르면 새 줄
  await reset();
  const dadLine = await save('아빠 줄', { role: 'dad' });
  const asMom = await storage.saveDiaryLine({ diaryDate: DAY, role: 'mom', text: '역할을 바꿔 저장', targetId: dadLine.id, now: NOW + 1 });
  const logs3 = await readLogsRaw();
  check('입력 창을 연 채 역할을 바꾼 경우: 기존 줄은 그대로, 새 줄을 만든다',
    asMom && asMom.id !== dadLine.id && logs3.find((l) => l.id === dadLine.id).notes === '아빠 줄' && logs3.length === 2);
  const otherDate = await storage.saveDiaryLine({ diaryDate: '2026-10-31', role: 'dad', text: '날짜를 바꿔 저장', targetId: dadLine.id, now: NOW + 2 });
  check('날짜가 다르면 새 줄을 만든다', otherDate && otherDate.id !== dadLine.id && (await readLogsRaw()).find((l) => l.id === dadLine.id).notes === '아빠 줄');

  // targetId가 일기가 아닌 기록이면 건드리지 않는다
  await reset([formula(7)]);
  const viaFormula = await storage.saveDiaryLine({ diaryDate: DAY, role: 'mom', text: '엉뚱한 target', targetId: 'f7', now: NOW });
  const logs4 = await readLogsRaw();
  check('targetId가 일기가 아닌 기록이면 그 기록을 건드리지 않고 새 줄을 만든다',
    viaFormula && viaFormula.id !== 'f7' && storage.stableValue(logs4.find((l) => l.id === 'f7')) === storage.stableValue(formula(7)) && logs4.length === 2);
}

{
  // 새 id가 기존 id나 삭제 표식과 겹치면 다시 만든다
  const realRandom = Math.random;
  const collide = diary.makeDiaryId(DAY, 'mom', NOW, () => 0.123456);
  await reset([], { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, deletedLogIds: [collide] });
  const seq = [0.123456, 0.654321];
  Math.random = () => seq.shift() ?? realRandom();
  let created;
  try { created = await save('id가 겹치는 경우'); } finally { Math.random = realRandom; }
  check('새 id가 삭제 표식의 id와 겹치면 다시 만든다', created && created.id !== collide && !(await readProfileRaw()).deletedLogIds.includes(created.id), JSON.stringify(created));
  await reset([diaryLine(collide, '2026-01-01', 'dad', '기존 줄', 5)]);
  const seq2 = [0.123456, 0.654321];
  Math.random = () => seq2.shift() ?? realRandom();
  let created2;
  try { created2 = await save('id가 겹치는 경우 2'); } finally { Math.random = realRandom; }
  check('새 id가 목록의 id와 겹치면 다시 만들고 기존 줄은 그대로', created2 && created2.id !== collide && (await readLogsRaw()).find((l) => l.id === collide).notes === '기존 줄');
}

{
  // 깨진 일기 한 건을 섞어도 저장 뒤 그 기록이 그대로
  const broken = [
    { id: 'bk1', type: 'diary', timestamp: 5, authorRole: 'mom', notes: '날짜 없음' },
    { id: 'bk2', type: 'diary', timestamp: 6, diaryDate: DAY, authorRole: 'mom', notes: 42 },
    { id: 'bk3', type: 'diaryComment', timestamp: 7, diaryDate: DAY, authorRole: 'dad' },
  ];
  await reset([...broken, formula(1)]);
  const saved = await save('깨진 기록 옆에 쓴 줄');
  await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
  const logs = await readLogsRaw();
  check('깨진 일기를 섞어도 저장·삭제 뒤 그 기록이 그대로 남는다(지우지도 고치지도 않음)',
    saved && sameById([...broken, formula(1)], logs.filter((l) => l.id !== saved.id)) && logs.length === 4, JSON.stringify(logs.map((l) => l.id)));
}

{
  // 묶음 삭제는 기록과 프로필을 한 번에 저장한다(중간 실패 시 둘 다 그대로)
  const x = diaryLine('dg-1', DAY, 'mom', '줄 1', 10);
  const y = diaryLine('dg-2', DAY, 'mom', '줄 2', 20);
  await reset([x, y, formula(1)], { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, deletedLogIds: ['prev'] });
  const beforeLogs = await rawStorage.getItem(LOGS_KEY);
  const beforeProfile = await rawStorage.getItem(PROFILE_KEY);
  storageFaults.arm({ mode: 'reject', nth: 1, keys: [LOGS_KEY, PROFILE_KEY] });
  const failed = await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
  storageFaults.disarm();
  check('묶음 삭제: 저장이 실패하면 false이고 기록과 프로필이 모두 그대로다',
    failed === false && (await rawStorage.getItem(LOGS_KEY)) === beforeLogs && (await rawStorage.getItem(PROFILE_KEY)) === beforeProfile);
  storageFaults.arm({ mode: 'reject', nth: 1, keys: [LOGS_KEY] });
  const failedSave = await save('저장 실패', { role: 'dad' });
  storageFaults.disarm();
  check('saveDiaryLine: 저장이 실패하면 null이고 저장 값이 그대로다', failedSave === null && (await rawStorage.getItem(LOGS_KEY)) === beforeLogs);
  const okDel = await storage.deleteDiaryGroup({ diaryDate: DAY, role: 'mom' });
  const profile = await readProfileRaw();
  check('묶음 삭제: 성공하면 기존 삭제 표식을 유지하고 새 표식을 더한다', okDel && ['prev', 'dg-1', 'dg-2'].every((id) => profile.deletedLogIds.includes(id)));
  check('묶음 삭제는 공유 항목 시각을 올리지 않는다', (profile.sharedUpdatedAt ?? 0) === (JSON.parse(beforeProfile).sharedUpdatedAt ?? 0));
}

// ═════════ 프로필 역할 ═════════
{
  await AsyncStorage.clear();
  const badKept = [];
  for (const bad of ['uncle', 'DAD', 5, null, {}, true]) {
    await rawStorage.setItem(PROFILE_KEY, JSON.stringify({ name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, diaryRole: bad }));
    const p = await storage.getProfile();
    if (p.diaryRole !== undefined) badKept.push(JSON.stringify(bad));
  }
  check('normalizeProfile: 잘못된 역할(문자열, 숫자, null, 객체, 불리언)은 모두 지워진다', badKept.length === 0, badKept.join());
  for (const good of ['dad', 'mom']) {
    await rawStorage.setItem(PROFILE_KEY, JSON.stringify({ name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, diaryRole: good }));
    check(`normalizeProfile: 올바른 역할(${good})은 유지`, (await storage.getProfile()).diaryRole === good);
  }
  await storage.saveProfile({ ...(await storage.getProfile()), diaryRole: 'dad' });
  const p = await storage.getProfile();
  check('saveProfile: 역할만 바꿔도 공유 항목 시각은 오르지 않는다', p.diaryRole === 'dad' && p.sharedUpdatedAt === 0, `diaryRole=${p.diaryRole} shared=${p.sharedUpdatedAt}`);
  await storage.saveProfile({ ...p, diaryRole: 'uncle' });
  check('saveProfile: 잘못된 역할을 저장하면 지워진다', (await storage.getProfile()).diaryRole === undefined);
}

{
  // 가져오기와 로컬 백업 복원은 역할을 현재 기기 값으로 유지한다
  await reset([formula(1)], { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, diaryRole: 'mom', deletedLogIds: [] });
  const imported = await storage.importDataWithoutLoss(
    [formula(2)],
    { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, diaryRole: 'dad', deletedLogIds: [] },
  );
  check('가져오기: 백업 파일의 역할(아빠)이 현재 기기 역할(엄마)을 바꾸지 못한다',
    imported.profile.diaryRole === 'mom' && (await storage.getProfile()).diaryRole === 'mom' && imported.logs.length === 2);
  // 현재 기기에 역할이 없으면 백업의 역할을 가져오지도 않는다
  await reset([], { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, deletedLogIds: [] });
  const imported2 = await storage.importDataWithoutLoss([], { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, diaryRole: 'dad', deletedLogIds: [] });
  check('가져오기: 현재 기기에 역할이 없으면 백업의 역할도 들이지 않는다(기기 값 유지)', imported2.profile.diaryRole === undefined);

  // 로컬 백업 복원
  await reset([formula(1)], { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, diaryRole: 'dad', deletedLogIds: [] });
  await storage.backupLocalData(); // 백업에는 역할 dad가 들어 있다
  await rawStorage.setItem(PROFILE_KEY, JSON.stringify({ name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, diaryRole: 'mom', deletedLogIds: [] }));
  const restored = await storage.restoreFromLocalBackup();
  check('로컬 백업 복원: 백업의 역할이 아니라 현재 기기 역할을 유지한다',
    restored.success && restored.backup.profile.diaryRole === 'mom' && (await storage.getProfile()).diaryRole === 'mom');
}

// ═════════ 기존 화면에서 일기 거르기 ═════════
{
  const mixed = [
    formula(1), diaryLine('d1', DAY, 'mom', '줄', 10),
    { id: 'c1', type: 'diaryComment', timestamp: 11, parentId: 'd1', diaryDate: DAY, authorRole: 'dad', notes: '댓글' },
    { id: 'u1', type: 'urine', timestamp: 12, wetness: 'light', color: 'normal' },
    { id: 'bad', type: 'diary', timestamp: 13 }, // 깨진 일기도 종류가 diary라서 활동에서는 빠진다
  ];
  const before = JSON.stringify(mixed);
  const out = diary.withoutDiaryLogs(mixed);
  check('withoutDiaryLogs: 일기와 댓글을 빼고 활동 기록만 남기며 원본은 바꾸지 않는다',
    out.map((l) => l.id).join() === 'f1,u1' && JSON.stringify(mixed) === before);

  // 위젯 상태 문구: 마지막 기록이 일기나 댓글이어도 직전 활동 기록으로 정한다
  const reminder = await import(`${SRC}/utils/feedingReminder.ts`);
  const profile = { name: '아기', birthDate: '2026-01-01', birthWeight: '3.2', targetFormula: 800, feedingReminderEnabled: false, feedingIntervalMinutes: 180 };
  const t = Date.now();
  const urine = { id: 'u', type: 'urine', timestamp: t - 60_000, wetness: 'light', color: 'normal' };
  const newest = [
    { id: 'dc', type: 'diaryComment', timestamp: t - 1000, parentId: 'd', diaryDate: DAY, authorRole: 'mom', notes: '댓글' },
    diaryLine('d', DAY, 'mom', '오늘 한 줄', t - 2000),
    urine,
  ];
  check('위젯 상태 문구: 마지막 기록이 일기·댓글이어도 직전 활동(소변)으로 정한다',
    reminder.buildWidgetSnapshot(newest, profile, t).props.statusLabel === '쉬 했어요', reminder.buildWidgetSnapshot(newest, profile, t).props.statusLabel);
  check('위젯 상태 문구: 일기만 있으면 첫 기록을 기다린다',
    reminder.buildWidgetSnapshot(newest.slice(0, 2), profile, t).props.statusLabel === '첫 기록을 기다려요');

  // Dashboard와 Statistics는 화면 파일이라 소스로 확인합니다: 거르기 도우미를 불러 쓰고, 계산이 거른 목록을 쓴다.
  const dash = readFileSync(`${SRC}/screens/Dashboard.tsx`, 'utf8');
  check('Dashboard 타임라인: 자르기·빈 화면 판정·더 보기 건수가 모두 activityLogs로 계산된다',
    /const activityLogs = useMemo\(\(\) => withoutDiaryLogs\(logs\)/.test(dash)
    && /activityLogs\.slice\(0, visibleCount\)/.test(dash) && /activityLogs\.length === 0 \?/.test(dash)
    && /activityLogs\.length > visibleLogs\.length/.test(dash) && /\/ \{activityLogs\.length\}건/.test(dash)
    && !/\blogs\.slice\(0, visibleCount\)/.test(dash));
  const stats = readFileSync(`${SRC}/screens/Statistics.tsx`, 'utf8');
  check('Statistics: 맨 앞에서 일기·댓글을 뺀 목록을 만들어 모든 계산에 쓴다',
    /logs: allLogs/.test(stats) && /const logs = withoutDiaryLogs\(allLogs\)/.test(stats) && !/\ballLogs\.(filter|map|length)/.test(stats));
}

// ═════════ 네트워크 0회 ═════════
check('가족 연결 없이 저장 함수만 돌리는 동안 fetch 호출 0회', fetchCalls === 0, `fetch 호출 ${fetchCalls}회`);

// ═════════ 소스 검사 ═════════
{
  const diarySource = readFileSync(`${SRC}/utils/diary.ts`, 'utf8');
  check('diary.ts는 저장소·네트워크·React를 부르지 않는다(순수 함수만)',
    !/AsyncStorage|fetch\(|from\s+['"](react|react-native|expo-[^'"]*)['"]/.test(diarySource));
  const storageSource = readFileSync(`${SRC}/database/storage.ts`, 'utf8');
  check('SHARED_PROFILE_FIELDS에 diaryRole이 들어 있지 않다(가족 공유 항목이 아님)',
    !/SHARED_PROFILE_FIELDS\s*=\s*\[[^\]]*diaryRole/.test(storageSource));
  check('isDiaryType: 일기와 댓글만 참', isDiaryType('diary') && isDiaryType('diaryComment') && !isDiaryType('formula') && !isDiaryType('urine'));
}

const failed = results.filter((r) => !r.passed);
console.log(`\n==== 일기 단위 검증: ${results.length - failed.length}/${results.length} 통과 ====`);
process.exit(failed.length ? 1 : 0);
