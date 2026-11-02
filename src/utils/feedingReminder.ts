import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { BabyLogEntry, BabyProfile, FormulaLog } from '../types';
import { withoutDiaryLogs } from './diary';
import { NOTIFICATION_PROMPT, shouldExplainBeforeRequest } from './permissionNotice';
import { confirmPermissionPrompt } from './permissionPrompt';

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

// 알림 사전 안내창이 떠 있는 동안의 표시 번호입니다. 없으면 null입니다.
// 안내창이 떠 있는 동안 들어온 두 번째 요청은 안내창을 겹쳐 띄우지 않습니다.
let notificationPromptSeq = 0;
let notificationPromptPending: number | null = null;

// 앱이 뒤로 가면 Alert가 콜백 없이 사라질 수 있으므로 표시 번호를 지워 다음 요청이 막히지 않게 합니다.
AppState.addEventListener('change', state => {
  if (state === 'background') notificationPromptPending = null;
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

export const buildWidgetSnapshot = (logs: BabyLogEntry[], profile: BabyProfile, now = Date.now()) => {
  const latest = getLatestFeeding(logs);
  const nextAt = getNextFeedingAt(logs, profile);
  const latestOf = <T extends BabyLogEntry['type']>(type: T) =>
    logs.find(log => log.type === type);
  const urine = latestOf('urine');
  const stool = latestOf('stool');
  const sleep = latestOf('sleep');
  const activeSleep = logs.find(log => log.type === 'sleep' && !log.endedAt);
  // 마지막 기록이 일기나 댓글이면 위젯 상태 문구가 "잘 지내고 있어요"로 바뀌므로, 활동 기록 중 가장 최근 것을 씁니다.
  const mostRecent = withoutDiaryLogs(logs)[0];
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

// 수유 알림 권한을 확인합니다. 허용돼 있으면 true입니다.
// 허용 창을 띄우기 전에 앱이 먼저 안내창을 보여 주고, 사용자가 "계속"을 고를 때만 허용 창을 엽니다.
// 안내창 응답을 기다리는 동안 수유 알림 처리 대기열이 멈추지 않도록, 이 함수는 대기열 밖에서 부릅니다.
export const ensureFeedingReminderPermission = async (): Promise<boolean> => {
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
  if (!shouldExplainBeforeRequest(current)) return false;
  // 안내창이 이미 떠 있으면 새로 띄우지 않고 현재 허용 여부(미허용)만 돌려줍니다.
  if (notificationPromptPending !== null) return false;
  const promptId = ++notificationPromptSeq;
  notificationPromptPending = promptId;
  let choice: Awaited<ReturnType<typeof confirmPermissionPrompt>>;
  try {
    choice = await confirmPermissionPrompt(NOTIFICATION_PROMPT);
  } finally {
    if (notificationPromptPending === promptId) notificationPromptPending = null;
  }
  if (choice !== 'continue') return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
};

let reminderRefreshQueue: Promise<void> = Promise.resolve();

const performFeedingReminderRefresh = async (
  logs: BabyLogEntry[],
  profile: BabyProfile,
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
  const allowed = (await Notifications.getPermissionsAsync()).status === 'granted';
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

export const refreshFeedingReminder = (
  logs: BabyLogEntry[],
  profile: BabyProfile,
): Promise<boolean> => {
  const next = reminderRefreshQueue.catch(() => undefined)
    .then(() => performFeedingReminderRefresh(logs, profile));
  reminderRefreshQueue = next.then(() => undefined, () => undefined);
  return next;
};
