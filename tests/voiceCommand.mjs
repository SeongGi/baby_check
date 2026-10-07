import assert from 'node:assert/strict';
import { parseVoiceCommand } from '../src/utils/voiceCommand.ts';

assert.deepEqual(parseVoiceCommand('분유 120ml 먹었어'), { kind: 'formula', amount: 120 });
assert.deepEqual(parseVoiceCommand('분유 80 밀리리터 먹였어'), { kind: 'formula', amount: 80 });
assert.deepEqual(parseVoiceCommand('지금 자'), { kind: 'sleepStart' });
assert.deepEqual(parseVoiceCommand('잠들었어'), { kind: 'sleepStart' });
assert.deepEqual(parseVoiceCommand('지금 깼어'), { kind: 'sleepEnd' });
assert.deepEqual(parseVoiceCommand('분유 900ml 먹었어'), { kind: 'unknown' });
assert.deepEqual(parseVoiceCommand('분유 120 80 먹었어'), { kind: 'unknown' });
assert.deepEqual(parseVoiceCommand('오늘 날씨 알려줘'), { kind: 'unknown' });
console.log('음성 명령 8개 사례 통과');
