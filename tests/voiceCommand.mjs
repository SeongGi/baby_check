import assert from 'node:assert/strict';
import { parseVoiceCommand } from '../src/utils/voiceCommand.ts';

const cases = [
  // 1. 수유: 분유, 모유, 혼합, 맘마, 우유, 단위 생략, 다양한 어미
  ['분유 120ml 먹었어', { kind: 'formula', feedingType: 'formula', amount: 120, temperature: undefined }],
  ['모유 80ml 먹었어', { kind: 'formula', feedingType: 'breast', amount: 80, temperature: undefined }],
  ['분유 80ml 모유 40ml 먹었어', { kind: 'formula', feedingType: 'mixed', amount: 120, formulaAmount: 80, breastAmount: 40, temperature: undefined }],
  ['분유 120ml 먹였어요', { kind: 'formula', feedingType: 'formula', amount: 120, temperature: undefined }],
  ['분유 160', { kind: 'formula', feedingType: 'formula', amount: 160, temperature: undefined }],
  ['맘마 140 먹었어', { kind: 'formula', feedingType: 'formula', amount: 140, temperature: undefined }],
  ['우유 100 마셨어', { kind: 'formula', feedingType: 'formula', amount: 100, temperature: undefined }],
  ['따뜻한 분유 150ml 먹음', { kind: 'formula', feedingType: 'formula', amount: 150, temperature: 'warm' }],
  ['모유 100 먹였어', { kind: 'formula', feedingType: 'breast', amount: 100, temperature: undefined }],

  // 2. 소변: 기본값 매핑(medium, normal) 및 어미 유연성
  ['소변 기저귀 갈았어', { kind: 'urine', wetness: 'medium', color: 'normal' }],
  ['소변 봤어요', { kind: 'urine', wetness: 'medium', color: 'normal' }],
  ['소변 봤어', { kind: 'urine', wetness: 'medium', color: 'normal' }],
  ['쉬했어', { kind: 'urine', wetness: 'medium', color: 'normal' }],
  ['오줌 쌌어', { kind: 'urine', wetness: 'medium', color: 'normal' }],
  ['기저귀 갈았어', { kind: 'urine', wetness: 'medium', color: 'normal' }],
  ['소변 많이 진한 색 봤어', { kind: 'urine', wetness: 'heavy', color: 'dark' }],
  ['소변 적게 맑은 색', { kind: 'urine', wetness: 'light', color: 'clear' }],

  // 3. 대변: 기본값 매핑(yellow, soft, medium) 및 어미 유연성
  ['대변 봤어', { kind: 'stool', color: 'yellow', consistency: 'soft', amount: 'medium' }],
  ['대변 보통 봤어', { kind: 'stool', color: 'yellow', consistency: 'soft', amount: 'medium' }],
  ['응가했어', { kind: 'stool', color: 'yellow', consistency: 'soft', amount: 'medium' }],
  ['똥 쌌어', { kind: 'stool', color: 'yellow', consistency: 'soft', amount: 'medium' }],
  ['응가 완료', { kind: 'stool', color: 'yellow', consistency: 'soft', amount: 'medium' }],
  ['노란색 묽은 대변 많이 봤어', { kind: 'stool', color: 'yellow', consistency: 'watery', amount: 'large' }],
  ['녹색 딱딱한 대변 적게 봤어', { kind: 'stool', color: 'green', consistency: 'hard', amount: 'small' }],

  // 4. 목욕: 기본 10분 매핑 및 시간 지정
  ['목욕 10분', { kind: 'bath', bathType: 'full', durationMinutes: 10 }],
  ['목욕했어', { kind: 'bath', bathType: 'full', durationMinutes: 10 }],
  ['목욕 완료', { kind: 'bath', bathType: 'full', durationMinutes: 10 }],
  ['간단 씻기 5분 했어', { kind: 'bath', bathType: 'quick', durationMinutes: 5 }],
  ['간단 씻기', { kind: 'bath', bathType: 'quick', durationMinutes: 10 }],

  // 5. 체중
  ['몸무게 5.2kg', { kind: 'weight', weightKg: 5.2 }],
  ['체중 6.5키로', { kind: 'weight', weightKg: 6.5 }],
  ['몸무게 6.1', { kind: 'weight', weightKg: 6.1 }],

  // 6. 수면
  ['지금 자', { kind: 'sleepStart' }],
  ['잠들었어', { kind: 'sleepStart' }],
  ['낮잠 시작', { kind: 'sleepStart' }],
  ['아기 잔다', { kind: 'sleepStart' }],
  ['지금 깼어', { kind: 'sleepEnd' }],
  ['일어났어', { kind: 'sleepEnd' }],
  ['낮잠 끝', { kind: 'sleepEnd' }],
  ['기상', { kind: 'sleepEnd' }],

  // 7. 터미타임 & 놀기
  ['터미타임 시작', { kind: 'tummyStart' }],
  ['터미타임 끝', { kind: 'tummyEnd' }],
  ['터미타임', { kind: 'tummyStart' }],
  ['놀기 시작', { kind: 'playStart' }],
  ['놀이 시작', { kind: 'playStart' }],
  ['놀기 끝', { kind: 'playEnd' }],

  // 8. 오인식 및 부정어 필터링
  ['분유 안 먹었어', { kind: 'unknown' }],
  ['잠 안 자', { kind: 'unknown' }],
  ['소변인가?', { kind: 'unknown' }],
  ['분유 120 먹고 소변 봤어', { kind: 'unknown' }],
  ['분유 900ml 먹었어', { kind: 'unknown' }],
  ['오늘 날씨 알려줘', { kind: 'unknown' }],
];

for (const [phrase, expected] of cases) {
  assert.deepEqual(parseVoiceCommand(phrase), expected, `Failed on: "${phrase}"`);
}
console.log(`음성 명령 ${cases.length}개 사례 통과`);
