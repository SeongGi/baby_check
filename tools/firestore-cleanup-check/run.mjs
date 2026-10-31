#!/usr/bin/env node
// 운영자 정리 전 점검 실행 진입점(07 2.8). 읽기 전용이며 성기님 승인 전에는 실행하지 않습니다.
//   node run.mjs --keys-file <경로> [--db <D1 이름>]
// 키 파일은 한 줄에 가족 키 하나(빈 줄과 # 줄은 무시). 키와 해시는 길이와 앞 4자만 출력합니다.
// 종료 코드: 0 통과, 1 차이 있음(정리 금지), 2 사용법 오류나 읽기 실패.
import { readFileSync } from 'node:fs';
import { runCleanupCheck } from './compare.mjs';
import { hint } from './hash.mjs';

const usage = () => {
  console.error('사용법: node run.mjs --keys-file <경로> [--db <D1 데이터베이스 이름>]');
  console.error('환경 변수 GOOGLE_APPLICATION_CREDENTIALS에 서비스 계정 JSON 경로가 필요합니다.');
  process.exit(2);
};

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const keysFile = option('--keys-file');
if (!keysFile) usage();
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) usage();

const keys = readFileSync(keysFile, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
if (keys.length === 0) {
  console.error('키 파일에 키가 없습니다.');
  process.exit(2);
}

const STATUS_LABEL = { ok: '통과', diff: '차이', deleted: '삭제됨', unpaired: '짝 없음' };
const describeIds = (ids) => (ids.length <= 5 ? ids.join(', ') : `${ids.slice(0, 5).join(', ')} 외 ${ids.length - 5}건`);

try {
  const { createRealSource } = await import('./sources.mjs');
  const source = await createRealSource(option('--db') ? { database: option('--db') } : {});
  const { families, failedCount } = await runCleanupCheck({ keys, source });

  console.log(`가족 ${families.length}개, 키 ${keys.length}개 입력`);
  console.log(['상태', 'Firestore 가족 id', '키'].join('\t'));
  for (const family of families) {
    console.log([STATUS_LABEL[family.status], hint(family.firestoreFamilyId), family.keyHint ?? '-'].join('\t'));
    if (family.diff) {
      const { missing, staleUpdates, tombstoneMissing } = family.diff;
      if (missing.length) console.log(`  D1에 없는 기록 ${missing.length}건: ${describeIds(missing)}`);
      if (staleUpdates.length) console.log(`  D1이 더 오래된 수정본 ${staleUpdates.length}건: ${describeIds(staleUpdates)}`);
      if (tombstoneMissing.length) console.log(`  D1에 삭제 표식이 없는 기록 ${tombstoneMissing.length}건: ${describeIds(tombstoneMissing)}`);
    }
  }
  const count = (status) => families.filter((family) => family.status === status).length;
  console.log(
    `요약: 통과 ${count('ok')}, 차이 ${failedCount}, 삭제됨 ${count('deleted')}, 짝 없음 ${count('unpaired')}`
    + ' (삭제됨과 짝 없음은 실패로 세지 않고 가족별로 성기님이 판단)',
  );
  process.exit(failedCount > 0 ? 1 : 0);
} catch (error) {
  console.error(`점검 실패(읽기 오류): ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
