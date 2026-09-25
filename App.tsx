import React, { useState, useEffect, useRef } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  TouchableOpacity, 
  ActivityIndicator,
  Platform,
  BackHandler,
  Alert,
  AppState,
  Linking,
  Image,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from './src/theme/colors';
import { BabyLogEntry, BabyProfile } from './src/types';
import { getLogs, getProfile, addLog, deleteLog, updateLog, saveProfile, migrateStoredData, importDataWithoutLoss, backupLocalData } from './src/database/storage';
import { cancelFamilyDeletion, deleteFamilyCloudData, getFamilyDeletionStatus, parseFamilySyncId, readFamilyChangeToken, refreshCloudConnection, scheduleFamilyDeletion, subscribeToCloudChanges, syncWithCloud } from './src/database/sync';
import { withSyncDeadline } from './src/database/syncDeadline';
import { refreshFeedingReminder } from './src/utils/feedingReminder';
import { Dashboard } from './src/screens/Dashboard';
import { LogFormula } from './src/screens/LogFormula';
import { LogDiaper } from './src/screens/LogDiaper';
import { LogBath } from './src/screens/LogBath';
import { LogWeight } from './src/screens/LogWeight';
import { Statistics } from './src/screens/Statistics';
import { Profile } from './src/screens/Profile';

// 서버 응답이 오지 않아도 화면이 멈추지 않도록 한 번의 동기화에 상한을 둡니다.
const SYNC_TIMEOUT_MS = 20_000;
// 실시간 알림이 조용히 끊겨도 상대방 기록이 결국 들어오도록 하는 안전망입니다.
const SYNC_POLL_INTERVAL_MS = 90_000;

type SyncState = 'idle' | 'syncing' | 'error';

