import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { BabyLogEntry, BabyProfile, FormulaLog } from '../types';

const NOTIFICATION_ID_KEY = '@baby_feeding_notification_id';
// Android는 생성된 채널의 중요도를 앱에서 낮음→높음으로 바꿀 수 없으므로
// 새 채널 ID를 사용해 기존 설치에서도 헤드업 알림 설정을 확실히 적용합니다.
const CHANNEL_ID = 'feeding-reminders-v2';

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
  if (
    profile.nextFeedingAt &&
    profile.nextFeedingForLogId === latest.id &&
    profile.nextFeedingAt > latest.timestamp
  ) {
    return profile.nextFeedingAt;
  }
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

const formatElapsed = (timestamp: number | undefined, now = Date.now()) => {
  if (!timestamp) return '기록 없음';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
};

const buildWidgetSnapshot = (logs: BabyLogEntry[], profile: BabyProfile, now = Date.now()) => {
  const latest = getLatestFeeding(logs);
  const nextAt = getNextFeedingAt(logs, profile);
  const latestOf = <T extends BabyLogEntry['type']>(type: T) =>
    logs.find(log => log.type === type);
  const urine = latestOf('urine');
  const stool = latestOf('stool');
  const sleep = latestOf('sleep');
  const activeSleep = logs.find(log => log.type === 'sleep' && !log.endedAt);
  const mostRecent = logs[0];
  const statusByType: Partial<Record<BabyLogEntry['type'], string>> = {
    formula: '배부르게 먹었어요',
    urine: '쉬 했어요',
    stool: '응가 했어요',
    bath: '목욕했어요',
    weight: '몸무게를 쟀어요',
    sleep: '잠에서 깼어요',
  };
  const feedingKind = latest?.feedingType === 'breast'
    ? '모유'
    : latest?.feedingType === 'mixed'
      ? '혼합'
      : '분유';
  const sleepLabel = activeSleep
    ? `자는 중 · ${formatElapsed(activeSleep.timestamp, now).replace(' 전', '')}`
    : sleep
      ? `마지막 잠 ${formatElapsed((sleep as typeof sleep & { endedAt?: number }).endedAt || sleep.timestamp, now)}`
      : '수면 기록 없음';
  const props = {
    babyName: profile.name || '우리 아기',
    lastFeedingLabel: latest ? formatClock(latest.timestamp) : '기록 없음',
    nextFeedingLabel: nextAt ? formatClock(nextAt) : '--:--',
    remainingLabel: nextAt ? formatRemaining(nextAt, now) : '수유를 기록해 주세요',
    isOverdue: nextAt ? nextAt <= now : false,
    statusLabel: activeSleep
      ? '자는 중'
      : mostRecent
        ? statusByType[mostRecent.type] || '잘 지내고 있어요'
        : '첫 기록을 기다려요',
    formulaLabel: latest
      ? `${feedingKind} ${latest.amount || 0}ml · ${formatElapsed(latest.timestamp, now)}`
      : '수유 기록 없음',
    urineLabel: urine ? formatElapsed(urine.timestamp, now) : '소변 기록 없음',
    stoolLabel: stool ? formatElapsed(stool.timestamp, now) : '대변 기록 없음',
    sleepLabel,
  };
  return { props, nextFeedingAt: nextAt || 0, updatedAt: now };
};

const updateWidget = async (logs: BabyLogEntry[], profile: BabyProfile) => {
  const snapshot = buildWidgetSnapshot(logs, profile);
  if (Platform.OS === 'android') {
    await NativeModules.BabyWidget?.updateSnapshot({
      ...snapshot.props,
      nextFeedingAt: snapshot.nextFeedingAt,
      updatedAt: snapshot.updatedAt,
    });
    return;
  }
  if (Platform.OS !== 'ios') return;
  const { default: FeedingWidget } = await import('../widgets/FeedingWidget');
  const nextAt = snapshot.nextFeedingAt;
  if (!nextAt) {
    FeedingWidget.updateSnapshot(snapshot.props);
    return;
  }
  const now = snapshot.updatedAt;
  const timeline = [];
  for (let entryAt = now; entryAt < nextAt; entryAt += 15 * 60_000) {
    timeline.push({
      date: new Date(entryAt),
      props: {
        ...snapshot.props,
        remainingLabel: formatRemaining(nextAt, entryAt),
        isOverdue: false,
      },
    });
  }
  timeline.push(
    {
      date: new Date(nextAt),
      props: {
        ...snapshot.props,
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
      name: '다음 수유 알림',
      description: '다음 수유 시간이 되면 화면 상단과 알림창에 알려줍니다.',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 250, 150, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
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
  if (Platform.OS === 'android') {
    // 권한을 이미 허용한 기기에서도 채널이 반드시 생성되도록 합니다.
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '다음 수유 알림',
      description: '다음 수유 시간이 되면 화면 상단과 알림창에 알려줍니다.',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 250, 150, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const allowed = askPermission
    ? await requestFeedingReminderPermission()
    : (await Notifications.getPermissionsAsync()).status === 'granted';
  if (!allowed) return false;

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: `🍼 ${profile.name} 수유 시간이에요`,
      body: `마지막 수유 후 ${profile.feedingIntervalMinutes || 180}분이 지났어요.`,
      data: { screen: 'formula', nextFeedingAt: nextAt },
      sound: 'default',
      priority: Notifications.AndroidNotificationPriority.MAX,
      color: '#F7839B',
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
