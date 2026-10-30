// 네트워크 없이 프로필 공유시각 규칙만 검증합니다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const AsyncStorage = (await import('./stubs/async-storage.mjs')).default;
const storage = await import(`${SRC}/database/storage.ts`);
const { compareCodePoints } = await import(`${SRC}/utils/compareCodePoints.ts`);
const { utf8ByteLength } = await import(`${SRC}/utils/utf8.ts`);
const decision = await import(`${SRC}/database/syncDecision.ts`);
const { isCoalescibleSync } = await import(`${SRC}/database/syncRunner.ts`);

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await AsyncStorage.clear();

// 1. 새 설치: 저장된 프로필이 없으면 공유 시각은 0 이어야 합니다.
let p = await storage.getProfile();
check('새 설치의 공유 시각은 0', p.sharedUpdatedAt === 0, `sharedUpdatedAt=${p.sharedUpdatedAt}`);

// 2. syncKey 만 붙여 저장 → 공유 항목은 그대로이므로 공유 시각이 오르면 안 됩니다.
await storage.saveProfile({ ...p, syncKey: 'abc123' });
p = await storage.getProfile();
check('가족 연결만 했을 때 공유 시각이 오르지 않는다', p.sharedUpdatedAt === 0, `sharedUpdatedAt=${p.sharedUpdatedAt}`);

// 3. 알림 설정만 변경 → 공유 시각 유지
await storage.saveProfile({ ...p, feedingReminderEnabled: true, feedingIntervalMinutes: 200 });
p = await storage.getProfile();
check('알림 설정 변경은 공유 시각을 올리지 않는다', p.sharedUpdatedAt === 0, `sharedUpdatedAt=${p.sharedUpdatedAt}`);

// 4. 기록 삭제(내부적으로 saveProfile 호출) → 공유 시각 유지
await storage.saveLogs([{ id: 'x1', type: 'formula', amount: 100, timestamp: Date.now() }]);
await storage.deleteLog('x1');
p = await storage.getProfile();
check('기록 삭제는 공유 시각을 올리지 않는다', p.sharedUpdatedAt === 0, `sharedUpdatedAt=${p.sharedUpdatedAt}`);
check('삭제 기록이 tombstone 에 남는다', (p.deletedLogIds || []).includes('x1'), JSON.stringify(p.deletedLogIds));

// 5. 실제 이름 변경 → 공유 시각이 올라야 합니다.
await storage.saveProfile({ ...p, name: '새이름' });
p = await storage.getProfile();
check('이름 변경은 공유 시각을 올린다', p.sharedUpdatedAt > 0, `sharedUpdatedAt=${p.sharedUpdatedAt}`);
const afterName = p.sharedUpdatedAt;

// 6. 목표 수유량을 문자열 파싱 결과로 저장(화면과 동일 경로) → 공유 시각이 올라야 합니다.
await new Promise((r) => setTimeout(r, 5));
await storage.saveProfile({ ...p, targetFormula: parseInt('950') });
p = await storage.getProfile();
check('목표 수유량 변경이 감지된다', p.sharedUpdatedAt > afterName && p.targetFormula === 950,
  `${afterName} -> ${p.sharedUpdatedAt}, targetFormula=${p.targetFormula}`);
const afterGoal = p.sharedUpdatedAt;

// 7. 출생체중을 parseFloat().toString() 경로로 같은 값 재저장 → 오르면 안 됩니다.
await storage.saveProfile({ ...p, birthWeight: parseFloat(p.birthWeight).toString() });
p = await storage.getProfile();
check('같은 값 재저장은 공유 시각을 올리지 않는다', p.sharedUpdatedAt === afterGoal, `${afterGoal} -> ${p.sharedUpdatedAt}`);

