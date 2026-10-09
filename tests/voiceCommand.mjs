import assert from 'node:assert/strict';
import { parseVoiceCommand } from '../src/utils/voiceCommand.ts';

const cases = [
  ['분유 120ml 먹었어', { kind: 'formula', feedingType: 'formula', amount: 120, temperature: undefined }],
  ['모유 80ml 먹었어', { kind: 'formula', feedingType: 'breast', amount: 80, temperature: undefined }],
  ['분유 80ml 모유 40ml 먹었어', { kind: 'formula', feedingType: 'mixed', amount: 120, formulaAmount: 80, breastAmount: 40, temperature: undefined }],
  ['소변 기저귀 갈았어', { kind: 'urine', wetness: undefined, color: undefined }],
  ['소변 많이 진한 색 봤어', { kind: 'urine', wetness: 'heavy', color: 'dark' }],
  ['대변 봤어', { kind: 'stool', color: undefined, consistency: undefined, amount: undefined }],
  ['대변 보통 봤어', { kind: 'stool', color: undefined, consistency: undefined, amount: undefined }],
  ['노란색 묽은 대변 많이 봤어', { kind: 'stool', color: 'yellow', consistency: 'watery', amount: 'large' }],
  ['목욕 10분', { kind: 'bath', bathType: 'full', durationMinutes: 10 }],
  ['목욕했어', { kind: 'bath', bathType: 'full', durationMinutes: undefined }],
  ['간단 씻기 5분 했어', { kind: 'bath', bathType: 'quick', durationMinutes: 5 }],
  ['몸무게 5.2kg', { kind: 'weight', weightKg: 5.2 }],
  ['지금 자', { kind: 'sleepStart' }],
  ['지금 깼어', { kind: 'sleepEnd' }],
  ['터미타임 시작', { kind: 'tummyStart' }],
  ['터미타임 끝', { kind: 'tummyEnd' }],
  ['놀기 시작', { kind: 'playStart' }],
  ['놀이 시작', { kind: 'playStart' }],
  ['놀기 끝', { kind: 'playEnd' }],
  ['분유 안 먹었어', { kind: 'unknown' }],
  ['분유 120ml 먹였어요', { kind: 'formula', feedingType: 'formula', amount: 120, temperature: undefined }],
  ['소변 봤어요', { kind: 'urine', wetness: undefined, color: undefined }],
  ['분유 120도 먹었어', { kind: 'unknown' }],
  ['모유 분유 120ml 먹었어', { kind: 'unknown' }],
  ['소변인가?', { kind: 'unknown' }],
  ['분유 120 먹고 소변 봤어', { kind: 'unknown' }],
  ['분유 900ml 먹었어', { kind: 'unknown' }],
  ['분유 120 80 먹었어', { kind: 'unknown' }],
  ['오늘 날씨 알려줘', { kind: 'unknown' }],
];
for (const [phrase, expected] of cases) assert.deepEqual(parseVoiceCommand(phrase), expected, phrase);
console.log(`음성 명령 ${cases.length}개 사례 통과`);
