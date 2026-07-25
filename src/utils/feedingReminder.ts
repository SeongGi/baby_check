import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { BabyLogEntry, BabyProfile, FormulaLog } from '../types';

const NOTIFICATION_ID_KEY = '@baby_feeding_notification_id';
const CHANNEL_ID = 'feeding-reminders';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export const getLatestFeeding = (logs: BabyLogEntry[]): FormulaLog | null =>
  logs
    .filter((log): log is FormulaLog => log.type === 'formula')
    .sort((a, b) => b.timestamp - a.timestamp)[0] || null;

export const getNextFeedingAt = (logs: BabyLogEntry[], profile: BabyProfile): number | null => {
  const latest = getLatestFeeding(logs);
  if (!latest) return null;
  return latest.timestamp + (profile.feedingIntervalMinutes || 180) * 60_000;
};

const formatClock = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

const formatRemaining = (nextAt: number, from = Date.now()) => {
  const minutes = Math.ceil((nextAt - from) / 60_000);
  if (minutes <= 0) return `${Math.abs(minutes)}분 지남`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}시간 ${rest}분 남음` : `${rest}분 남음`;
};

const updateWidget = async (logs: BabyLogEntry[], profile: BabyProfile) => {
  if (Platform.OS !== 'ios') return;
  const latest = getLatestFeeding(logs);
  const nextAt = getNextFeedingAt(logs, profile);
  if (!latest || !nextAt) return;
  const { default: FeedingWidget } = await import('../widgets/FeedingWidget');
  const now = Date.now();
  const timeline = [];
  for (let entryAt = now; entryAt < nextAt; entryAt += 15 * 60_000) {
    timeline.push({
      date: new Date(entryAt),
      props: {
        babyName: profile.name,
        lastFeedingLabel: formatClock(latest.timestamp),
        nextFeedingLabel: formatClock(nextAt),
        remainingLabel: formatRemaining(nextAt, entryAt),
        isOverdue: false,
      },
    });
  }
  timeline.push(
    {
      date: new Date(nextAt),
      props: {
        babyName: profile.name,
        lastFeedingLabel: formatClock(latest.timestamp),
        nextFeedingLabel: formatClock(nextAt),
        remainingLabel: '수유 시간이에요',
        isOverdue: true,
      },
    },
  );
  FeedingWidget.updateTimeline(timeline);
};

export const requestFeedingReminderPermission = async (): Promise<boolean> => {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '수유 알림',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
};

export const refreshFeedingReminder = async (
  logs: BabyLogEntry[],
  profile: BabyProfile,
  askPermission = false,
): Promise<boolean> => {
  const previousId = await AsyncStorage.getItem(NOTIFICATION_ID_KEY);
  if (previousId) {
    await Notifications.cancelScheduledNotificationAsync(previousId).catch(() => undefined);
    await AsyncStorage.removeItem(NOTIFICATION_ID_KEY);
  }

  await updateWidget(logs, profile).catch(error => console.warn('Widget update failed', error));
  if (!profile.feedingReminderEnabled) return true;

  const nextAt = getNextFeedingAt(logs, profile);
  if (!nextAt || nextAt <= Date.now()) return true;
  const allowed = askPermission
    ? await requestFeedingReminderPermission()
    : (await Notifications.getPermissionsAsync()).status === 'granted';
  if (!allowed) return false;

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: `🍼 ${profile.name} 수유 시간이에요`,
      body: `마지막 수유 후 ${profile.feedingIntervalMinutes || 180}분이 지났어요.`,
      data: { screen: 'formula', nextFeedingAt: nextAt },
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(nextAt),
      channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
    },
  });
  await AsyncStorage.setItem(NOTIFICATION_ID_KEY, id);
  return true;
};