// 8. 예전 형식(공유 시각 없음) 프로필 이관: updatedAt 을 물려받아야 합니다.
await AsyncStorage.setItem('@baby_profile', JSON.stringify({
  name: '기존아기', birthDate: '2025-10-10', birthWeight: '3.3', targetFormula: 780,
  syncKey: 'zz', updatedAt: 1700000000000,
}));
p = await storage.getProfile();
check('예전 프로필은 updatedAt 을 공유 시각으로 물려받는다', p.sharedUpdatedAt === 1700000000000,
  `sharedUpdatedAt=${p.sharedUpdatedAt}`);
check('예전 프로필 값이 보존된다', p.name === '기존아기' && p.targetFormula === 780, JSON.stringify(p));

// 9. 이관 직후 로컬 전용 변경 → 공유 시각 유지되어야 합니다.
await storage.saveProfile({ ...p, feedingReminderEnabled: true });
p = await storage.getProfile();
check('이관 후 로컬 변경이 공유 시각을 바꾸지 않는다', p.sharedUpdatedAt === 1700000000000,
  `sharedUpdatedAt=${p.sharedUpdatedAt}`);

// 10. 표기만 다른 값(3.30 vs 3.3, "780" vs 780)은 변경으로 보지 않아야 합니다.
const before10 = p.sharedUpdatedAt;
await new Promise((r) => setTimeout(r, 5));
await storage.saveProfile({ ...p, birthWeight: '3.30', targetFormula: '780' });
p = await storage.getProfile();
check('표기 차이는 공유 시각을 올리지 않는다', p.sharedUpdatedAt === before10,
  `${before10} -> ${p.sharedUpdatedAt}`);

// 11. 프로필 읽기 실패로 기본값이 들어와도 진짜 값이 지켜져야 합니다.
await new Promise((r) => setTimeout(r, 5));
await storage.saveProfile({
  name: '희성이', birthDate: new Date().toISOString().split('T')[0],
  birthWeight: '3.2', targetFormula: 800, deletedLogIds: ['zz1'],
});
p = await storage.getProfile();
check('기본값 프로필이 기존 아기 정보를 덮어쓰지 않는다',
  p.name === '기존아기' && p.targetFormula === 780 && p.birthDate === '2025-10-10',
  JSON.stringify({ name: p.name, targetFormula: p.targetFormula, birthDate: p.birthDate }));
check('기본값 저장이 공유 시각을 올리지 않는다', p.sharedUpdatedAt === before10,
  `${before10} -> ${p.sharedUpdatedAt}`);
check('공유 항목 외 값(tombstone)은 정상 반영', (p.deletedLogIds || []).includes('zz1'),
  JSON.stringify(p.deletedLogIds));

// 12. 진짜 변경은 여전히 통과해야 합니다.
await new Promise((r) => setTimeout(r, 5));
await storage.saveProfile({ ...p, name: '바뀐아기' });
p = await storage.getProfile();
check('보호 장치가 진짜 변경까지 막지는 않는다',
  p.name === '바뀐아기' && p.sharedUpdatedAt > before10,
  `name=${p.name} sharedUpdatedAt=${p.sharedUpdatedAt}`);

// 13. 느린 서버 응답 저장과 새 로컬 기록이 동시에 끝나도 둘 중 하나가 사라지면 안 됩니다.
await storage.saveLogs([]);
p = await storage.getProfile();
const remoteLog = { id: 'remote-race', type: 'formula', amount: 120, timestamp: Date.now() - 1000 };
const [, localLog] = await Promise.all([
  storage.saveSyncedDataWithoutLoss([remoteLog], p),
  storage.addLog({ type: 'urine', wetness: 'medium', color: 'normal', timestamp: Date.now() }),
]);
let racedLogs = await storage.getLogs();
check('동기화 저장과 기록 추가가 겹쳐도 두 기록을 모두 보존',
  racedLogs.some(log => log.id === remoteLog.id) && racedLogs.some(log => log.id === localLog?.id),
  JSON.stringify(racedLogs.map(log => log.id)));

