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
const mig = await import(`${SRC}/database/migrationDecision.ts`);
const { readFileSync } = await import('node:fs');

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

// ────────────── 기존 사용자 이전의 순수 판정(07 2.3, migrationDecision.ts) ──────────────
const MIN = 60_000;
const HOUR_MS = 60 * MIN;
const DAY_MS = 24 * HOUR_MS;

// 관문 규칙 1~6
const gateBase = { complete: false, hasEvidence: true };
check('decideMigrationGate 1: 연결 회차는 관문을 거치지 않는다(근거 있고 모름이어도)',
  mig.decideMigrationGate({ ...gateBase, connecting: true, d1Status: undefined }) === 'proceed'
  && mig.decideMigrationGate({ ...gateBase, connecting: true, d1Status: 'missing' }) === 'proceed');
check('decideMigrationGate 2: 이전이 끝났으면 proceed', mig.decideMigrationGate({ ...gateBase, complete: true, d1Status: 'missing' }) === 'proceed');
check('decideMigrationGate 3: deleted는 proceed(410 처리가 연결을 끊어야 함)', mig.decideMigrationGate({ ...gateBase, d1Status: 'deleted' }) === 'proceed');
check('decideMigrationGate 4: 근거가 없으면 proceed(1.8.0 가족)',
  mig.decideMigrationGate({ complete: false, hasEvidence: false, d1Status: undefined }) === 'proceed'
  && mig.decideMigrationGate({ complete: false, hasEvidence: false, d1Status: 'missing' }) === 'proceed');
check('decideMigrationGate 5: 근거 있고 exists면 proceed(mergeSource가 없어도)', mig.decideMigrationGate({ ...gateBase, d1Status: 'exists' }) === 'proceed');
check('decideMigrationGate 6: 근거 있고 missing이거나 모르면 paused',
  mig.decideMigrationGate({ ...gateBase, d1Status: 'missing' }) === 'paused' && mig.decideMigrationGate({ ...gateBase, d1Status: undefined }) === 'paused');
check('decideMigrationGate: 규칙은 위에서부터(완료가 paused보다 먼저, 연결 회차가 모든 것보다 먼저)',
  mig.decideMigrationGate({ complete: true, hasEvidence: true, d1Status: undefined }) === 'proceed'
  && mig.decideMigrationGate({ complete: false, hasEvidence: true, d1Status: 'deleted', connecting: true }) === 'proceed');

// 이전 완료와 근거
check('isMigrationComplete: mergedAt과 d1UploadedAt이 모두 있어야 완료',
  mig.isMigrationComplete({ mergedAt: 1, d1UploadedAt: 2 }) === true
  && mig.isMigrationComplete({ mergedAt: 1 }) === false && mig.isMigrationComplete({ d1UploadedAt: 2 }) === false
  && mig.isMigrationComplete({}) === false && mig.isMigrationComplete(null) === false);
check('hasLegacyEvidence: 표식 keys에 키가 있거나 legacyJoinedAt이 있으면 근거',
  mig.hasLegacyEvidence({ syncKey: 'K1', markerKeys: ['K1'] }) === true
  && mig.hasLegacyEvidence({ syncKey: ' K1 ', markerKeys: ['K1'] }) === true
  && mig.hasLegacyEvidence({ syncKey: 'K1', markerKeys: [], legacyJoinedAt: 5 }) === true
  && mig.hasLegacyEvidence({ syncKey: 'K1', markerKeys: ['K2'] }) === false
  && mig.hasLegacyEvidence({ syncKey: 'K1', markerKeys: null }) === false
  && mig.hasLegacyEvidence({ syncKey: 'K1' }) === false);

// 화면 판정 세 가지
check('shouldAlertOnRefresh: 실패면 경고창, migrationPending이면 경고창 없음',
  mig.shouldAlertOnRefresh({ success: false }) === true
  && mig.shouldAlertOnRefresh({ success: false, migrationPending: true }) === false
  && mig.shouldAlertOnRefresh({ success: true }) === false
  && mig.shouldAlertOnRefresh({ success: false, migrationPending: false }) === true);
check('shouldStartPolling: proceed일 때만', mig.shouldStartPolling('proceed') === true && mig.shouldStartPolling('paused') === false);
check('shouldCheckDeletionStatus: paused이면 거짓', mig.shouldCheckDeletionStatus('paused') === false && mig.shouldCheckDeletionStatus('proceed') === true);

// 실패 간격
check('failureDelayMs 가벼운 실패: 30분, 1시간, 2시간으로 늘고 최대 6시간',
  [1, 2, 3, 4, 5, 6, 40].map(n => mig.failureDelayMs('light', n)).join()
  === [30 * MIN, HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS].join());
