import assert from 'node:assert/strict';
import { getVoiceStatusText } from '../src/utils/voiceFeedback.ts';

assert.match(getVoiceStatusText('starting', null), /마이크.*준비/);
assert.match(getVoiceStatusText('listening', null), /듣고 있어요.*말씀/);
assert.match(getVoiceStatusText('processing', null), /명령.*처리 중/);
assert.match(getVoiceStatusText('ready', null), /확인.*저장/);
assert.equal(getVoiceStatusText('error', '마이크 권한이 필요해요.'), '마이크 권한이 필요해요.');
assert.match(getVoiceStatusText('error', null), /다시 눌러/);
console.log('음성 안내 상태 6개 사례 통과');