// 14. 삭제와 동기화가 겹쳐도 tombstone이 이겨 삭제 기록이 되살아나면 안 됩니다.
const deleteTarget = racedLogs.find(log => log.id === remoteLog.id);
const profileBeforeDeleteRace = await storage.getProfile();
await Promise.all([
  storage.deleteLog(remoteLog.id),
  storage.saveSyncedDataWithoutLoss(deleteTarget ? [deleteTarget] : [], profileBeforeDeleteRace),
]);
racedLogs = await storage.getLogs();
p = await storage.getProfile();
check('동기화와 겹친 삭제가 되살아나지 않는다',
  !racedLogs.some(log => log.id === remoteLog.id) && (p.deletedLogIds || []).includes(remoteLog.id),
  `logs=${JSON.stringify(racedLogs.map(log => log.id))}, deleted=${JSON.stringify(p.deletedLogIds)}`);

// 15. 백업을 내보낸 후 삭제한 기록은 명시적으로 다시 가져오면 복원돼야 합니다.
const original = await storage.addLog({ type: 'formula', amount: 90, timestamp: Date.now() });
const exportedLogs = await storage.getLogs();
const exportedProfile = await storage.getProfile();
await storage.deleteLog(original.id);
await storage.importDataWithoutLoss(exportedLogs, exportedProfile);
let restoredLogs = await storage.getLogs();
let restored = restoredLogs.filter(log => log.type === 'formula' && log.amount === 90 && log.timestamp === original.timestamp);
check('백업 가져오기로 삭제된 기록을 다시 복원', restored.length === 1 && restored[0].id !== original.id,
  JSON.stringify(restored.map(log => log.id)));
check('원본 삭제 표식은 유지', (await storage.getProfile()).deletedLogIds.includes(original.id));

// 16. 같은 백업을 반복해서 가져와도 중복을 만들지 않고, 같은 원본 ID의
// 수정된 백업 기록은 별개의 복원본으로 남깁니다.
await storage.importDataWithoutLoss(exportedLogs, exportedProfile);
restoredLogs = await storage.getLogs();
restored = restoredLogs.filter(log => log.type === 'formula' && log.amount === 90 && log.timestamp === original.timestamp);
check('같은 백업 반복 가져오기는 중복 기록을 만들지 않는다', restored.length === 1,
  JSON.stringify(restored.map(log => log.id)));
await storage.importDataWithoutLoss(
  exportedLogs.map(log => log.id === original.id ? { ...log, amount: 110 } : log),
  exportedProfile,
);
restoredLogs = await storage.getLogs();
check('원본 ID가 같아도 내용이 다른 백업 기록을 보존',
  restoredLogs.some(log => log.id === restored[0]?.id)
    && restoredLogs.some(log => log.type === 'formula' && log.amount === 110 && log.id !== original.id),
  JSON.stringify(restoredLogs.filter(log => log.type === 'formula').map(log => ({ id: log.id, amount: log.amount }))));


// ────────────── 06 설계 A3: 순수 함수 ──────────────
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// compareCodePoints: UTF-16 순서와 코드 포인트 순서가 갈리는 쌍(이모지 vs U+FF01)
check('compareCodePoints: 😀(U+1F600)는 ！(U+FF01)보다 크다', compareCodePoints('😀', '！') > 0 && '😀' < '！',
  `cp=${compareCodePoints('😀', '！')}, utf16 비교는 반대`);
check('compareCodePoints: 같음/접두사/ASCII',
  compareCodePoints('a', 'a') === 0 && compareCodePoints('a', 'ab') < 0 && compareCodePoints('b', 'a') > 0 && compareCodePoints('', '') === 0);
check('compareCodePoints: 앞부분이 같은 보충 문자 뒤 비교', compareCodePoints('😀a', '😀b') < 0 && compareCodePoints('😀', '😀a') < 0);

