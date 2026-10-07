import assert from 'node:assert/strict';
import { canDispatchAutoVoiceLaunch, getAutoVoiceLaunchAction } from '../src/utils/autoVoiceLaunch.ts';

// Assistant can briefly cover a cold launch. The same candidate must survive
// until the app actually returns to the foreground.
let consumed = 0;
assert.equal(getAutoVoiceLaunchAction(1, consumed, true, true, null), 'defer');
assert.equal(getAutoVoiceLaunchAction(1, consumed, true, true, 'background'), 'defer');
assert.equal(consumed, 0);
assert.equal(getAutoVoiceLaunchAction(1, consumed, true, true, 'active'), 'schedule');
assert.equal(canDispatchAutoVoiceLaunch('background'), false);
assert.equal(canDispatchAutoVoiceLaunch('active'), true);
consumed = 1;
assert.equal(getAutoVoiceLaunchAction(1, consumed, true, true, 'active'), 'none');

// A candidate for another screen, or with auto listening disabled, expires.
assert.equal(getAutoVoiceLaunchAction(2, consumed, false, true, 'active'), 'discard');
assert.equal(getAutoVoiceLaunchAction(2, consumed, true, false, 'active'), 'discard');
console.log('자동 음성 시작 상태 8개 사례 통과');