check('failureDelayMs 무거운 실패: 1시간부터 두 배씩, 최대 12시간',
  [1, 2, 3, 4, 5, 6, 40].map(n => mig.failureDelayMs('heavy', n)).join()
  === [HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS, 8 * HOUR_MS, 12 * HOUR_MS, 12 * HOUR_MS, 12 * HOUR_MS].join());
const t0 = 1_700_000_000_000;
let sched = mig.nextFailureSchedule({ now: t0, weight: 'light' });
check('nextFailureSchedule: 첫 가벼운 실패는 30분 뒤, 횟수 1', sched.failureCount === 1 && sched.nextFirestoreAttemptAt === t0 + 30 * MIN);
sched = mig.nextFailureSchedule({ now: t0, weight: 'light', previousFailureCount: 2 });
check('nextFailureSchedule: 같은 종류가 이어지면 늘어난다(3번째 2시간)', sched.failureCount === 3 && sched.nextFirestoreAttemptAt === t0 + 2 * HOUR_MS);
sched = mig.nextFailureSchedule({ now: t0, weight: 'heavy', previousFailureCount: 0 });
check('nextFailureSchedule: 무거운 실패는 1시간부터(가벼운 간격으로 내려가지 않음)', sched.nextFirestoreAttemptAt === t0 + HOUR_MS);
sched = mig.nextFailureSchedule({ now: t0, weight: 'heavy', previousFailureCount: 4, progressed: true });
check('nextFailureSchedule: 진척이 있으면 횟수 0, 5분 뒤(간격을 늘리지 않음)', sched.failureCount === 0 && sched.nextFirestoreAttemptAt === t0 + 5 * MIN);
sched = mig.nextFailureSchedule({ now: Date.UTC(2026, 0, 15, 12), weight: 'light', quotaExhausted: true });
check('nextFailureSchedule: 할당량 소진은 태평양 시간 자정 뒤(가벼운 간격이 아님)',
  sched.nextFirestoreAttemptAt === Date.UTC(2026, 0, 16, 8) + MIN && sched.nextFirestoreAttemptAt !== Date.UTC(2026, 0, 15, 12) + 30 * MIN);
sched = mig.nextFailureSchedule({ now: t0, weight: 'heavy', previousFailureCount: 3, progressed: true, quotaExhausted: true });
check('nextFailureSchedule: 진척이 있어도 할당량 소진이면 자정 뒤', sched.nextFirestoreAttemptAt === mig.nextPacificMidnight(t0));
check('nextPacificMidnight: 겨울(PST, UTC-8)', mig.nextPacificMidnight(Date.UTC(2026, 0, 15, 12)) === Date.UTC(2026, 0, 16, 8) + MIN);
check('nextPacificMidnight: 여름(PDT, UTC-7)', mig.nextPacificMidnight(Date.UTC(2026, 6, 15, 12)) === Date.UTC(2026, 6, 16, 7) + MIN);
check('nextPacificMidnight: 서머타임 시작일(2026-03-08) 전후',
  mig.nextPacificMidnight(Date.UTC(2026, 2, 8, 5)) === Date.UTC(2026, 2, 8, 8) + MIN
  && mig.nextPacificMidnight(Date.UTC(2026, 2, 8, 12)) === Date.UTC(2026, 2, 9, 7) + MIN);
check('nextPacificMidnight: 서머타임 종료일(2026-11-01) 전후',
  mig.nextPacificMidnight(Date.UTC(2026, 10, 1, 5)) === Date.UTC(2026, 10, 1, 7) + MIN
  && mig.nextPacificMidnight(Date.UTC(2026, 10, 1, 12)) === Date.UTC(2026, 10, 2, 8) + MIN);
check('nextPacificMidnight: 항상 지금보다 뒤이고 하루 안(무작위 시각 400개)',
  Array.from({ length: 400 }, (_, i) => Date.UTC(2026, 0, 1) + i * 22 * HOUR_MS + i * 7 * MIN)
    .every(now => { const next = mig.nextPacificMidnight(now); return next > now && next - now <= DAY_MS + 2 * MIN; }));
check('nextPageSize: 절반으로 줄고 하한 50', mig.nextPageSize(500) === 250 && mig.nextPageSize(100) === 50 && mig.nextPageSize(60) === 50 && mig.nextPageSize(50) === 50);