// utf8ByteLength: Node Buffer.byteLength 와 대조
const samples = ['', 'abc', '가나다', '😀', 'a가😀b', '\u0080߿ࠀ￿', '한글'.repeat(1000), '😀'.repeat(50), '\ud800', 'a\udc00b', '\ud83d', '😀\ud83d'];
const mismatches = samples.filter(text => utf8ByteLength(text) !== Buffer.byteLength(text, 'utf8'));
check('utf8ByteLength: Buffer.byteLength 와 같다 (한글, 이모지, 짝 없는 서로게이트)', mismatches.length === 0,
  mismatches.map(t => `${JSON.stringify(t.slice(0, 6))}:${utf8ByteLength(t)}!=${Buffer.byteLength(t)}`).join(' '));
check('utf8ByteLength: 짝 없는 서로게이트는 3바이트', utf8ByteLength('\ud800') === 3 && utf8ByteLength('\udc00') === 3);

// isCompleteSharedProfile
const completeProfile = { name: '', birthDate: '2024-01-01', birthWeight: '3.2', targetFormula: 800 };
check('isCompleteSharedProfile: 빈 문자열 이름은 완전하다', decision.isCompleteSharedProfile(completeProfile));
check('isCompleteSharedProfile: {} / 일부 항목 / 형식 오류는 불완전',
  !decision.isCompleteSharedProfile({}) && !decision.isCompleteSharedProfile({ name: 'a' })
  && !decision.isCompleteSharedProfile({ ...completeProfile, targetFormula: '800' })
  && !decision.isCompleteSharedProfile({ ...completeProfile, targetFormula: NaN })
  && !decision.isCompleteSharedProfile({ ...completeProfile, name: undefined })
  && !decision.isCompleteSharedProfile(null) && !decision.isCompleteSharedProfile('x') && !decision.isCompleteSharedProfile([]));

// nextStepAfterFailure 표 전체 (2.6.2)
const stepTable = [
  ['pull', 'tooLarge', 'skipPull'], ['pull', 'serverError', 'skipPull'], ['pull', 'timeout', 'skipPull'],
  ['push', 'tooLarge', 'skipPushAndIncremental'], ['push', 'serverError', 'skipPushAndIncremental'], ['push', 'timeout', 'skipPushAndIncremental'],
  ['pull', 'network', 'endRound'], ['push', 'network', 'endRound'],
  ['pull', 'notFound', 'endRound'], ['push', 'notFound', 'endRound'], ['pull', 'gone', 'endRound'], ['push', 'gone', 'endRound'],
  ['pull', 'clientError', 'skipPull'], ['push', 'clientError', 'skipPush'],
];
const stepMismatch = stepTable.filter(([stage, failure, expected]) => decision.nextStepAfterFailure(stage, failure) !== expected);
check('nextStepAfterFailure: 표 전체', stepMismatch.length === 0, JSON.stringify(stepMismatch));
const err = (status, extra) => Object.assign(new Error('x'), { status, ...extra });
check('classifyFailure: 상태 코드와 시간 초과와 네트워크',
  decision.classifyFailure(err(413)) === 'tooLarge' && decision.classifyFailure(err(503)) === 'serverError'
  && decision.classifyFailure(err(500)) === 'serverError' && decision.classifyFailure(err(404)) === 'notFound'
  && decision.classifyFailure(err(410)) === 'gone' && decision.classifyFailure(err(400)) === 'clientError'
  && decision.classifyFailure(err(401)) === 'clientError' && decision.classifyFailure(err(undefined, { isTimeout: true })) === 'timeout'
  && decision.classifyFailure(new TypeError('Network request failed')) === 'network');

// nextLimits 경계값
const L = (o = {}) => ({ push: 400, pull: 500, pushStreak: 0, pullStreak: 0, ...o });
let n = decision.nextLimits(L(), { kind: 'push', result: 'failure', failure: 'serverError' });
check('nextLimits: 503은 올리기 크기를 절반(400→200)으로, 연속 성공을 끊는다', n.push === 200 && n.pull === 500 && n.pushStreak === 0, JSON.stringify(n));
check('nextLimits: 413과 시간 초과도 절반',
  decision.nextLimits(L(), { kind: 'pull', result: 'failure', failure: 'tooLarge' }).pull === 250
  && decision.nextLimits(L(), { kind: 'pull', result: 'failure', failure: 'timeout' }).pull === 250);
