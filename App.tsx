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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from './src/theme/colors';
import { BabyLogEntry, BabyProfile } from './src/types';
import { getLogs, getProfile, addLog, deleteLog, updateLog, saveProfile, migrateStoredData, importDataWithoutLoss, backupLocalData, readProfileAfterPendingWrites } from './src/database/storage';
import * as storage from './src/database/storage';
import * as cloudClient from './src/database/cloudClient';
import { cancelFamilyDeletion, deleteFamilyCloudData, getFamilyDeletionStatus, getSyncClientId, parseFamilySyncId, readFamilyChangeToken, scheduleFamilyDeletion, subscribeToCloudChanges, syncWithCloud } from './src/database/sync';
import { createSyncRunner } from './src/database/syncRunner';
import { decideAfterTokenError } from './src/database/syncDecision';
// 이전 모듈은 firestoreImport.ts와 firebase.ts를 동적 import()로만 불러옵니다(07 2.3.1, 2.11). 혼자 쓰는 기기와
// 1.8.0 신규 가족은 두 모듈을 불러오지 않으므로 App은 이 둘을 정적으로 import하지 않습니다.
import { createFamilyMigrator, MIGRATION_MESSAGES } from './src/database/familyMigration';
import type { FamilyMigrator, LegacyDeletionChoice, LegacyDeletionPrompt, MigratorNotice } from './src/database/familyMigration';
import { shouldAlertOnRefresh, shouldStartPolling } from './src/database/migrationDecision';
import { refreshFeedingReminder } from './src/utils/feedingReminder';
import { canDispatchAutoVoiceLaunch, getAutoVoiceLaunchAction } from './src/utils/autoVoiceLaunch';
import { Dashboard } from './src/screens/Dashboard';
import { LogFormula } from './src/screens/LogFormula';
import { LogDiaper } from './src/screens/LogDiaper';
import { LogBath } from './src/screens/LogBath';
import { LogWeight } from './src/screens/LogWeight';
import { LogTemperature } from './src/screens/LogTemperature';
import { Statistics } from './src/screens/Statistics';
import { Profile } from './src/screens/Profile';

// 서버 응답이 오지 않아도 화면이 멈추지 않도록 한 번의 동기화에 상한을 둡니다.
const SYNC_TIMEOUT_MS = 20_000;
// 실시간 알림이 조용히 끊겨도 상대방 기록이 결국 들어오도록 하는 안전망입니다.
const SYNC_POLL_INTERVAL_MS = 90_000;
const AUTO_VOICE_ON_OPEN_KEY = '@babycheck/autoVoiceOnOpen';

// 'pending'은 이전 준비 중입니다(07 2.3 관문). 오류가 아니라서 재시도 배너를 띄우지 않습니다.
type SyncState = 'idle' | 'syncing' | 'error' | 'pending';

type JoinOutcome = 'joined' | 'not_found' | 'deleted' | 'pending_deletion_choice' | 'cancelled' | 'failed';
// 이전 모듈이 문구(message)를 주지 않은 경우의 안내입니다.
const JOIN_FALLBACK_MESSAGES: Record<JoinOutcome, string> = {
  joined: '',
  not_found: '가족 정보를 찾지 못했습니다. 초대 링크를 다시 받아 주세요.',
  deleted: MIGRATION_MESSAGES.joinDeleted,
  pending_deletion_choice: '이전 서버의 삭제 요청이 정리되지 않아 합류하지 않았습니다. 다시 시도해 주세요.',
  cancelled: MIGRATION_MESSAGES.joinCancelled,
  failed: '서버에 연결하지 못했습니다.',
};

// 1.7.9 삭제 예약 선택 화면(07 2.4.1, 2.4-6, 2.6.3)의 선택지 이름표입니다.
const legacyChoiceLabel = (choice: LegacyDeletionChoice, context: LegacyDeletionPrompt['context']): string => {
  switch (choice) {
    case 'cancelRequest': return context === 'joining' ? '요청 취소하고 합류' : '요청 취소하고 계속 쓰기';
    case 'followDeletion': return '삭제에 따르기';
    case 'cancelJoin': return '합류 취소';
    case 'later': return '나중에';
  }
};