// 거부와 종료
check('shouldGiveUpFirestoreRead: exists에서 14일 넘게 이어질 때만(missing은 멈추지 않음)',
  mig.shouldGiveUpFirestoreRead({ d1Status: 'exists', now: t0 + 14 * DAY_MS + 1, blockedSince: t0 }) === true
  && mig.shouldGiveUpFirestoreRead({ d1Status: 'exists', now: t0 + 14 * DAY_MS, blockedSince: t0 }) === false
  && mig.shouldGiveUpFirestoreRead({ d1Status: 'missing', now: t0 + 30 * DAY_MS, blockedSince: t0 }) === false
  && mig.shouldGiveUpFirestoreRead({ d1Status: 'exists', now: t0 + 30 * DAY_MS }) === false
  && mig.shouldGiveUpFirestoreRead({ d1Status: undefined, now: t0 + 30 * DAY_MS, blockedSince: t0 }) === false);
check('isBlockedLong: 7일 넘게 이어지면 안내 문구를 바꾼다',
  mig.isBlockedLong({ now: t0 + 7 * DAY_MS + 1, blockedSince: t0 }) === true
  && mig.isBlockedLong({ now: t0 + 7 * DAY_MS, blockedSince: t0 }) === false && mig.isBlockedLong({ now: t0 }) === false);

// 결정표(2.4-6)
const table = (d1, firestore) => mig.decideFamilyAction({ d1, firestore });
const allFirestoreStates = ['unread', 'not_due', 'merged_now', 'merged_before_ok', 'merged_before_skipped', 'denied', 'absent', 'pending_deletion', 'error'];
check('decideFamilyAction: deleted는 무엇이든 멈춘다', allFirestoreStates.every(f => table('deleted', f) === 'stop_deleted'));
check('decideFamilyAction: exists는 pending_deletion만 안내 화면이 붙고 나머지는 7번',
  allFirestoreStates.every(f => table('exists', f) === (f === 'pending_deletion' ? 'upload_with_prompt' : 'upload')));
check('decideFamilyAction: missing + 이번에 읽어 병합(ok) → 이어받기', table('missing', 'merged_now') === 'adopt');
check('decideFamilyAction: missing + 이전 시도의 병합(ok) → 가족 문서 재확인(4판 경미 7)', table('missing', 'merged_before_ok') === 'recheck_then_adopt');
check('decideFamilyAction: missing + 병합 완료(skipped) → 서버 이상, 이어받지 않는다', table('missing', 'merged_before_skipped') === 'server_anomaly');
check('decideFamilyAction: missing + pending_deletion/denied/absent/error',
  table('missing', 'pending_deletion') === 'choose_pending_deletion' && table('missing', 'denied') === 'denied'
  && table('missing', 'absent') === 'absent' && table('missing', 'error') === 'fail');
check('decideFamilyAction: missing + 읽지 않음/간격 전은 실패로 끝낸다(이어받지 않는다)', table('missing', 'not_due') === 'fail' && table('missing', 'unread') === 'fail');
check('decideFamilyAction: missing에서 adopt가 나오는 경우는 이번 병합뿐',
  allFirestoreStates.filter(f => table('missing', f) === 'adopt').join() === 'merged_now');

// 예약 안내 판정
check('shouldPromptPendingDeletion: 이미 물어본 값과 같으면 다시 묻지 않고, null이면 물을 일이 없다',
  mig.shouldPromptPendingDeletion({ pendingDeletionAt: 100 }) === true
  && mig.shouldPromptPendingDeletion({ pendingDeletionAt: 100, promptedPendingDeletionAt: 100 }) === false
  && mig.shouldPromptPendingDeletion({ pendingDeletionAt: 200, promptedPendingDeletionAt: 100 }) === true
  && mig.shouldPromptPendingDeletion({ pendingDeletionAt: null, promptedPendingDeletionAt: 100 }) === false
  && mig.shouldPromptPendingDeletion({ pendingDeletionAt: undefined }) === false);

// 전환기
const mergedAt = t0;
check('decideTransition: 시작 직후는 5분 간격, 끝나지 않음',
  JSON.stringify(mig.decideTransition({ now: mergedAt + HOUR_MS, mergedAt })) === JSON.stringify({ ended: false, intervalMs: 5 * MIN }));
check('decideTransition: 14일이 지나면 30분 간격',
  mig.decideTransition({ now: mergedAt + 14 * DAY_MS, mergedAt }).intervalMs === 30 * MIN
  && mig.decideTransition({ now: mergedAt + 14 * DAY_MS - 1, mergedAt }).intervalMs === 5 * MIN);