check('nextLimits: 하한 25 아래로 줄지 않는다',
  decision.nextLimits(L({ push: 30 }), { kind: 'push', result: 'failure', failure: 'serverError' }).push === 25
  && decision.nextLimits(L({ push: 25 }), { kind: 'push', result: 'failure', failure: 'serverError' }).push === 25);
check('nextLimits: 네트워크 끊김과 404/410/4xx는 크기를 그대로 둔다',
  ['network', 'notFound', 'gone', 'clientError'].every(failure => decision.nextLimits(L({ push: 200 }), { kind: 'push', result: 'failure', failure }).push === 200));
let g = L({ push: 100, pushStreak: 8 });
g = decision.nextLimits(g, { kind: 'push', result: 'success' });
check('nextLimits: 9번째 성공은 늘리지 않는다', g.push === 100 && g.pushStreak === 9);
g = decision.nextLimits(g, { kind: 'push', result: 'success' });
check('nextLimits: 연속 10번 성공하면 두 배(100→200), 횟수는 0', g.push === 200 && g.pushStreak === 0, JSON.stringify(g));
check('nextLimits: 늘린 값은 기본값 400을 넘지 않는다', decision.nextLimits(L({ push: 300, pushStreak: 9 }), { kind: 'push', result: 'success' }).push === 400);
let h = decision.nextLimits(L({ push: 100, pushStreak: 9 }), { kind: 'push', result: 'success', hints: { maxPushItems: 100, maxPageRows: 250 } });
check('nextLimits: 서버 힌트를 저장하고 늘린 값이 힌트를 넘지 않는다', h.push === 100 && h.serverPush === 100 && h.serverPull === 250, JSON.stringify(h));
check('effectiveLimit: min(장부 값, 서버 힌트), 하한 25',
  decision.effectiveLimit(L({ serverPush: 100 }), 'push') === 100 && decision.effectiveLimit(L({ serverPull: 10 }), 'pull') === 25
  && decision.effectiveLimit(undefined, 'push') === 400 && decision.effectiveLimit(undefined, 'pull') === 500);
check('nextLimits: 입력을 바꾸지 않는다', (() => { const input = L(); decision.nextLimits(input, { kind: 'push', result: 'failure', failure: 'serverError' }); return input.push === 400; })());

// decideAfterSync
const ok = (extra = {}) => ({ success: true, ...extra });
const bad = (extra = {}) => ({ success: false, error: 'e', ...extra });
const ctx = (extra = {}) => ({ connecting: false, timedOut: false, storedKeyMatches: false, ...extra });
check('decideAfterSync: 410은 연결 해제', decision.decideAfterSync(bad({ familyUnavailable: true }), ctx()).action === 'disconnect');
check('decideAfterSync: 합류 중 410은 키를 남기지 않는 실패(영구 삭제 문구)',
  eq(decision.decideAfterSync(bad({ familyUnavailable: true }), ctx({ connecting: true, storedKeyMatches: true })),
    { action: 'failure', error: decision.GONE_JOIN_MESSAGE }));
const nf = decision.decideAfterSync(bad({ familyNotFound: true }), ctx({ storedKeyMatches: true }));
check('decideAfterSync: 404는 오류 표시이고 연결을 끊지 않는다', nf.action === 'failure' && nf.error === decision.NOT_FOUND_MESSAGE);
check('decideAfterSync: 합류 중 404는 저장소 판정을 하지 않고 합류 실패',
  eq(decision.decideAfterSync(bad({ familyNotFound: true }), ctx({ connecting: true, storedKeyMatches: true })),
    { action: 'failure', error: decision.JOIN_NOT_FOUND_MESSAGE }));
check('decideAfterSync: 연결 회차가 실패해도 키가 저장돼 있으면 성공과 이어 가기',
  eq(decision.decideAfterSync(bad(), ctx({ connecting: true, storedKeyMatches: true })), { action: 'success', continueSync: true, recovered: true }));