function MainApp() {
  const [logs, setLogs] = useState<BabyLogEntry[]>([]);
  const [profile, setProfile] = useState<BabyProfile | null>(null);
  const [activeScreen, setActiveScreen] = useState<'dashboard' | 'formula' | 'diaper' | 'bath' | 'weight' | 'statistics' | 'profile'>('dashboard');
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const processedInviteRef = useRef<string | null>(null);
  const processedNotificationRef = useRef<string | null>(null);
  // 마지막으로 반영한 가족 변경 지점입니다. 주기 확인에서 이 값이 그대로면
  // 기록 전체를 다시 읽지 않고 넘어갑니다.
  const lastChangeTokenRef = useRef<string | null>(null);
  const lastSyncFailedRef = useRef(false);
  const activeSyncAbortRef = useRef<{ aborted: boolean } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const insets = useSafeAreaInsets();

  // 자동 동기화, 당겨서 새로고침, 저장 직후 업로드가 겹치지 않도록 한 줄로 실행합니다.
  const isSyncRunningRef = useRef(false);
  // 대기 중인 동기화는 반드시 가족 키별로 따로 보관합니다. 하나로 합치면 가족을
  // 바꾼 직후의 요청이 이전 가족의 결과를 돌려받아, 새 가족의 업로드가 조용히
  // 건너뛰어지고 화면에는 엉뚱한 성공/실패가 표시됩니다.
  const pendingSyncByKeyRef = useRef<Map<string, Promise<any>>>(new Map());

  const syncLatestData = async (
    syncKey: string,
    createBackup = false,
    // 이미 연결돼 있던 가족이 다른 기기에서 영구 삭제된 경우, 평소 동기화가
    // 조용히 가족을 되살리고 로컬 기록을 재업로드하면 삭제가 무의미해집니다.
    // 그래서 기본값을 false로 두고, "새 가족 만들기"에서만 명시적으로 true를 줍니다.
    allowFamilyCreation = false,
    connecting = false,
    forceFullRead = false,
  ) => {
    type SyncResult = Awaited<ReturnType<typeof syncWithCloud>>;
    const normalizedKey = syncKey.trim();

    // 특별한 설정(가족 가입, 백업 생성 등)이 없는 일반 동기화 요청이 연달아 들어오면
    // 큐를 무한정 늘리는 대신 대기 중인 다음 회차에 합쳐 네트워크와 쓰기 한도를 아낍니다.
    // 합치는 범위는 같은 가족 키로 한정합니다.
    const isStandardSync = !createBackup && allowFamilyCreation && !connecting && !forceFullRead;
    if (isStandardSync && isSyncRunningRef.current) {
      const alreadyPending = pendingSyncByKeyRef.current.get(normalizedKey);
      if (alreadyPending) return alreadyPending as Promise<SyncResult>;
    }

    let resolveVisible!: (result: SyncResult) => void;
    let rejectVisible!: (error: unknown) => void;
    const visibleResult = new Promise<SyncResult>((resolve, reject) => {
      resolveVisible = resolve;
      rejectVisible = reject;
    });

    if (isStandardSync && isSyncRunningRef.current) {
      pendingSyncByKeyRef.current.set(normalizedKey, visibleResult);
    }

    const run = async (): Promise<void> => {
      isSyncRunningRef.current = true;
      if (pendingSyncByKeyRef.current.get(normalizedKey) === visibleResult) {
        pendingSyncByKeyRef.current.delete(normalizedKey);
      }

      const currentLogs = await getLogs();
      const currentProfile = await getProfile();
      if ((!connecting && currentProfile.syncKey !== normalizedKey)
        || (connecting && currentProfile.syncKey && currentProfile.syncKey !== normalizedKey)) {
        resolveVisible({
          logs: currentLogs,
          profile: currentProfile,
          success: false,
          merged: false,
          error: 'Sync is not connected',
        });
        isSyncRunningRef.current = false;
        return;
      }
      setSyncState('syncing');
      const abortToken = { aborted: false };
      activeSyncAbortRef.current = abortToken;
      // Firestore 쓰기는 서버 응답 전까지 계속 대기합니다. 상한이 없으면 새로고침
      // 표시가 영영 돌고, 뒤에 줄 서 있는 다음 동기화까지 모두 막힙니다.
      const operation = syncWithCloud(
        normalizedKey,
        currentLogs,
        currentProfile,
        createBackup,
        abortToken,
        allowFamilyCreation,
        forceFullRead,
      );
      try {
        const result = await withSyncDeadline(operation, abortToken, () => ({
          logs: currentLogs,
          profile: currentProfile,
          success: false,
          merged: false,
          error: '서버 응답을 기다리고 있어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
        }), SYNC_TIMEOUT_MS);
        // 서버를 기다리는 동안 추가한 기록을 화면에서도 보존합니다.
        const latestProfile = await getProfile();
        const latestLogs = await getLogs();
        result.logs = latestLogs;
        result.profile = latestProfile;

        // 사용자가 그 사이에 가족 연결을 해제했거나 다른 가족으로 바꾼 경우,
        // 이전 가족의 늦은 실패 결과가 에러 배너를 다시 띄우지 않도록 정리합니다.
        const isCurrentFamily = connecting
          ? (latestProfile.syncKey === normalizedKey || !latestProfile.syncKey)
          : (latestProfile.syncKey === normalizedKey);
        if (!isCurrentFamily) {
          if (!latestProfile.syncKey) {
            setSyncState('idle');
            setSyncError(null);
            lastSyncFailedRef.current = false;
          }
          resolveVisible({ ...result, success: false, merged: false, error: '가족 연결이 해제되었거나 변경되었습니다.' });
          return;
        }

        if (abortToken.aborted && !latestProfile.syncKey) {
          setSyncState('idle');
          setSyncError(null);
          lastSyncFailedRef.current = false;
          resolveVisible({ ...result, success: false, merged: false, error: '가족 연결이 해제되었습니다.' });
          return;
        }

        // 이 기기가 이미 이 가족 키로 연결돼 있었는데(latestProfile.syncKey === normalizedKey,
        // isCurrentFamily로 위에서 확인됨) 서버가 "가족을 찾을 수 없다"고 답했다면, 다른
        // 기기가 그 사이 가족 서버 데이터를 영구 삭제한 것입니다. 여기서 계속
        // 재시도하면 allowFamilyCreation 여부와 무관하게 다음 "새 가족 만들기"
        // 시도에서 조용히 되살아날 위험이 있으므로, 이 기기도 로컬 연결을 끊어
        // 둡니다. 이 기기에 저장된 기록 자체는 지우지 않습니다.
        if (!result.success && result.familyUnavailable && !connecting) {
          await saveProfile({ ...latestProfile, syncKey: undefined });
          const disconnectedProfile = await getProfile();
          setProfile(disconnectedProfile);
          setSyncState('idle');
          setSyncError(null);
          lastSyncFailedRef.current = false;
          resolveVisible({ ...result, logs: latestLogs, profile: disconnectedProfile, success: false, merged: false, error: '가족 데이터가 삭제되어 연결이 해제되었습니다.' });
          Alert.alert(
            '가족 연결 해제됨',
            '다른 기기에서 가족 서버 데이터를 영구 삭제해 이 기기의 연결도 해제되었습니다. 이 기기에 저장된 기록은 그대로 남아 있습니다.',
          );
          return;
        }

        setSyncState(result.success ? 'idle' : 'error');
        setSyncError(result.success ? null : result.error || '서버에 연결하지 못했습니다.');
        lastSyncFailedRef.current = !result.success;
        if (result.success) setLastSyncedAt(Date.now());
        resolveVisible(result);
        // 취소 토큰을 저장 큐와 transaction에서 검사하므로 늦은 응답을 버리고
        // 다음 시도를 허용합니다. 응답 없는 네트워크가 대기열을 잠그지 않습니다.
        void operation.catch(() => undefined);
      } catch (error) {
        const latest = await getProfile().catch(() => null);
        if (abortToken.aborted && (!latest?.syncKey || latest.syncKey !== normalizedKey)) {
          setSyncState('idle');
          setSyncError(null);
          lastSyncFailedRef.current = false;
        } else {
          setSyncState('error');
          setSyncError(error instanceof Error ? error.message : '서버에 연결하지 못했습니다.');
          lastSyncFailedRef.current = true;
        }
        rejectVisible(error);
      } finally {
        isSyncRunningRef.current = false;
        if (activeSyncAbortRef.current === abortToken) activeSyncAbortRef.current = null;
      }
    };
    const queued = syncQueueRef.current.catch(() => undefined).then(run);
    syncQueueRef.current = queued.then(() => undefined, () => undefined);
    return visibleResult;
  };

  // Load initial data and run background sync if syncKey is set
  useEffect(() => {
    async function loadData() {
      try {
        await migrateStoredData();
        const loadedLogs = await getLogs();
        const loadedProfile = await getProfile();
        setLogs(loadedLogs);
        setProfile(loadedProfile);
        setIsLoading(false);

        // 네트워크 작업은 첫 화면을 막지 않고 백그라운드에서 처리합니다.
        if (loadedProfile.syncKey) {
          const result = await syncLatestData(loadedProfile.syncKey, true);
          if (result.success || result.merged) {
            setLogs(result.logs);
            setProfile(result.profile);
            void refreshFeedingReminder(result.logs, result.profile);
          } else {
            void refreshFeedingReminder(loadedLogs, loadedProfile);
          }
        } else {
          void refreshFeedingReminder(loadedLogs, loadedProfile);
        }
      } catch (error) {
        console.error('Error loading initial data', error);
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, []);

  // Firebase 변경 알림을 받아 상대방 기기의 기록을 즉시 반영합니다.
  useEffect(() => {
    const syncKey = profile?.syncKey;
    lastChangeTokenRef.current = null;
    setLastSyncedAt(null);
    setSyncError(null);
    setSyncState('idle');
    if (!syncKey) return;
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;

    const pullRemoteChanges = async (): Promise<boolean> => {
      try {
        const currentProfile = await getProfile();
        if (!currentProfile.syncKey) return false;
        const result = await syncLatestData(currentProfile.syncKey, false);
        if (mounted && result.merged) {
          setLogs(result.logs);
          setProfile(result.profile);
          await refreshFeedingReminder(result.logs, result.profile);
        }
        return result.success;
      } catch (error) {
        console.warn('Automatic sync failed', error);
        return false;
      }
    };

    // 주기 확인은 문서 하나만 읽어 변경 여부를 판단합니다. 매번 기록 전체를
    // 내려받으면 하루 읽기 한도가 금방 소진되어 동기화가 아예 멈춥니다.
    const checkForRemoteChanges = async () => {
      if (!mounted) return;
      const token = await readFamilyChangeToken(syncKey);
      // 직전 동기화가 실패했다면 올리지 못한 기록이 남아 있을 수 있어 그대로 진행합니다.
      if (token !== null && token === lastChangeTokenRef.current && !lastSyncFailedRef.current) return;
      const succeeded = await pullRemoteChanges();
      if (succeeded && token !== null) lastChangeTokenRef.current = token;
    };

    // 리스너는 네트워크가 끊기면 오류 한 번을 내고 그대로 죽습니다. 다시 붙이지
    // 않으면 앱을 껐다 켜기 전까지 상대방 기록이 영영 들어오지 않습니다.
    const scheduleReconnect = () => {
      if (!mounted) return;
      unsubscribe?.();
      unsubscribe = undefined;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(60_000, 2_000 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = async () => {
      if (!mounted) return;
      try {
        const stop = await subscribeToCloudChanges(syncKey, checkForRemoteChanges, error => {
          console.warn('Realtime sync listener failed', error);
          scheduleReconnect();
        });
        if (!mounted) {
          stop();
          return;
        }
        unsubscribe = stop;
        reconnectAttempt = 0;
      } catch (error) {
        console.warn('Realtime sync setup failed', error);
        scheduleReconnect();
      }
    };

    connect();

    // 실시간 알림이 조용히 끊긴 경우에도 상대방 기록이 결국 들어오게 하는 안전망.
    const pollTimer = setInterval(checkForRemoteChanges, SYNC_POLL_INTERVAL_MS);

    const appStateSubscription = AppState.addEventListener('change', async state => {
      if (state !== 'active') return;
      // 진행 중인 동기화 도중에 연결을 끊으면 캐시에서 읽은 낡은 값으로
      // 병합될 수 있어, 대기열이 빈 뒤에 처리합니다.
      syncQueueRef.current = syncQueueRef.current
        .catch(() => undefined)
        .then(() => refreshCloudConnection())
        .catch(() => undefined);
      await syncQueueRef.current;
      // 화면에 돌아왔을 때는 못 올린 기록이 있을 수 있으므로 전체 동기화합니다.
      void pullRemoteChanges();
    });

    return () => {
      mounted = false;
      unsubscribe?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(pollTimer);
      appStateSubscription.remove();
    };
  }, [profile?.syncKey]);

  // 가족 초대 링크를 누르면 그룹 키를 직접 입력하지 않고 자동으로 연결합니다.
  useEffect(() => {
    if (!profile) return;

    const connectFromInvite = async (url: string | null) => {
      if (!url) return;
      const syncId = parseFamilySyncId(url);
      if (!syncId || !/^babycheck:\/\/family\/[a-f0-9]{32}$/i.test(url.trim())) return;
      if (processedInviteRef.current === syncId) return;
      // 이 핸들러는 오래 살아 있으므로, 화면이 들고 있던 옛 프로필을 그대로 쓰면
      // 그 사이에 수정한 이름·생일이 되돌아갑니다. 저장된 최신 값을 다시 읽습니다.
      const currentProfile = await getProfile();
      if (currentProfile.syncKey && currentProfile.syncKey !== syncId) {
        Alert.alert(
          '다른 가족에 연결되어 있어요',
          '현재 가족의 기록이 다른 가족으로 섞이지 않도록 먼저 설정에서 기존 연결을 해제해 주세요.',
        );
        return;
      }
      const result = await handleSync(syncId, true, false, true);
      // 실패한 초대는 다시 눌러 재시도할 수 있어야 합니다.
      if (result.success) processedInviteRef.current = syncId;
      Alert.alert(
        result.success ? '가족 연결 완료' : '가족 연결 실패',
        result.success
          ? '이제 두 휴대폰의 기록이 자동으로 동기화됩니다.'
          : `초대 링크를 확인해 주세요.\n${result.error || ''}`,
      );
    };

    Linking.getInitialURL().then(connectFromInvite).catch(() => undefined);
    const subscription = Linking.addEventListener('url', event => connectFromInvite(event.url));
    return () => subscription.remove();
  }, [profile?.syncKey]);

  // 홈 화면 위젯의 각 상태를 누르면 해당 기록 화면을 바로 엽니다.
  useEffect(() => {
    const openWidgetDestination = (url: string | null) => {
      if (!url) return;
      const destination = url.match(/^babycheck:\/\/([^/?#]+)/i)?.[1]?.toLowerCase();
      const routes: Record<string, typeof activeScreen> = {
        dashboard: 'dashboard',
        formula: 'formula',
        diaper: 'diaper',
        bath: 'bath',
        weight: 'weight',
        statistics: 'statistics',
        profile: 'profile',
      };
      if (destination && routes[destination]) setActiveScreen(routes[destination]);
    };
    Linking.getInitialURL().then(openWidgetDestination).catch(() => undefined);
    const subscription = Linking.addEventListener('url', event => openWidgetDestination(event.url));
    return () => subscription.remove();
  }, []);

  // 종료 상태에서 알림을 눌러 실행한 경우와 실행 중 알림을 누른 경우 모두
  // 해당 기록 화면으로 이동합니다. 같은 응답은 한 번만 처리합니다.
  useEffect(() => {
    const openNotificationDestination = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const request = response.notification.request;
      const responseKey = `${request.identifier}:${response.actionIdentifier}`;
      if (processedNotificationRef.current === responseKey) return;
      processedNotificationRef.current = responseKey;
      if (request.content.data?.screen === 'formula') setActiveScreen('formula');
    };

    Notifications.getLastNotificationResponseAsync()
      .then(async response => {
        openNotificationDestination(response);
        if (response) await Notifications.clearLastNotificationResponseAsync();
      })
      .catch(error => console.warn('Initial notification response failed', error));
    const subscription = Notifications.addNotificationResponseReceivedListener(openNotificationDestination);
    return () => subscription.remove();
  }, []);

  // Handle hardware back button on Android
  useEffect(() => {
    const backAction = () => {
      if (activeScreen !== 'dashboard') {
        setActiveScreen('dashboard');
        return true; // Prevent app exit
      }
      return false; // Exit app if already on dashboard
    };

    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => backHandler.remove();
  }, [activeScreen]);

  const handleSync = async (
    targetSyncKey: string,
    createBackup = true,
    // syncLatestData와 같은 이유로 기본값은 false. "새 가족 만들기"만
    // connectFamily를 통해 명시적으로 true를 넘깁니다.
    allowFamilyCreation = false,
    connecting = false,
    forceFullRead = false,
  ) => {
    if (!targetSyncKey || !targetSyncKey.trim()) return { success: false, merged: false, error: 'Empty key' };
    try {
      const result = await syncLatestData(
        targetSyncKey.trim(),
        createBackup,
        allowFamilyCreation,
        connecting,
        forceFullRead,
      );
      if (result.success || result.merged) {
        setLogs(result.logs);
        setProfile(result.profile);
        await refreshFeedingReminder(result.logs, result.profile);
      }
      return { success: result.success, merged: result.merged, error: result.error };
    } catch (e) {
      console.error(e);
      return { success: false, merged: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const handleRefresh = async () => {
    if (!profile || !profile.syncKey) return;
    setRefreshing(true);
    try {
      // 사용자가 직접 당겨서 새로고침한 것은 "뭔가 안 맞는다"는 신호입니다.
      // 이때만은 증분을 건너뛰고 서버 기록 전체를 대조합니다. 이미 연결된
      // 가족이 대상이므로 allowFamilyCreation은 false로 둡니다 — true였다면
      // 다른 기기가 영구 삭제한 가족을 새로고침이 조용히 되살릴 수 있습니다.
      const result = await handleSync(profile.syncKey, true, false, false, true);
      if (!result.success) {
        Alert.alert(
          '동기화하지 못했습니다',
          `기록은 이 휴대폰에 안전하게 저장되어 있고, 연결되면 자동으로 다시 올라갑니다.\n${result.error || ''}`,
        );
      }
    } catch (error) {
      console.error('Refresh sync failed', error);
      Alert.alert('동기화하지 못했습니다', error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddLog = async (newLogData: Omit<BabyLogEntry, 'id'>) => {
    const savedLog = await addLog(newLogData);
    if (savedLog) {
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
      // 기록 화면은 기기 저장이 끝나는 즉시 닫습니다. 백업·알림·서버 전송은
      // 실패해도 이미 저장된 기록을 방해하지 않도록 뒤에서 처리합니다.
      void backupLocalData();
      if (profile) void refreshFeedingReminder(updatedLogs, profile);
      if (profile?.syncKey) {
        void syncLatestData(profile.syncKey, false).then(result => {
          if (result.merged) {
            setLogs(result.logs);
            setProfile(result.profile);
            void refreshFeedingReminder(result.logs, result.profile);
          }
        }).catch(error => console.warn('Background log sync failed', error));
      }
    }
    return savedLog;
  };

  const handleDeleteLog = async (id: string) => {
    const success = await deleteLog(id);
    if (success) {
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
      void backupLocalData();
      if (profile) void refreshFeedingReminder(updatedLogs, profile);
      if (profile?.syncKey) {
        void syncLatestData(profile.syncKey, false).then(result => {
          if (result.merged) {
            setLogs(result.logs);
            setProfile(result.profile);
            void refreshFeedingReminder(result.logs, result.profile);
          }
        }).catch(error => console.warn('Background delete sync failed', error));
      }
    }
  };

  const handleUpdateLog = async (updatedLog: BabyLogEntry) => {
    const success = await updateLog(updatedLog);
    if (success) {
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
      void backupLocalData();
      if (profile) void refreshFeedingReminder(updatedLogs, profile);
      if (profile?.syncKey) {
        void syncLatestData(profile.syncKey, false).then(result => {
          if (result.merged) {
            setLogs(result.logs);
            setProfile(result.profile);
            void refreshFeedingReminder(result.logs, result.profile);
          }
        }).catch(error => console.warn('Background update sync failed', error));
      }
    }
  };

  const handleDeleteFamilyData = async (targetSyncKey: string) => {
    const result = await deleteFamilyCloudData(targetSyncKey);
    if (result.success) {
      // 서버 데이터를 지운 뒤에는 이 기기도 지워진 가족 키로 계속 동기화를
      // 시도하면 안 되므로, 연결 해제와 같은 방식으로 로컬 연결만 끊습니다.
      // 이 기기의 기록 자체는 그대로 남습니다.
      await handleSaveProfile({ syncKey: undefined }, false);
    }
    return result;
  };

  const handleSaveProfile = async (profilePatch: Partial<BabyProfile>, syncInBackground = true) => {
    if ('syncKey' in profilePatch && activeSyncAbortRef.current) {
      activeSyncAbortRef.current.aborted = true;
    }
    // 화면이 들고 있는 프로필은 백그라운드 동기화보다 오래된 값일 수 있습니다.
    // 그 위에 얹으면 상대방이 방금 바꾼 이름을 되돌려 버립니다.
    const storedProfile = await getProfile();
    const mergedProfile = { ...storedProfile, ...profilePatch } as BabyProfile;
    const success = await saveProfile(mergedProfile);
    if (success) {
      const savedProfile = await getProfile();
      setProfile(savedProfile);
      void refreshFeedingReminder(logs, savedProfile, profilePatch.feedingReminderEnabled === true);
      if (syncInBackground && savedProfile.syncKey) {
        void syncLatestData(savedProfile.syncKey, false).then(result => {
          if (result.merged) {
            setLogs(result.logs);
            setProfile(result.profile);
            void refreshFeedingReminder(result.logs, result.profile);
          }
        }).catch(error => console.warn('Background profile sync failed', error));
      }
    }
    return success;
  };

  const handleImportData = async (newProfile: BabyProfile, newLogs: BabyLogEntry[]) => {
    const imported = await importDataWithoutLoss(newLogs, newProfile);
    setProfile(imported.profile);
    setLogs(imported.logs);
    setActiveScreen('dashboard');
    await refreshFeedingReminder(imported.logs, imported.profile);
    if (imported.profile.syncKey) {
      await handleSync(imported.profile.syncKey);
    }
  };

  const handleRestoredData = async (restoredProfile: BabyProfile, restoredLogs: BabyLogEntry[]) => {
    setProfile(restoredProfile);
    setLogs(restoredLogs);
    setActiveScreen('dashboard');
    await refreshFeedingReminder(restoredLogs, restoredProfile);
    if (restoredProfile.syncKey) {
      await handleSync(restoredProfile.syncKey, false);
    }
  };

  if (isLoading || !profile) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>우리아기 일지 로딩 중...</Text>
      </View>
    );
  }

  // Render current screen content
  const renderScreenContent = () => {
    switch (activeScreen) {
      case 'dashboard':
        return (
          <Dashboard 
            logs={logs} 
            profile={profile} 
            onAddLog={handleAddLog} 
            onDeleteLog={handleDeleteLog} 
            onUpdateLog={handleUpdateLog}
            onNavigate={setActiveScreen}
            refreshing={refreshing}
            onRefresh={profile.syncKey ? handleRefresh : undefined}
            onSetNextFeedingTime={async (timestamp, feedingLogId) => {
              await handleSaveProfile({
                nextFeedingAt: timestamp || undefined,
                nextFeedingForLogId: timestamp ? feedingLogId : undefined,
              });
            }}
          />
        );
      case 'formula':
        return (
          <LogFormula 
            onAddLog={handleAddLog} 
            onNavigate={setActiveScreen} 
          />
        );
      case 'diaper':
        return (
          <LogDiaper 
            onAddLog={handleAddLog} 
            onNavigate={setActiveScreen} 
          />
        );
      case 'bath':
        return (
          <LogBath
            onAddLog={handleAddLog}
            onNavigate={setActiveScreen}
          />
        );
      case 'weight':
        return <LogWeight onAddLog={handleAddLog} onNavigate={setActiveScreen} />;
      case 'statistics':
        return <Statistics logs={logs} />;
      case 'profile':
        return (
          <Profile 
            profile={profile} 
            onSaveProfile={handleSaveProfile} 
            onImportData={handleImportData}
            onRestoreData={handleRestoredData}
            onSync={handleSync}
            onDeleteFamilyData={handleDeleteFamilyData}
            onScheduleFamilyDeletion={scheduleFamilyDeletion}
            onCancelFamilyDeletion={cancelFamilyDeletion}
            onGetFamilyDeletionStatus={getFamilyDeletionStatus}
          />
        );
    }
  };

  // 동기화가 살아 있는지 한눈에 보이게 합니다. 지금까지는 실패해도 화면에
  // 아무 표시가 없어서 사용자가 "동기화가 안 된다"는 것만 알 수 있었습니다.
  const syncIndicator = (() => {
    if (syncState === 'syncing') return { color: COLORS.textMuted, label: '동기화 중' };
    if (syncState === 'error') return { color: '#A33D29', label: '전송 대기 · 재시도' };
    if (!lastSyncedAt) return { color: COLORS.textMuted, label: '대기 중' };
    const minutes = Math.floor((Date.now() - lastSyncedAt) / 60_000);
    if (minutes < 1) return { color: '#3C9A5F', label: '방금 동기화' };
    if (minutes < 60) return { color: '#3C9A5F', label: `${minutes}분 전 동기화` };
    return { color: '#D9534F', label: `${Math.floor(minutes / 60)}시간 전 동기화` };
  })();

  // Only show bottom tabs on main pages (Dashboard, Statistics, Profile)
  const showTabs = activeScreen === 'dashboard' || activeScreen === 'statistics' || activeScreen === 'profile';
  
  // Calculate dynamic bottom tab bar spacing
  const bottomPadding = insets.bottom > 0 ? insets.bottom : 8;
  const tabBarHeight = 52 + bottomPadding;

  return (
    <View style={[
      styles.container, 
      { 
        paddingTop: activeScreen === 'formula' || activeScreen === 'diaper' || activeScreen === 'bath' || activeScreen === 'weight' ? insets.top : 0
      }
    ]}>
      <StatusBar style="dark" />
      
      {/* Top Bar / App Header */}
      {showTabs && (
        <View style={[styles.header, { paddingTop: insets.top, height: 50 + insets.top }]}>
          <View style={styles.headerBrand}>
            <Image source={require('./assets/icon.png')} style={styles.headerLogo} />
            <Text style={styles.headerTitle}>아기기록</Text>
          </View>
          <View style={styles.headerStatus}>
            <Text style={styles.headerSubtitle}>{profile.name} 일기</Text>
            {profile.syncKey ? (
              <TouchableOpacity style={styles.syncBadge} onPress={handleRefresh}
                disabled={syncState === 'syncing'} accessibilityRole="button"
                accessibilityLabel={`${syncIndicator.label}. 가족 기록 동기화 다시 시도`}>
                <View style={[styles.syncDot, { backgroundColor: syncIndicator.color }]} />
                <Text style={[styles.syncBadgeText, { color: syncIndicator.color }]}>{syncIndicator.label}</Text>
              </TouchableOpacity>
            ) : <Text style={styles.syncBadgeText}>이 기기에 저장 중</Text>}
          </View>
        </View>
      )}

      {showTabs && profile.syncKey && syncState === 'error' && (
        <TouchableOpacity style={styles.syncErrorBanner} onPress={handleRefresh}
          accessibilityRole="button" accessibilityLabel="동기화 다시 시도">
          <View style={{ flex: 1 }}>
            <Text style={styles.syncErrorTitle}>기록은 이 기기에 저장되어 있어요</Text>
            <Text style={styles.syncErrorBody}>{syncError || '연결되면 가족에게 다시 전송합니다.'}</Text>
          </View>
          <Text style={styles.syncRetry}>재시도</Text>
        </TouchableOpacity>
      )}

      {/* Screen Body */}
      <View style={styles.body}>
        {renderScreenContent()}
      </View>

      {/* Custom Bottom Tab Bar */}
      {showTabs && (
        <View style={[
          styles.tabBar, 
          { 
            height: tabBarHeight, 
            paddingBottom: bottomPadding 
          }
        ]}>
          {/* Dashboard Tab */}
          <TouchableOpacity 
            accessibilityRole="tab" accessibilityState={{ selected: activeScreen === 'dashboard' }} accessibilityLabel="홈"
            style={[styles.tabItem, activeScreen === 'dashboard' && styles.tabItemActive]}
            onPress={() => setActiveScreen('dashboard')}
          >
            <Text style={styles.tabIcon}>🏠</Text>
            <Text style={[styles.tabLabel, activeScreen === 'dashboard' && styles.tabLabelActive]}>홈</Text>
          </TouchableOpacity>

          {/* Statistics Tab */}
          <TouchableOpacity 
            accessibilityRole="tab" accessibilityState={{ selected: activeScreen === 'statistics' }} accessibilityLabel="통계"
            style={[styles.tabItem, activeScreen === 'statistics' && styles.tabItemActive]}
            onPress={() => setActiveScreen('statistics')}
          >
            <Text style={styles.tabIcon}>📈</Text>
            <Text style={[styles.tabLabel, activeScreen === 'statistics' && styles.tabLabelActive]}>통계</Text>
          </TouchableOpacity>

          {/* Profile Tab */}
          <TouchableOpacity 
            accessibilityRole="tab" accessibilityState={{ selected: activeScreen === 'profile' }} accessibilityLabel="설정"
            style={[styles.tabItem, activeScreen === 'profile' && styles.tabItemActive]}
            onPress={() => setActiveScreen('profile')}
          >
            <Text style={styles.tabIcon}>⚙️</Text>
            <Text style={[styles.tabLabel, activeScreen === 'profile' && styles.tabLabelActive]}>설정</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  header: {
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  headerBrand: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  headerStatus: { alignItems: 'flex-end' },
  syncBadge: { flexDirection: 'row', alignItems: 'center', minHeight: 30 },
  syncErrorBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, backgroundColor: '#FFF3E8', borderBottomWidth: 1, borderColor: '#EDD4BA' },
  syncErrorTitle: { fontSize: 13, fontWeight: '700', color: '#713D22' },
  syncErrorBody: { fontSize: 12, lineHeight: 18, color: '#713D22', marginTop: 4 },
  syncRetry: { color: '#713D22', fontWeight: '700', paddingVertical: 12 },
  syncDot: { width: 6, height: 6, borderRadius: 3, marginRight: 4 },
  syncBadgeText: { fontSize: 11, fontWeight: '600', color: COLORS.textMuted },
  headerLogo: { width: 30, height: 30, borderRadius: 8, marginRight: 8 },
  headerSubtitle: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  body: {
    flex: 1,
  },
  tabBar: {
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 6,
  },
  tabItem: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  tabItemActive: {
    backgroundColor: COLORS.lightPink,
    borderRadius: 16,
  },
  tabIcon: {
    fontSize: 20,
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: 'bold',
  },
  tabLabelActive: {
    color: COLORS.primary,
  },
});
