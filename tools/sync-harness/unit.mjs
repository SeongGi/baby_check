// 네트워크 없이 프로필 공유시각 규칙만 검증합니다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const AsyncStorage = (await import('./stubs/async-storage.mjs')).default;
const storage = await import(`${SRC}/database/storage.ts`);

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

const failed = results.filter((r) => !r.passed);
console.log(`\n==== 단위 검증: ${results.length - failed.length}/${results.length} 통과 ====`);
process.exit(failed.length ? 1 : 0);