check('decideAfterSync: 연결 회차 상한(timedOut)도 같은 판정',
  decision.decideAfterSync(bad(), ctx({ connecting: true, timedOut: true, storedKeyMatches: true })).action === 'success');
check('decideAfterSync: 저장된 키가 없으면 연결 회차 실패는 실패',
  decision.decideAfterSync(bad(), ctx({ connecting: true, storedKeyMatches: false })).action === 'failure');
check('decideAfterSync: 평소 회차는 저장소 판정을 하지 않는다',
  decision.decideAfterSync(bad(), ctx({ connecting: false, storedKeyMatches: true })).action === 'failure');
check('decideAfterSync: continuing 이고 progressed 이면 이어 간다',
  decision.decideAfterSync(ok({ continuing: true, progressed: true }), ctx()).continueSync === true);
check('decideAfterSync: continuing: true, progressed: false 이면 이어 가지 않는다',
  decision.decideAfterSync(ok({ continuing: true, progressed: false }), ctx()).continueSync === false);
check('decideAfterSync: continuing 이 없으면 이어 가지 않는다', decision.decideAfterSync(ok({ progressed: true }), ctx()).continueSync === false);
check('decideAfterSync: uploadStalled / pullTooSlow 문구',
  decision.decideAfterSync(bad({ uploadStalled: true }), ctx()).error === decision.UPLOAD_STALLED_MESSAGE
  && decision.decideAfterSync(bad({ pullTooSlow: true }), ctx()).error === decision.PULL_TOO_SLOW_MESSAGE);
check('decideAfterSync: 큰 기록이 있으면 성공이면서 안내 문구',
  decision.decideAfterSync(ok({ oversizedIds: ['a'] }), ctx()).notice === decision.OVERSIZED_MESSAGE);

// decideAfterTokenError
check('decideAfterTokenError: 410은 폴링을 멈추고 동기화, 404와 그 밖은 재연결',
  decision.decideAfterTokenError(err(410)).action === 'syncNow' && decision.decideAfterTokenError(err(404)).action === 'reconnect'
  && decision.decideAfterTokenError(new Error('x')).action === 'reconnect' && decision.decideAfterTokenError(null).action === 'reconnect');

// isCoalescibleSync: 네 선택이 각각 켜지면 거짓
check('isCoalescibleSync: 평소 동기화만 합친다',
  isCoalescibleSync({ syncKey: 'k' }) === true
  && ['createBackup', 'allowFamilyCreation', 'connecting', 'forceFullRead'].every(option => isCoalescibleSync({ syncKey: 'k', [option]: true }) === false));

// 타이브레이커: 같은 updatedAt 이면 코드 포인트 순서로 큰 canonical JSON 이 이긴다(서버와 같음)
await storage.saveLogs([{ id: 'tie', type: 'formula', amount: 1, timestamp: 5, updatedAt: 7, notes: '！' }]);
let tieProfile = await storage.getProfile();
await storage.saveSyncedDataWithoutLoss([{ id: 'tie', type: 'formula', amount: 1, timestamp: 5, updatedAt: 7, notes: '😀' }], tieProfile);
check('저장 병합 타이브레이커: 😀가 ！를 이긴다(UTF-16 비교라면 반대)',
  (await storage.getLogs()).find(log => log.id === 'tie').notes === '😀');
await storage.saveSyncedDataWithoutLoss([{ id: 'tie', type: 'formula', amount: 1, timestamp: 5, updatedAt: 7, notes: '！' }], tieProfile);
check('저장 병합 타이브레이커: 순서와 상관없이 같은 쪽', (await storage.getLogs()).find(log => log.id === 'tie').notes === '😀');

const failed = results.filter((r) => !r.passed);
console.log(`\n==== 단위 검증: ${results.length - failed.length}/${results.length} 통과 ====`);
process.exit(failed.length ? 1 : 0);
