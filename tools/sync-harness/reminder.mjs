import assert from 'node:assert/strict';
import AsyncStorage from './stubs/async-storage.mjs';
import { getPermissionRequests, getScheduled, resetScheduled, setPermissionStatus } from './stubs/expo-notifications.mjs';
import { refreshFeedingReminder } from '../../src/utils/feedingReminder.ts';

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

// Enabling reminders must still request permission when another refresh is queued later.
await AsyncStorage.clear();
resetScheduled();
setPermissionStatus('granted');
const running = refreshFeedingReminder([log], base);
await new Promise(resolve => setTimeout(resolve, 5));
setPermissionStatus('denied');
const enabling = refreshFeedingReminder([log], base, true);
const later = refreshFeedingReminder([log], { ...base, feedingIntervalMinutes: 240 });
await Promise.all([running, enabling, later]);
assert.equal(getPermissionRequests(), 1, '알림 켜기 요청은 뒤의 갱신 때문에 생략되면 안 됩니다');
assert.equal(getScheduled().length, 1);
console.log('PASS 이어진 갱신 중에도 알림 권한 요청이 실행된다');
