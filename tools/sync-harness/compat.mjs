// 이미 클라우드/휴대폰에 들어 있는 예전 형식 데이터가 이번 수정으로 사라지지
// 않는지 확인합니다. 실사용자 데이터 보전이 목적이므로 가장 중요한 검증입니다.
import { randomUUID } from 'node:crypto';
import { Device, wait } from './client.mjs';

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const log = (msg) => console.log(`\n=== ${msg} ===`);

const KEY1 = `compat${randomUUID().replace(/-/g, '')}`;
const KEY2 = `compat${randomUUID().replace(/-/g, '')}`;

const A = new Device('CA');
const B = new Device('CB');
const C = new Device('CC');
const D = new Device('CD');

try {
  log('T1. 클라우드에 예전 형식(sharedUpdatedAt 없음) 프로필이 있는 가족');
  await A.send('setProfile', { patch: { syncKey: KEY1 } });
  await A.send('addLog', { log: { type: 'formula', amount: 130, timestamp: Date.now() } });
  await A.send('sync');

  // 현재 배포된 앱이 남겼을 법한 문서를 그대로 심습니다.
  const realProfile = {
    name: '진짜아기',
    birthDate: '2025-12-01',
    birthWeight: '3.4',
    targetFormula: 850,
    updatedAt: Date.now(),
  };
  await A.send('writeLegacySharedProfile', { patch: realProfile });

  await B.send('setProfile', { patch: { syncKey: KEY1 } });
  const b1 = await B.send('sync');
  check('새 기기가 예전 형식 클라우드 프로필을 그대로 받아온다',
    b1.profile?.name === '진짜아기' && b1.profile?.targetFormula === 850,
    JSON.stringify(b1.profile));

  const a1 = await A.send('sync');
  check('기존 기기도 예전 형식 프로필을 유지한다',
    a1.profile?.name === '진짜아기' && a1.profile?.targetFormula === 850,
    JSON.stringify(a1.profile));

  const cloud1 = await A.send('readSharedProfile');
  check('클라우드의 실제 프로필이 기본값으로 덮이지 않았다',
    cloud1.data?.name === '진짜아기' && cloud1.data?.targetFormula === 850,
    JSON.stringify(cloud1.data));

  log('T2. 휴대폰에 예전 형식(sharedUpdatedAt 없음) 로컬 프로필이 남아 있는 경우');
  await C.send('seedLegacyLocalProfile', {
    patch: {
      name: '기존아기',
      birthDate: '2025-11-11',
      birthWeight: '3.1',
      targetFormula: 770,
      syncKey: KEY2,
      updatedAt: Date.now(),
      deletedLogIds: [],
    },
  });
  await C.send('addLog', { log: { type: 'formula', amount: 140, timestamp: Date.now() } });
  const c1 = await C.send('sync');
  check('예전 로컬 프로필이 업데이트 후에도 그대로 남는다',
    c1.profile?.name === '기존아기' && c1.profile?.targetFormula === 770,
    JSON.stringify(c1.profile));

  await D.send('setProfile', { patch: { syncKey: KEY2 } });
  const d1 = await D.send('sync');
  check('새로 합류한 기기가 기존 프로필을 덮어쓰지 않는다',
    d1.profile?.name === '기존아기' && d1.profile?.targetFormula === 770,
    JSON.stringify(d1.profile));
  check('새 기기가 기존 기록도 받아온다', d1.logCount === 1, `logCount=${d1.logCount}`);

  const c2 = await C.send('sync');
  check('기존 기기의 프로필이 되돌려지지 않았다',
    c2.profile?.name === '기존아기' && c2.profile?.targetFormula === 770,
    JSON.stringify(c2.profile));

  log('T3. 기존 기기가 프로필을 수정하면 정상적으로 전파된다');
  await C.send('setProfile', { patch: { targetFormula: 820 } });
  await C.send('sync');
  const d2 = await D.send('sync');
  check('수정한 목표 수유량이 새 기기에 반영', d2.profile?.targetFormula === 820,
    JSON.stringify(d2.profile));

  log('T4. 반복 동기화 후에도 값이 안정적으로 유지된다');
  for (let i = 0; i < 3; i += 1) { await C.send('sync'); await D.send('sync'); }
  const c3 = await C.send('dump');
  const d3 = await D.send('dump');
  check('두 기기 프로필 일치 및 값 유지',
    c3.profile.name === '기존아기' && d3.profile.name === '기존아기' &&
    c3.profile.targetFormula === 820 && d3.profile.targetFormula === 820,
    `C=${JSON.stringify(c3.profile)} D=${JSON.stringify(d3.profile)}`);
  check('두 기기 기록 수 일치', c3.logCount === d3.logCount, `C=${c3.logCount} D=${d3.logCount}`);
} catch (error) {
  check('호환성 하네스 실행', false, error.message);
} finally {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n======== 호환성 결과: ${results.length - failed.length}/${results.length} 통과 ========`);
  failed.forEach((f) => console.log(`FAILED: ${f.name} — ${f.detail}`));
  await Promise.all([A, B, C, D].map((d) => d.send('quit').catch(() => undefined)));
  await wait(300);
  process.exit(failed.length ? 1 : 0);
}