check('decideTransition: 상대를 본 뒤에는 30분 간격이고 24시간 동안은 끝나지 않는다(바로 끝내지 않음)',
  mig.decideTransition({ now: mergedAt + 2 * DAY_MS + 23 * HOUR_MS, mergedAt, partnerSeenAt: mergedAt + 2 * DAY_MS }).ended === false
  && mig.decideTransition({ now: mergedAt + 2 * DAY_MS + 23 * HOUR_MS, mergedAt, partnerSeenAt: mergedAt + 2 * DAY_MS }).intervalMs === 30 * MIN
  && mig.decideTransition({ now: mergedAt + 2 * DAY_MS, mergedAt, partnerSeenAt: mergedAt + 2 * DAY_MS }).ended === false);
check('decideTransition: 상대를 본 지 24시간이 지나면 끝(partner_grace)',
  mig.decideTransition({ now: mergedAt + 3 * DAY_MS, mergedAt, partnerSeenAt: mergedAt + 2 * DAY_MS }).reason === 'partner_grace');
check('decideTransition: 30일이 지나면 상대와 상관없이 끝(max_duration)',
  mig.decideTransition({ now: mergedAt + 30 * DAY_MS, mergedAt }).reason === 'max_duration'
  && mig.decideTransition({ now: mergedAt + 30 * DAY_MS - 1, mergedAt }).ended === false);
check('isPartnerSeen: otherMembers가 1 이상일 때만', mig.isPartnerSeen(1) === true && mig.isPartnerSeen(3) === true
  && mig.isPartnerSeen(0) === false && mig.isPartnerSeen(undefined) === false && mig.isPartnerSeen('1') === false);
check('isTransitionReadDue: 처음이거나 간격이 지났을 때',
  mig.isTransitionReadDue({ now: 10 * MIN, intervalMs: 5 * MIN }) === true
  && mig.isTransitionReadDue({ now: 10 * MIN, lastReadAt: 6 * MIN, intervalMs: 5 * MIN }) === false
  && mig.isTransitionReadDue({ now: 11 * MIN, lastReadAt: 6 * MIN, intervalMs: 5 * MIN }) === true);

// d1UploadedAt 판정(시나리오 20)
const up = (over) => mig.shouldMarkD1Uploaded({ eventRequestId: 5, uploadRequestId: 5, continuing: false, ledgerHasFull: false, ...over });
check('shouldMarkD1Uploaded: 번호가 같고 continuing이 거짓이고 full이 없을 때만',
  up({}) === true && up({ eventRequestId: 9 }) === true);
check('shouldMarkD1Uploaded: 7단계보다 먼저 시작한 회차(번호가 작음)는 걸러진다', up({ eventRequestId: 4 }) === false);
check('shouldMarkD1Uploaded: continuing이면 적지 않는다(첫 성공에 적지 않음)', up({ continuing: true }) === false);
check('shouldMarkD1Uploaded: 장부에 full이 남았거나 장부를 읽지 못하면 적지 않는다', up({ ledgerHasFull: true }) === false && up({ ledgerHasFull: undefined }) === false);
check('shouldMarkD1Uploaded: 7단계 요청 번호를 모르면 적지 않는다', up({ uploadRequestId: undefined }) === false);

// 소스 검사: 순수 모듈과 불변 조건
const decisionSource = readFileSync(`${SRC}/database/migrationDecision.ts`, 'utf8');
const migrationSource = readFileSync(`${SRC}/database/familyMigration.ts`, 'utf8');
check('migrationDecision.ts는 아무것도 불러오지 않는다(순수 함수만)', !/^\s*import\s/m.test(decisionSource) && !/\brequire\(/.test(decisionSource));
check('migrationDecision.ts는 저장소·네트워크·시계를 부르지 않는다', !/AsyncStorage|fetch\(|Date\.now\(|new Date\(\)|setTimeout|Math\.random/.test(decisionSource));
check('familyMigration.ts는 react, react-native, expo-*를 불러오지 않는다',
  !/from\s+['"](react|react-native|expo-[^'"]*|@react-native[^'"]*)['"]/.test(migrationSource));
check('familyMigration.ts는 firestoreImport와 firebase를 동적 import로만 부른다',
  !/^\s*import\s(?!type\b).*from\s+['"]\.\/(firestoreImport|firebase)['"]/m.test(migrationSource)
  && /import\('\.\/firestoreImport'\)/.test(migrationSource));
check('이전 모듈 소스에 Firestore 문서를 지우는 코드가 없다(불변 조건 2)',
  !/deleteDoc|writeBatch|\.delete\(/.test(migrationSource + decisionSource));

const failed = results.filter((r) => !r.passed);
console.log(`\n==== 단위 검증: ${results.length - failed.length}/${results.length} 통과 ====`);
process.exit(failed.length ? 1 : 0);