const legacyDeletionMessage = (prompt: LegacyDeletionPrompt): string => {
  const when = new Date(prompt.pendingDeletionAt).toLocaleString('ko-KR');
  if (prompt.context === 'joining') {
    return `이 가족에는 이전 버전에서 서버 데이터 삭제를 요청한 기록이 있습니다. (예약 ${when})\n\n요청을 취소하고 합류하거나, 합류를 취소할 수 있습니다.`;
  }
  const head = prompt.context === 'transition'
    ? '상대 기기(이전 버전)에서 가족 서버 데이터 삭제를 요청했습니다.'
    : '이전 버전에서 가족 서버 데이터 삭제를 요청한 기록이 있습니다.';
  return `${head} (예약 ${when})\n\n"삭제에 따르기"를 골라도 이 기기의 기록은 지우지 않습니다. 이전 서버(Firebase)에 남은 예전 사본은 운영자가 따로 삭제합니다.`;
};


function MainApp() {
  const [logs, setLogs] = useState<BabyLogEntry[]>([]);
  const [profile, setProfile] = useState<BabyProfile | null>(null);
  const [activeScreen, setActiveScreen] = useState<'dashboard' | 'formula' | 'diaper' | 'bath' | 'weight' | 'temperature' | 'statistics' | 'profile'>('dashboard');
  const activeScreenRef = useRef(activeScreen);
  activeScreenRef.current = activeScreen;
  const [isLoading, setIsLoading] = useState(true);
  const [autoVoiceEnabled, setAutoVoiceEnabled] = useState(false);
  const [autoVoiceReady, setAutoVoiceReady] = useState(false);
  const [voiceLaunchCandidate, setVoiceLaunchCandidate] = useState(1);
  const [voiceStartRequest, setVoiceStartRequest] = useState(0);
  const [foregroundRevision, setForegroundRevision] = useState(0);
  const consumedVoiceCandidateRef = useRef(0);
  const suppressAutoVoiceUntilRef = useRef(0);
  const previousAppStateRef = useRef(AppState.currentState);
  const [refreshing, setRefreshing] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const processedInviteRef = useRef<string | null>(null);
  const processedNotificationRef = useRef<string | null>(null);
  // 마지막으로 반영한 가족 변경 지점입니다. 주기 확인에서 이 값이 그대로면
  // 기록 전체를 다시 읽지 않고 넘어갑니다.
  const lastChangeTokenRef = useRef<string | null>(null);
  const lastSyncFailedRef = useRef(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // 1.7.9 가족 합류 중 "이전 서버에서 가족 정보를 확인하는 중" 안내(07 2.9). 설정 화면이 보여 줍니다.
  const [joinProgress, setJoinProgress] = useState<string | null>(null);
  // 이전 모듈이 마지막으로 알린 오류 문구. 이전 준비 중에는 이 문구를 동기화 오류로 계속 보여 줍니다.
  const migrationErrorRef = useRef<string | null>(null);

  const insets = useSafeAreaInsets();

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(AUTO_VOICE_ON_OPEN_KEY)
      .then(value => { if (mounted) setAutoVoiceEnabled(value === 'true'); })
      .catch(() => undefined)
      .finally(() => { if (mounted) setAutoVoiceReady(true); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const previous = previousAppStateRef.current;
      previousAppStateRef.current = state;
      if (state === 'active') setForegroundRevision(revision => revision + 1);
      if (previous !== 'active' && state === 'active' && activeScreenRef.current === 'dashboard' && Date.now() >= suppressAutoVoiceUntilRef.current) {
        setVoiceLaunchCandidate(candidate => candidate + 1);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!autoVoiceReady || isLoading || !profile) return;
    const action = getAutoVoiceLaunchAction(
      voiceLaunchCandidate,
      consumedVoiceCandidateRef.current,
      activeScreen === 'dashboard',
      autoVoiceEnabled,
      AppState.currentState,
    );
    if (action === 'none') return;
    if (action === 'discard') {
      consumedVoiceCandidateRef.current = voiceLaunchCandidate;
      return;
    }
    if (action === 'defer') {
      // currentState can be unknown during a cold launch before native state arrives.
      const retry = setTimeout(() => setForegroundRevision(revision => revision + 1), 1000);
      return () => clearTimeout(retry);
    }
    const timer = setTimeout(() => {
      if (!canDispatchAutoVoiceLaunch(AppState.currentState)) return;
      consumedVoiceCandidateRef.current = voiceLaunchCandidate;
      setVoiceStartRequest(voiceLaunchCandidate);
    }, 800);
    return () => clearTimeout(timer);
  }, [autoVoiceReady, isLoading, profile, voiceLaunchCandidate, activeScreen, autoVoiceEnabled, foregroundRevision]);

  useEffect(() => {
    if (activeScreen !== 'dashboard') setVoiceStartRequest(0);
  }, [activeScreen]);

  const handleAutoVoiceEnabledChange = async (enabled: boolean) => {
    consumedVoiceCandidateRef.current = voiceLaunchCandidate;
    setAutoVoiceEnabled(enabled);
    if (!enabled) setVoiceStartRequest(0);
    try {
      await AsyncStorage.setItem(AUTO_VOICE_ON_OPEN_KEY, enabled ? 'true' : 'false');
    } catch {
      setAutoVoiceEnabled(!enabled);
      Alert.alert('설정 저장 실패', '다시 시도해 주세요.');
    }
  };

  // 이전 모듈(07 2.3)과 러너는 서로를 참조합니다. 러너의 관문이 이전 모듈을 부르고, 이전 모듈이 러너에
  // 요청을 넣습니다. 그래서 이전 모듈은 러너를 함수(`getRunner`)로 받습니다. 둘 다 한 번만 만듭니다.
  const syncRunnerRef = useRef<ReturnType<typeof createSyncRunner> | null>(null);
  const migratorRef = useRef<FamilyMigrator | null>(null);
  if (!migratorRef.current) {
    migratorRef.current = createFamilyMigrator({
      storage,
      cloud: {
        connectFamily: cloudClient.connectFamily,
        deleteFamilyData: cloudClient.deleteFamilyData,
        getSyncToken: cloudClient.getSyncToken,
        scheduleFamilyDeletion: cloudClient.scheduleFamilyDeletion,
      },
      getClientId: getSyncClientId,
      getRunner: () => syncRunnerRef.current!,
      // 백업 저장 실패(07 2.4-1): "백업 없이 계속"은 한 번만 묻습니다. 화면을 닫으면 이전을 멈춘 채 둡니다.
      askBackupFailure: () => new Promise<'continue' | 'later'>(resolve => {
        Alert.alert(
          '업데이트 전 백업 실패',
          `${MIGRATION_MESSAGES.backupFailed}\n\n백업 없이 계속해도 이전은 기록을 합치기만 하므로 기록이 줄지 않습니다.`,
          [
            { text: '나중에', style: 'cancel', onPress: () => resolve('later') },
            { text: '백업 없이 계속', onPress: () => resolve('continue') },
          ],
          { cancelable: false, onDismiss: () => resolve('later') },
        );
      }),
      // 선택지는 `prompt.options`에 들어 있는 것만 보여 줍니다. 합류 중(`joining`)에는 둘뿐입니다(07 2.4.1 끝).
      askLegacyDeletionChoice: prompt => new Promise<LegacyDeletionChoice>(resolve => {
        const dismissChoice: LegacyDeletionChoice = prompt.context === 'joining' ? 'cancelJoin' : 'later';
        Alert.alert(
          prompt.context === 'joining' ? '삭제 요청이 있는 가족' : '가족 서버 데이터 삭제 요청',
          legacyDeletionMessage(prompt),
          prompt.options.map(choice => ({
            text: legacyChoiceLabel(choice, prompt.context),
            style: choice === 'later' || choice === 'cancelJoin' ? 'cancel' as const
              : choice === 'followDeletion' ? 'destructive' as const : 'default' as const,
            onPress: () => resolve(choice),
          })),
          { cancelable: false, onDismiss: () => resolve(dismissChoice) },
        );
      }),
      notify: (notice: MigratorNotice) => {
        if (notice.code === 'legacyJoinChecking') {
          // 합류 도중의 진행 안내는 경고창이 아니라 설정 화면의 한 줄로 보입니다.
          setJoinProgress(notice.message);
          return;
        }
        const isStateError = notice.level === 'error'
          && (notice.code.startsWith('firestore_') || notice.code === 'keyFormat' || notice.code === 'serverAnomaly');
        if (isStateError) {
          // 이전 단계 자체의 오류는 동기화 오류 배너로 보입니다(경고창을 반복해서 띄우지 않습니다).
          migrationErrorRef.current = notice.message;
          setSyncState('error');
          setSyncError(notice.message);
          return;
        }
        Alert.alert(notice.level === 'error' ? '이전 처리 안내' : '안내', notice.message);
      },
    });
  }

  // 대기열, 합치기, 상한, 상한 뒤 판정, 이어 가기는 syncRunner가 맡고, App은 러너가
  // 알려 주는 사건을 화면 상태에 반영하는 일만 합니다.
  if (!syncRunnerRef.current) {
    syncRunnerRef.current = createSyncRunner({
      syncWithCloud,
      getLogs,
      getProfile,
      saveProfile,
      readProfileAfterPendingWrites,
      timeoutMs: SYNC_TIMEOUT_MS,
      // 이전 준비 중인 가족은 D1에 요청하지 않습니다. 연결 회차는 관문을 거치지 않습니다(07 2.3).
      migrationGate: key => migratorRef.current!.migrationGate(key),
      onEvent: event => {
        switch (event.type) {
          case 'started':
            setSyncState('syncing');
            break;
          case 'migrationPending':
            // 오류가 아니라 "이전 준비 중"입니다. 이전 모듈이 알린 오류가 있으면 그 문구를 계속 보입니다.
            if (migrationErrorRef.current) {
              setSyncState('error');
              setSyncError(migrationErrorRef.current);
            } else {
              setSyncState('pending');
              setSyncError(null);
            }
            break;
          case 'succeeded':
            setLastSyncedAt(Date.now());
            lastSyncFailedRef.current = false;
            if (event.notice) {
              // 일부 기록이 너무 커서 공유하지 못했습니다. 나머지는 모두 동기화됐습니다.
              setSyncState('error');
              setSyncError(event.notice);
            } else {
              setSyncState('idle');
              setSyncError(null);
            }
            // 이어 가기 회차는 호출한 화면이 없으므로 새로 받은 기록을 여기서 반영합니다.
            if (event.continuation && event.result.merged) {
              setLogs(event.result.logs);
              setProfile(event.result.profile);
              void refreshFeedingReminder(event.result.logs, event.result.profile);
            }
            break;
          case 'failed':
            setSyncState('error');
            setSyncError(event.error || '서버에 연결하지 못했습니다.');
            lastSyncFailedRef.current = true;
            // 실패한 회차라도 앞서 받은 페이지는 저장소에 저장됐으므로 화면에도 반영합니다.
            if (event.result?.merged) {
              setLogs(event.result.logs);
              setProfile(event.result.profile);
              void refreshFeedingReminder(event.result.logs, event.result.profile);
            }
            break;
          case 'disconnected':
            setProfile(event.profile);
            setSyncState('idle');
            setSyncError(null);
            lastSyncFailedRef.current = false;
            Alert.alert(
              '가족 연결 해제됨',
              '다른 기기에서 가족 서버 데이터를 영구 삭제해 이 기기의 연결도 해제되었습니다. 이 기기에 저장된 기록은 그대로 남아 있습니다.',
            );
            break;
          case 'detached':
            setSyncState('idle');
            setSyncError(null);
            lastSyncFailedRef.current = false;
            break;
        }
      },
    });
  }

  const syncLatestData = (
    syncKey: string,
    createBackup = false,
    // 이미 연결돼 있던 가족이 다른 기기에서 영구 삭제된 경우, 평소 동기화가
    // 조용히 가족을 되살리고 로컬 기록을 재업로드하면 삭제가 무의미해집니다.
    // 그래서 기본값을 false로 두고, "새 가족 만들기"에서만 명시적으로 true를 줍니다.
    allowFamilyCreation = false,
    forceFullRead = false,
  ) => syncRunnerRef.current!.request({ syncKey, createBackup, allowFamilyCreation, forceFullRead });

  // 평소 동기화가 끝난 뒤 전환기 읽기를 부릅니다(07 2.6.2). 5분(14일 뒤와 상대를 본 뒤에는 30분)보다
  // 자주는 모듈이 건너뛰고, 이전이 끝나지 않은 키와 전환기가 없는 기기는 아무것도 하지 않습니다.
  const runTransitionTick = (syncKey: string, force = false) => {
    void migratorRef.current!.transitionTick(syncKey, { force }).catch(error => {
      console.warn('Transition read failed', error);
    });
  };

  // 이전 모듈이 기기에 합친 결과를 저장하면 저장소에서 기록과 프로필을 다시 읽어 화면에 반영합니다(07 2.3 "화면 반영").
  const reloadFromStorage = async () => {
    const storedLogs = await getLogs();
    const storedProfile = await getProfile();
    setLogs(storedLogs);
    setProfile(storedProfile);
    void refreshFeedingReminder(storedLogs, storedProfile);
  };

  // 이전 모듈의 사건 구독: 합친 결과 반영, 연결 해제 반영, 이전 완료 뒤 오류 문구 정리. 언마운트에서 정리합니다.
  useEffect(() => {
    const migrator = migratorRef.current!;
    const unsubscribe = migrator.subscribe(event => {
      if (event.type === 'merged') {
        void reloadFromStorage().catch(error => console.warn('Reload after migration merge failed', error));
      } else if (event.type === 'disconnected') {
        // "삭제에 따르기"로 이 기기의 연결이 해제됐습니다. 기록은 남아 있고 프로필만 다시 읽습니다.
        void getProfile().then(storedProfile => {
          setProfile(storedProfile);
          setSyncState('idle');
          setSyncError(null);
          migrationErrorRef.current = null;
          lastSyncFailedRef.current = false;
        }).catch(error => console.warn('Reload after migration disconnect failed', error));
      } else if (event.type === 'completed') {
        migrationErrorRef.current = null;
      }
    });
    return () => {
      unsubscribe();
      migrator.dispose();
    };
  }, []);

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
          // 이전 모듈을 첫 동기화보다 먼저 시작합니다(07 2.3 "앱 시작 순서"). 기다리지 않습니다. 백업 실패
          // 선택 화면이 열려 있으면 사용자 답까지 pending이고, 관문이 근거 있는 키를 막아 404 오류를 보이지 않습니다.
          void migratorRef.current!.ensure(loadedProfile.syncKey).catch(error => {
            console.warn('Migration start failed', error);
          });
          const result = await syncLatestData(loadedProfile.syncKey, true);
          if (result.success) runTransitionTick(loadedProfile.syncKey);
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
        if (result.success) runTransitionTick(currentProfile.syncKey);
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
      if (token !== null && token === lastChangeTokenRef.current && !lastSyncFailedRef.current) {
        // 1.7.9 상대는 D1이 아니라 Firestore에 쓰므로 D1 토큰이 그대로여도 전환기 읽기는 주기마다 부릅니다(5분 간격은 모듈이 지킴).
        runTransitionTick(syncKey);
        return;
      }
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
          // 410이면 가족이 영구 삭제된 것이므로 재연결하지 않고 평소 동기화를 한 번 요청합니다.
          // 그 동기화가 410을 받아 연결을 끊습니다.
          if (decideAfterTokenError(error).action === 'syncNow') void pullRemoteChanges();
          else scheduleReconnect();
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

    // 폴링은 관문이 'proceed'일 때만 시작합니다(07 2.3). 이전 모듈이 d1Status를 exists로 바꾸거나 이전을 마치면
    // 사건으로 다시 판정해 시작합니다. 시작 전에는 D1 토큰 요청이 나가지 않습니다.
    let pollingStarted = false;
    const startPollingIfAllowed = async () => {
      if (!mounted || pollingStarted) return;
      try {
        const gate = await migratorRef.current!.peekGate(syncKey);
        if (!mounted || pollingStarted || !shouldStartPolling(gate)) return;
        pollingStarted = true;
        void connect();
      } catch (error) {
        console.warn('Polling gate check failed', error);
      }
    };
    const stopWatchingGate = migratorRef.current!.subscribe(event => {
      if (event.syncKey !== syncKey) return;
      if (event.type === 'gateChanged' || event.type === 'completed') void startPollingIfAllowed();
    });
    void startPollingIfAllowed();

    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      // 화면에 돌아왔을 때는 못 올린 기록이 있을 수 있으므로 전체 동기화합니다.
      void pullRemoteChanges();
    });

    return () => {
      mounted = false;
      stopWatchingGate();
      unsubscribe?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
      // 합류 전체 흐름(연결 회차, 1.7.9 가족 합류, 이전 시작)은 이전 모듈의 joinFamily가 맡습니다(07 2.9).
      const result = await handleJoinFamily(syncId, { allowFamilyCreation: false });
      // 실패한 초대는 다시 눌러 재시도할 수 있어야 합니다.
      if (result.success) processedInviteRef.current = syncId;
      if (result.outcome === 'cancelled') {
        Alert.alert('가족 합류 취소', result.error || MIGRATION_MESSAGES.joinCancelled);
        return;
      }
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
        temperature: 'temperature',
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
    // syncLatestData와 같은 이유로 기본값은 false. 가족 만들기와 합류는 이전 모듈의
    // joinFamily(handleJoinFamily)를 거치며, 여기서는 연결 회차를 직접 넣지 않습니다.
    allowFamilyCreation = false,
    forceFullRead = false,
  ) => {
    if (!targetSyncKey || !targetSyncKey.trim()) return { success: false, merged: false, error: 'Empty key' };
    try {
      const result = await syncLatestData(
        targetSyncKey.trim(),
        createBackup,
        allowFamilyCreation,
        forceFullRead,
      );
      if (result.success || result.merged) {
        setLogs(result.logs);
        setProfile(result.profile);
        await refreshFeedingReminder(result.logs, result.profile);
      }
      return { success: result.success, merged: result.merged, error: result.error, migrationPending: result.migrationPending };
    } catch (e) {
      console.error(e);
      return { success: false, merged: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // 합류(초대 링크, 키 입력)와 가족 만들기의 두 진입점은 모두 이 함수만 부릅니다(07 2.9 "합류 진입점").
  // 러너에 넣는 연결 회차는 이전 모듈의 joinFamily가 맡습니다.
  const handleJoinFamily = async (
    targetSyncKey: string,
    options: { allowFamilyCreation?: boolean } = {},
  ): Promise<{ success: boolean; merged: boolean; error?: string; outcome?: JoinOutcome }> => {
    if (!targetSyncKey || !targetSyncKey.trim()) return { success: false, merged: false, error: 'Empty key' };
    setJoinProgress(null);
    try {
      const result = await migratorRef.current!.joinFamily(targetSyncKey.trim(), {
        allowFamilyCreation: options.allowFamilyCreation === true,
      });
      const syncResult = result.syncResult;
      // joined이고 연결 회차가 성공하면 기록과 프로필을 화면에 반영합니다. 실패한 회차라도 앞서 합쳐 저장한
      // 결과(merged)는 저장소에 있으므로 handleSync와 같이 화면에 반영합니다.
      if (syncResult && (syncResult.success || syncResult.merged)) {
        setLogs(syncResult.logs);
        setProfile(syncResult.profile);
        await refreshFeedingReminder(syncResult.logs, syncResult.profile);
      }
      const success = result.outcome === 'joined' && syncResult?.success === true;
      return {
        success,
        merged: syncResult?.merged === true,
        // not_found, deleted, pending_deletion_choice, cancelled, failed는 이전 모듈의 문구를 그대로 보입니다.
        error: success ? undefined : (result.message ?? syncResult?.error ?? JOIN_FALLBACK_MESSAGES[result.outcome]),
        outcome: result.outcome,
      };
    } catch (e) {
      console.error(e);
      return { success: false, merged: false, error: e instanceof Error ? e.message : String(e), outcome: 'failed' };
    } finally {
      setJoinProgress(null);
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
      const result = await handleSync(profile.syncKey, true, false, true);
      // 이전 준비 중(migrationPending)은 실패가 아니므로 경고창을 띄우지 않습니다(07 2.3).
      if (result.success) runTransitionTick(profile.syncKey, true);
      if (shouldAlertOnRefresh(result)) {
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
    return success;
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
    if ('syncKey' in profilePatch) {
      syncRunnerRef.current?.abortActive();
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
            autoVoiceEnabled={autoVoiceEnabled}
            onAutoVoiceEnabledChange={handleAutoVoiceEnabledChange}
            autoStartVoiceRequest={voiceStartRequest}
            onAutoStartVoiceHandled={request => setVoiceStartRequest(current => current === request ? 0 : current)}
            onVoiceRecognitionActivity={active => {
              // The system recognizer may briefly background this Activity. Its return is not a new app launch.
              suppressAutoVoiceUntilRef.current = Date.now() + (active ? 60_000 : 5_000);
            }}
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
      case 'temperature':
        return <LogTemperature onAddLog={handleAddLog} onNavigate={setActiveScreen} />;
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
            onJoinFamily={handleJoinFamily}
            joinProgress={joinProgress}
            onGetMigrationGate={key => migratorRef.current!.peekGate(key)}
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
    if (syncState === 'pending') return { color: COLORS.textMuted, label: '이전 준비 중' };
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
        paddingTop: activeScreen === 'formula' || activeScreen === 'diaper' || activeScreen === 'bath' || activeScreen === 'weight' || activeScreen === 'temperature' ? insets.top : 0
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
