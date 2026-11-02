import assert from 'node:assert/strict';
import AsyncStorage from './stubs/async-storage.mjs';
import { getPermissionRequests, getScheduled, resetScheduled, setPermissionStatus } from './stubs/expo-notifications.mjs';
import { emitAppState, getAlertCalls, resetAlertCalls, setAlertAnswer } from './stubs/react-native.mjs';
import { ensureFeedingReminderPermission, refreshFeedingReminder } from '../../src/utils/feedingReminder.ts';

await AsyncStorage.clear();
resetScheduled();
const log = { id: 'feeding-1', type: 'formula', amount: 100, timestamp: Date.now() };
const base = { name: '아기', feedingReminderEnabled: true, feedingIntervalMinutes: 180 };
const first = refreshFeedingReminder([log], base);
await new Promise(resolve => setTimeout(resolve, 5));
const second = refreshFeedingReminder([log], { ...base, feedingIntervalMinutes: 240 });
await Promise.all([first, second]);
assert.equal(getScheduled().length, 1, '겹친 갱신 뒤 알림은 하나만 남아야 합니다');
assert.equal(getScheduled()[0].trigger.date.getTime(), log.timestamp + 240 * 60_000);
console.log('PASS 겹친 알림 갱신은 최신 알림 하나만 남긴다');

// 알림을 켤 때는 허용 창보다 앱 안내창이 먼저 뜨고, "계속"을 고를 때만 허용 창을 엽니다.
setPermissionStatus('denied');
resetAlertCalls();
setAlertAnswer('cancel');
assert.equal(await ensureFeedingReminderPermission(), false, '취소하면 권한이 없어야 합니다');
assert.equal(getAlertCalls().length, 1, '허용 창 전에 안내창이 한 번 떠야 합니다');
assert.equal(getPermissionRequests(), 0, '취소하면 허용 창을 열면 안 됩니다');
setAlertAnswer('dismissed');
assert.equal(await ensureFeedingReminderPermission(), false, '안내창을 닫기만 해도 허용 창을 열면 안 됩니다');
assert.equal(getPermissionRequests(), 0);
setAlertAnswer('continue');
assert.equal(await ensureFeedingReminderPermission(), true, '"계속"을 고르면 허용 창을 열어야 합니다');
assert.equal(getPermissionRequests(), 1);
resetAlertCalls();
assert.equal(await ensureFeedingReminderPermission(), true, '이미 허용했으면 바로 true입니다');
assert.equal(getAlertCalls().length, 0, '이미 허용한 기기에서는 안내창이 뜨지 않아야 합니다');
console.log('PASS 알림 허용 창 전에 안내창이 뜨고 "계속"일 때만 허용 창을 연다');

// 안내창이 응답 없이 떠 있어도 수유 알림 처리 대기열은 멈추지 않고, 두 번째 요청은 안내창을 겹쳐 띄우지 않습니다.
await AsyncStorage.clear();
resetScheduled();
setPermissionStatus('denied');
resetAlertCalls();
setAlertAnswer('hold');
const hanging = ensureFeedingReminderPermission();
let hangingSettled = false;
void hanging.then(() => { hangingSettled = true; });
assert.equal(await refreshFeedingReminder([log], base), false, '권한이 없으면 예약하지 않습니다');
assert.equal(hangingSettled, false, '시험 전제: 안내창은 아직 응답을 기다립니다');
assert.equal(await ensureFeedingReminderPermission(), false, '안내창이 떠 있는 동안 들어온 요청은 바로 false입니다');
assert.equal(getAlertCalls().length, 1, '안내창이 겹쳐 뜨면 안 됩니다');
console.log('PASS 응답 없는 안내창이 대기열과 두 번째 요청을 막지 않는다');

// 앱이 뒤로 가면 Alert가 콜백 없이 사라질 수 있으므로, 돌아온 뒤에는 안내창을 다시 띄울 수 있어야 합니다.
emitAppState('background');
setAlertAnswer('continue');
assert.equal(await ensureFeedingReminderPermission(), true, '뒤로 갔다 온 뒤에는 안내창을 다시 띄워야 합니다');
assert.equal(getAlertCalls().length, 2);
console.log('PASS 앱이 뒤로 가면 응답 없는 안내창 표시가 지워진다');
