import React, { useState, useEffect, useRef } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TextInput, 
  TouchableOpacity, 
  ScrollView, 
  Alert,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Share,
  Linking,
} from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { checkForAppUpdate, downloadAndInstallApk } from '../utils/appUpdater';
import { BabyProfile, BabyLogEntry } from '../types';
import { COLORS } from '../theme/colors';
import { getLogs, getLocalBackup, restoreFromLocalBackup } from '../database/storage';
import { createFamilyInviteLink, createFamilySyncId, parseFamilySyncId, FamilyDeletionStatus } from '../database/sync';

const PRIVACY_POLICY_URL = 'https://seonggi.github.io/baby_check/privacy-policy.html';

interface ProfileProps {
  profile: BabyProfile;
  onSaveProfile: (profile: Partial<BabyProfile>, syncInBackground?: boolean) => Promise<boolean>;
  onImportData: (profile: BabyProfile, logs: BabyLogEntry[]) => Promise<void>;
  onRestoreData: (profile: BabyProfile, logs: BabyLogEntry[]) => Promise<void>;
  onSync: (
    syncKey: string,
    createBackup?: boolean,
    allowFamilyCreation?: boolean,
    connecting?: boolean,
  ) => Promise<{ success: boolean; merged: boolean; error?: string }>;
  onDeleteFamilyData: (syncKey: string) => Promise<{ success: boolean; error?: string; partiallyDeleted?: boolean }>;
  onScheduleFamilyDeletion: (syncKey: string) => Promise<{ success: boolean; readyAt?: number; error?: string }>;
  onCancelFamilyDeletion: (syncKey: string) => Promise<{ success: boolean; error?: string }>;
  onGetFamilyDeletionStatus: (syncKey: string) => Promise<FamilyDeletionStatus>;
}

export const Profile: React.FC<ProfileProps> = ({
  profile,
  onSaveProfile,
  onImportData,
  onRestoreData,
  onSync,
  onDeleteFamilyData,
  onScheduleFamilyDeletion,
  onCancelFamilyDeletion,
  onGetFamilyDeletionStatus,
}) => {
  const [name, setName] = useState(profile.name);
  const [birthDate, setBirthDate] = useState(profile.birthDate);
  const [birthWeight, setBirthWeight] = useState(profile.birthWeight);
  const [targetFormula, setTargetFormula] = useState(profile.targetFormula.toString());
  const [feedingReminderEnabled, setFeedingReminderEnabled] = useState(profile.feedingReminderEnabled === true);
  const [feedingIntervalMinutes, setFeedingIntervalMinutes] = useState(
    String(profile.feedingIntervalMinutes || 180),
  );

  type EditableProfileField =
    | 'name'
    | 'birthDate'
    | 'birthWeight'
    | 'targetFormula'
    | 'feedingReminderEnabled'
    | 'feedingIntervalMinutes';
  const dirtyFieldsRef = useRef(new Set<EditableProfileField>());
  const markEdited = (field: EditableProfileField) => { dirtyFieldsRef.current.add(field); };
  const buildProfilePatch = (): Partial<BabyProfile> => {
    const dirty = dirtyFieldsRef.current;
    const patch: Partial<BabyProfile> = {};
    if (dirty.has('name')) patch.name = name.trim();
    if (dirty.has('birthDate')) patch.birthDate = birthDate;
    if (dirty.has('birthWeight')) patch.birthWeight = String(Number(birthWeight));
    if (dirty.has('targetFormula')) patch.targetFormula = parseInt(targetFormula) || 800;
    if (dirty.has('feedingReminderEnabled')) patch.feedingReminderEnabled = feedingReminderEnabled;
    if (dirty.has('feedingIntervalMinutes')) {
      patch.feedingIntervalMinutes = Math.min(720, Math.max(30, parseInt(feedingIntervalMinutes) || 180));
    }
    return patch;
  };

  // Sync inputs if profile values update from parent (e.g. edited from dashboard)
  useEffect(() => {
    if (!dirtyFieldsRef.current.has('name')) setName(profile.name);
    if (!dirtyFieldsRef.current.has('birthDate')) setBirthDate(profile.birthDate);
    if (!dirtyFieldsRef.current.has('birthWeight')) setBirthWeight(profile.birthWeight);
    if (!dirtyFieldsRef.current.has('targetFormula')) setTargetFormula(profile.targetFormula.toString());
    if (!dirtyFieldsRef.current.has('feedingReminderEnabled')) {
      setFeedingReminderEnabled(profile.feedingReminderEnabled === true);
    }
    if (!dirtyFieldsRef.current.has('feedingIntervalMinutes')) {
      setFeedingIntervalMinutes(String(profile.feedingIntervalMinutes || 180));
    }
    setSyncKey(profile.syncKey || '');
  }, [profile]);
  const [isSaving, setIsSaving] = useState(false);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [syncKey, setSyncKey] = useState(profile.syncKey || '');
  const [inviteInput, setInviteInput] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [showDeleteFamilyConfirm, setShowDeleteFamilyConfirm] = useState(false);
  const [deleteFamilyConfirmText, setDeleteFamilyConfirmText] = useState('');
  const [isProcessingDeletion, setIsProcessingDeletion] = useState(false);
  const [deletionStatus, setDeletionStatus] = useState<FamilyDeletionStatus | null>(null);
  const DELETE_FAMILY_CONFIRM_PHRASE = '삭제합니다';

  // 가족 서버 데이터 삭제 예약 상태 로드. 냉각 기간이 이미 지났다면 별도
  // 확인 없이 바로 실행합니다 — 사용자가 예약할 때 이미 한 번 확인했고,
  // 그 뒤로 계속 취소할 기회가 있었기 때문입니다(휴지통 자동 비우기와 동일한 방식).
  useEffect(() => {
    if (!profile.syncKey) {
      setDeletionStatus(null);
      return;
    }
    let cancelled = false;
    const key = profile.syncKey;
    onGetFamilyDeletionStatus(key).then(async status => {
      if (cancelled) return;
      if (status.scheduled && status.canDeleteNow) {
        const result = await onDeleteFamilyData(key);
        if (cancelled) return;
        if (result.success) {
          setSyncKey('');
          setDeletionStatus(null);
          Alert.alert('삭제 완료', '예약된 가족 서버 데이터 영구 삭제가 자동으로 실행됐습니다. 이 휴대폰의 기록은 그대로 남아 있습니다.');
        } else {
          // 실행이 실패하면(예: 오프라인) 수동으로 다시 시도할 수 있게 상태를 보여줍니다.
          setDeletionStatus(status);
          if (result.partiallyDeleted) {
            Alert.alert(
              '일부만 삭제됨',
              `자동 삭제가 도중에 실패했지만, 이미 일부 데이터는 서버에서 지워졌습니다.\n\n[상세 오류]: ${result.error || ''}\n\n"다시 시도"를 눌러 나머지를 마저 지워주세요.`,
            );
          }
        }
        return;
      }
      setDeletionStatus(status);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [profile.syncKey]);

  // 최근 백업 시간 로드
  useEffect(() => {
    const loadBackupInfo = async () => {
      const backup = await getLocalBackup();
      if (backup) {
        const d = new Date(backup.timestamp);
        setLastBackupTime(
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        );
      }
    };
    loadBackupInfo();
  }, []);

  const handleRestoreBackup = async () => {
    Alert.alert(
      '로컬 백업 복원',
      `마지막 동기화 직전 상태로 데이터를 되돌립니다.\n\n이 작업은 현재 데이터를 덮어씁니다. 계속하시겠습니까?`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '복원 실행',
          style: 'destructive',
          onPress: async () => {
            const result = await restoreFromLocalBackup();
            if (result.success && result.backup) {
              await onRestoreData(result.backup.profile, result.backup.logs);
              const d = new Date(result.backup.timestamp);
              const timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
              Alert.alert('복원 완료', `${timeStr} 시점의 데이터로 복원하고 화면과 가족 동기화에 반영했습니다.`);
            } else {
              Alert.alert('복원 실패', '저장된 로컬 백업이 없습니다. 동기화를 한 번 수행한 후에 사용할 수 있습니다.');
            }
          },
        },
      ]
    );
  };

  const handleScheduleFamilyDeletion = () => {
    if (!profile.syncKey) return;
    if (deleteFamilyConfirmText.trim() !== DELETE_FAMILY_CONFIRM_PHRASE) return;
    Alert.alert(
      '마지막 확인',
      '가족 서버 데이터 영구 삭제를 예약합니다. 1시간 뒤에 별도 확인 없이 자동으로 지워지며, 그 전까지는 취소할 수 있습니다. 배우자의 기록도 함께 지워집니다. 예약하시겠습니까?',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제 예약',
          style: 'destructive',
          onPress: async () => {
            setIsProcessingDeletion(true);
            try {
              const result = await onScheduleFamilyDeletion(profile.syncKey!);
              if (result.success) {
                setDeletionStatus({ scheduled: true, readyAt: result.readyAt, canDeleteNow: false });
                setShowDeleteFamilyConfirm(false);
                setDeleteFamilyConfirmText('');
                Alert.alert('삭제 예약됨', '1시간 뒤에 가족 서버 데이터가 자동으로 영구 삭제됩니다. 그 전까지는 이 화면에서 취소할 수 있습니다.');
              } else {
                Alert.alert('예약 실패', result.error || '알 수 없는 오류가 발생했습니다.');
              }
            } finally {
              setIsProcessingDeletion(false);
            }
          },
        },
      ],
    );
  };

  const handleCancelFamilyDeletion = () => {
    if (!profile.syncKey) return;
    setIsProcessingDeletion(true);
    onCancelFamilyDeletion(profile.syncKey)
      .then(result => {
        if (result.success) {
          setDeletionStatus({ scheduled: false, canDeleteNow: false });
          Alert.alert('취소 완료', '가족 서버 데이터 삭제 예약을 취소했습니다.');
        } else {
          Alert.alert('취소 실패', result.error || '알 수 없는 오류가 발생했습니다.');
        }
      })
      .finally(() => setIsProcessingDeletion(false));
  };

  const handleExecuteFamilyDeletion = () => {
    if (!profile.syncKey) return;
    Alert.alert(
      '마지막 확인',
      '가족 서버 데이터를 지금 영구히 삭제합니다. 배우자의 기록을 포함해 되돌릴 수 없습니다. 정말 진행하시겠습니까?',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '영구 삭제',
          style: 'destructive',
          onPress: async () => {
            setIsProcessingDeletion(true);
            try {
              const result = await onDeleteFamilyData(profile.syncKey!);
              if (result.success) {
                setSyncKey('');
                setDeletionStatus(null);
                Alert.alert('삭제 완료', '가족 서버 데이터를 삭제했습니다. 이 휴대폰의 기록은 그대로 남아 있습니다.');
              } else if (result.partiallyDeleted) {
                Alert.alert(
                  '일부만 삭제됨',
                  `도중에 실패했지만, 이미 일부 데이터는 서버에서 지워졌습니다.\n\n[상세 오류]: ${result.error || ''}\n\n"다시 시도"를 눌러 나머지를 마저 지워주세요.`,
                );
              } else {
                Alert.alert('삭제 실패', result.error || '알 수 없는 오류가 발생했습니다.');
              }
            } finally {
              setIsProcessingDeletion(false);
            }
          },
        },
      ],
    );
  };

  const connectFamily = async (
    newSyncId: string,
    showSuccess = true,
    allowFamilyCreation = false,
  ): Promise<boolean> => {
    setIsSyncing(true);
    try {
      if (profile.syncKey && profile.syncKey !== newSyncId) {
        Alert.alert(
          '다른 가족에 연결되어 있어요',
          '기록이 서로 섞이지 않도록 기존 가족 연결을 먼저 해제해 주세요.',
        );
        return false;
      }
      const updatedProfile = buildProfilePatch();
      
      // 아래의 명시적 동기화가 가족 가입과 첫 데이터 병합을 맡습니다.
      // 프로필 저장에서 또 백그라운드 동기화를 시작하면 같은 작업이 두 번
      // 대기열에 들어가 연결 화면이 불필요하게 오래 걸립니다.
      const saved = await onSaveProfile(updatedProfile, false);
      
      if (saved) {
        dirtyFieldsRef.current.clear();
        const result = await onSync(newSyncId, true, allowFamilyCreation, true);
        if (result.success) {
          setSyncKey(newSyncId);
          if (showSuccess) {
            Alert.alert(
              '가족 연결 완료',
              '이제 두 휴대폰의 기록이 앱 실행 중 자동으로 동기화됩니다.',
            );
          }
          return true;
        } else {
          Alert.alert(
            '가족 연결 실패',
            `서버에 연결하지 못했습니다.\n\n[상세 오류]: ${result.error || '알 수 없는 오류'}`,
          );
          return false;
        }
      }
      return false;
    } catch (e) {
      console.error(e);
      Alert.alert('오류', '동기화 설정 중 오류가 발생했습니다.');
      return false;
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCreateFamily = async () => {
    const newSyncId = createFamilySyncId();
    const connected = await connectFamily(newSyncId, false, true);
    if (!connected) return;
    const inviteLink = createFamilyInviteLink(newSyncId);
    await Share.share({
      title: '아기기록 가족 초대',
      message: `아기기록 앱에서 이 링크를 눌러 가족 기록에 연결하세요.\n${inviteLink}`,
    });
  };

  const handleManualSync = async () => {
    if (!syncKey || isSyncing) return;

    setIsSyncing(true);
    try {
      const result = await onSync(syncKey);
      if (result.success) {
        Alert.alert(
          '동기화 완료',
          result.merged
            ? '상대방 기기의 변경사항을 받아와 합쳤습니다.'
            : '서버와 확인을 마쳤습니다. 새로운 변경사항은 없습니다.',
        );
      } else {
        Alert.alert(
          '동기화 실패',
          `서버에 연결하지 못했습니다.\n\n[상세 오류]: ${result.error || '알 수 없는 오류'}`,
        );
      }
    } catch (error) {
      Alert.alert(
        '동기화 실패',
        `예상하지 못한 오류가 발생했습니다.\n\n[상세 오류]: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const handleJoinFamily = async () => {
    const syncId = /^babycheck:\/\/family\/[a-f0-9]{32}$/i.test(inviteInput.trim())
      ? parseFamilySyncId(inviteInput)
      : null;
    if (!syncId) {
      Alert.alert('초대 확인', '받은 가족 초대 링크를 붙여넣어 주세요.');
      return;
    }
    const connected = await connectFamily(syncId, true, false);
    if (connected) setInviteInput('');
  };

  const handleShareFamilyInvite = async () => {
    if (!syncKey) return;
    const inviteLink = createFamilyInviteLink(syncKey);
    await Share.share({
      title: '아기기록 가족 초대',
      message: `아기기록 앱에서 이 링크를 눌러 가족 기록에 연결하세요.\n${inviteLink}`,
    });
  };

  const handleDisconnectFamily = () => {
    Alert.alert('가족 연결 해제', '이 휴대폰의 자동 동기화를 중지할까요?', [
      { text: '취소', style: 'cancel' },
      {
        text: '연결 해제',
        style: 'destructive',
        onPress: async () => {
          const saved = await onSaveProfile({ syncKey: undefined });
          if (saved) {
            setSyncKey('');
            Alert.alert('연결 해제 완료', '이 휴대폰의 기록은 그대로 유지됩니다.');
          }
        },
      },
    ]);
  };

  const handleCheckUpdates = async () => {
    // GitHub Releases 기반 자체 업데이트 – 디버그/릴리즈 모드 모두 작동.
    // 정식 스토어 출시 전까지의 임시 배포 경로입니다.
    setIsCheckingUpdates(true);
    try {
      const info = await checkForAppUpdate();

      if (!info.hasUpdate) {
        Alert.alert('최신 버전', `현재 최신 버전(${info.currentVersion})을 사용하고 있습니다.`);
        return;
      }

      if (!info.apkDownloadUrl) {
        Alert.alert(
          '업데이트 안내',
          `새 버전(${info.latestVersion})이 있지만 APK 파일을 찾을 수 없습니다.\nGitHub에서 직접 다운로드해 주세요.`
        );
        return;
      }

      Alert.alert(
        `새 버전 발견: ${info.latestVersion}`,
        `현재 버전: ${info.currentVersion}\n\n${info.releaseNotes ? info.releaseNotes.slice(0, 200) : '새 업데이트가 준비되었습니다.'}\n\nAPK를 다운로드하고 설치하시겠습니까?`,
        [
          { text: '나중에', style: 'cancel' },
          {
            text: '지금 업데이트',
            onPress: async () => {
              setIsCheckingUpdates(true);
              try {
                await downloadAndInstallApk(
                  info.apkDownloadUrl!,
                  (pct) => console.log(`다운로드 중: ${pct}%`)
                );
              } catch (err) {
                Alert.alert(
                  '설치 실패',
                  '업데이트 설치 중 오류가 발생했습니다: ' +
                    (err instanceof Error ? err.message : String(err))
                );
              } finally {
                setIsCheckingUpdates(false);
              }
            },
          },
        ]
      );
    } catch (e) {
      console.error(e);
      const errMsg = e instanceof Error ? e.message : String(e);
      Alert.alert(
        '업데이트 확인 실패',
        `GitHub에서 업데이트 정보를 가져오지 못했습니다.\n\n[상세 오류]: ${errMsg}`
      );
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleExport = async () => {
    try {
      const allLogs = await getLogs();
      // 백업 파일에는 가족 초대 키(syncKey)를 포함하지 않아 다른 사람이나 기기에 공유되어도
      // 우리 가족의 실시간 동기화 공간이 무단 노출되거나 오염되지 않도록 보호합니다.
      const { syncKey: _unusedSyncKey, ...exportProfile } = profile;
      const backupData = {
        version: 1,
        backupDate: Date.now(),
        profile: exportProfile,
        logs: allLogs,
      };
      // Expo 56 FileSystem의 안전한 문서 저장소에 폴더를 자동으로 만듭니다.
      // 폴더 선택 권한이나 존재 여부 때문에 백업이 실패하지 않습니다.
      const directory = new Directory(Paths.document, 'BabyCheck');
      directory.create({ idempotent: true, intermediates: true });
      const date = new Date();
      const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
      const backupFile = new File(directory, `baby-check-backup-${datePart}.json`);
      backupFile.create({ overwrite: true });
      backupFile.write(JSON.stringify(backupData, null, 2));

      // iOS 및 모바일 기기에서 사용자가 파일 앱 저장, AirDrop, 메신저 등으로 전달할 수 있도록 공유 시트를 엽니다.
      const isSharingAvailable = await Sharing.isAvailableAsync().catch(() => false);
      if (isSharingAvailable) {
        await Sharing.shareAsync(backupFile.uri, {
          mimeType: 'application/json',
          dialogTitle: '아기기록 백업 파일 내보내기',
          UTI: 'public.json',
        });
      } else {
        Alert.alert('내보내기 성공', `기기 저장소의 BabyCheck 폴더에 ${backupFile.name} 파일을 저장했습니다.`);
      }
    } catch (e) {
      if (String(e).toLowerCase().includes('cancel')) return;
      console.error(e);
      Alert.alert('내보내기 실패', `백업 파일을 저장하거나 공유하지 못했습니다.\n${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleImport = async () => {
    try {
      const picked = await File.pickFileAsync({ mimeTypes: ['application/json', 'text/plain'] });
      if (picked.canceled) return;
      const parsedData = JSON.parse(await picked.result.text());
      if (!parsedData.profile || !Array.isArray(parsedData.logs)) {
        Alert.alert('복원 실패', '올바르지 않은 백업 데이터 포맷입니다.');
        return;
      }

      Alert.alert(
        '데이터 복원 확인',
        '현재 기기와 백업의 기록을 안전하게 합칩니다. 같은 기록은 최신 수정본을 사용하며 기존 기록은 삭제하지 않습니다. 진행하시겠습니까?',
        [
          { text: '취소', style: 'cancel' },
          { 
            text: '복원하기', 
            style: 'destructive',
            onPress: async () => {
              try {
                await onImportData(parsedData.profile, parsedData.logs);
                Alert.alert('복원 성공', '기존 기록을 보존하면서 백업 데이터를 성공적으로 합쳤습니다.');
              } catch (e) {
                console.error(e);
                Alert.alert('오류', '데이터 저장 중 문제가 발생했습니다.');
              }
            }
          }
        ]
      );
    } catch (e) {
      if (String(e).toLowerCase().includes('cancel')) return;
      Alert.alert('복원 실패', '올바른 아기기록 백업 파일인지 확인해 주세요.');
    }
  };

  const handleSave = async () => {
    // Basic validations
    if (!name.trim()) {
      Alert.alert('입력 확인', '아기 이름을 입력해 주세요.');
      return;
    }
    
    // YYYY-MM-DD regex check
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(birthDate)) {
      Alert.alert('입력 확인', '생년월일을 YYYY-MM-DD 형식으로 입력해 주세요. (예: 2026-06-25)');
      return;
    }
    const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
    const parsedBirthDate = new Date(birthYear, birthMonth - 1, birthDay);
    const isRealBirthDate = parsedBirthDate.getFullYear() === birthYear
      && parsedBirthDate.getMonth() === birthMonth - 1
      && parsedBirthDate.getDate() === birthDay;
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (!isRealBirthDate || parsedBirthDate.getTime() > today.getTime()) {
      Alert.alert('입력 확인', '실제로 존재하며 오늘보다 늦지 않은 생년월일을 입력해 주세요.');
      return;
    }

    const weightNum = parseFloat(birthWeight);
    if (isNaN(weightNum) || weightNum <= 0) {
      Alert.alert('입력 확인', '출생 체중을 올바른 숫자로 입력해 주세요.');
      return;
    }

    const goalNum = parseInt(targetFormula);
    if (isNaN(goalNum) || goalNum <= 0) {
      Alert.alert('입력 확인', '하루 권장 분유 목표량을 숫자로 입력해 주세요.');
      return;
    }

    setIsSaving(true);
    try {
      const updatedProfile = buildProfilePatch();

      const success = await onSaveProfile(updatedProfile);
      // 저장에 실패했다면 입력칸을 계속 보호해야 사용자가 적은 내용이 남습니다.
      if (success) dirtyFieldsRef.current.clear();
      if (success) {
        Alert.alert('저장 완료', '아기 프로필이 안전하게 저장되었습니다.');
      } else {
        Alert.alert('오류', '프로필 저장 중 오류가 발생했습니다.');
      }
    } catch (e) {
      console.error(e);
      Alert.alert('오류', '프로필 저장 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      style={styles.keyboardView}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
        <Text style={styles.screenTitle}>아기 프로필 설정</Text>
        <Text style={styles.subtitle}>우리아기의 소중한 정보를 설정하고 관리합니다. ❤️</Text>

        <View style={styles.formCard}>
          {/* Baby Name */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>아기 이름 / 태명</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={value => { markEdited('name'); setName(value); }}
              placeholder="예: 꼬꼬마"
              placeholderTextColor={COLORS.textMuted}
            />
          </View>

          {/* Birth Date */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>태어난 날짜 (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.input}
              value={birthDate}
              onChangeText={value => { markEdited('birthDate'); setBirthDate(value); }}
              placeholder="예: 2026-06-25"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="number-pad"
            />
          </View>

          {/* Birth Weight */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>출생 체중 (kg)</Text>
            <TextInput
              style={styles.input}
              value={birthWeight}
              onChangeText={value => { markEdited('birthWeight'); setBirthWeight(value); }}
              placeholder="예: 3.2"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="decimal-pad"
            />
          </View>

          {/* Target Formula ml */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>하루 권장 수유 목표량 (ml)</Text>
            <TextInput
              style={styles.input}
              value={targetFormula}
              onChangeText={value => { markEdited('targetFormula'); setTargetFormula(value); }}
              placeholder="예: 800"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="number-pad"
            />
          </View>
        </View>

        <View style={styles.backupCard}>
          <View style={styles.reminderHeader}>
            <View style={styles.reminderText}>
              <Text style={styles.backupTitle}>🍼 다음 수유 자동 알림</Text>
              <Text style={styles.backupDesc}>
                수유를 기록하면 다음 시간을 자동 계산해 기기 화면 상단과 알림창에 알려줍니다.
              </Text>
            </View>
            <Switch
              value={feedingReminderEnabled}
              onValueChange={value => { markEdited('feedingReminderEnabled'); setFeedingReminderEnabled(value); }}
              trackColor={{ false: COLORS.border, true: COLORS.primary + '80' }}
              thumbColor={feedingReminderEnabled ? COLORS.primary : '#FFFFFF'}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>수유 간격 (분)</Text>
            <TextInput
              style={styles.input}
              value={feedingIntervalMinutes}
              onChangeText={value => { markEdited('feedingIntervalMinutes'); setFeedingIntervalMinutes(value.replace(/[^0-9]/g, '')); }}
              keyboardType="number-pad"
              placeholder="예: 180"
              placeholderTextColor={COLORS.textMuted}
            />
            <View style={styles.intervalPresets}>
              {[120, 150, 180, 210, 240].map(minutes => (
                <TouchableOpacity
                  key={minutes}
                  style={[
                    styles.intervalPreset,
                    feedingIntervalMinutes === String(minutes) && styles.intervalPresetActive,
                  ]}
                  onPress={() => { markEdited('feedingIntervalMinutes'); setFeedingIntervalMinutes(String(minutes)); }}
                >
                  <Text
                    style={[
                      styles.intervalPresetText,
                      feedingIntervalMinutes === String(minutes) && styles.intervalPresetTextActive,
                    ]}
                  >
                    {minutes / 60 >= 1
                      ? `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`
                      : `${minutes}분`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.reminderHint}>30~720분 사이로 설정할 수 있어요. 변경 후 아래 저장 버튼을 눌러주세요.</Text>
          </View>
        </View>

        {/* Save Button */}
        <TouchableOpacity 
          style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={isSaving}
        >
          <Text style={styles.saveButtonText}>
            {isSaving ? '저장 중...' : '프로필 수정 완료'}
          </Text>
        </TouchableOpacity>

        {/* Real-time Cloud Sync Card */}
        <View style={styles.backupCard}>
          <Text style={styles.backupTitle}>🔗 실시간 데이터 동기화</Text>
          <Text style={styles.backupDesc}>
            비밀번호나 그룹 키를 정할 필요 없이 가족 초대 링크로 두 휴대폰을 연결합니다. 앱을 사용 중이면 변경 기록이 자동으로 반영됩니다.
          </Text>

          {syncKey ? (
            <>
              <Text style={styles.reminderHint}>✅ 이 휴대폰은 가족 기록에 연결되어 있습니다.</Text>
              <TouchableOpacity
                style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
                onPress={handleManualSync}
                disabled={isSyncing}
              >
                <Text style={styles.syncButtonText}>{isSyncing ? '동기화 확인 중...' : '지금 동기화 🔄'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.syncButton, { marginTop: 10 }]} onPress={handleShareFamilyInvite}>
                <Text style={styles.syncButtonText}>다른 보호자 초대하기 💌</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.restoreButton} onPress={handleDisconnectFamily}>
                <Text style={styles.restoreButtonText}>이 휴대폰 연결 해제</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
                onPress={handleCreateFamily}
                disabled={isSyncing}
              >
                <Text style={styles.syncButtonText}>
                  {isSyncing ? '가족 연결 준비 중...' : '새 가족 연결 만들기 💌'}
                </Text>
              </TouchableOpacity>
              <Text style={[styles.label, { marginTop: 18 }]}>상대방에게 받은 초대 링크</Text>
              <TextInput
                style={styles.input}
                value={inviteInput}
                onChangeText={setInviteInput}
                placeholder="babycheck:// 로 시작하는 링크 붙여넣기"
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[styles.syncButton, { marginTop: 10 }, isSyncing && styles.syncButtonDisabled]}
                onPress={handleJoinFamily}
                disabled={isSyncing}
              >
                <Text style={styles.syncButtonText}>받은 초대로 연결하기</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Data Backup & Restore Card */}
        <View style={styles.backupCard}>
          <Text style={styles.backupTitle}>📂 데이터 백업 및 복원</Text>
          <Text style={styles.backupDesc}>백업 파일을 저장하거나 다른 기기에서 받은 백업 파일을 선택해 기록을 옮길 수 있습니다.</Text>
          
          <View style={styles.backupButtonsRow}>
            <TouchableOpacity style={styles.backupButton} onPress={handleExport}>
              <Text style={styles.backupButtonText}>데이터 내보내기 📤</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.backupButton, { backgroundColor: COLORS.secondary }]} 
              onPress={handleImport}
            >
              <Text style={styles.backupButtonText}>데이터 가져오기 📥</Text>
            </TouchableOpacity>
          </View>

          {/* 로컬 백업 복원 */}
          <View style={styles.restoreSection}>
            <Text style={styles.restoreLabel}>
              {lastBackupTime
                ? `📅 최근 로컬 백업: ${lastBackupTime}`
                : '📅 로컬 백업 없음 (동기화 수행 시 자동 생성)'}
            </Text>
            <TouchableOpacity
              style={[styles.restoreButton, !lastBackupTime && styles.restoreButtonDisabled]}
              onPress={handleRestoreBackup}
              disabled={!lastBackupTime}
            >
              <Text style={styles.restoreButtonText}>로컬 백업에서 복원 ⏮️</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* GitHub Releases 기반 자체 업데이트. APK 설치는 Android 전용입니다. */}
        {Platform.OS === 'android' && (
          <View style={styles.backupCard}>
            <Text style={styles.backupTitle}>⚡ 앱 업데이트 확인</Text>
            <Text style={styles.backupDesc}>새로운 기능이나 버그 수정사항이 배포되면 앱을 무선(OTA)으로 최신 상태로 업데이트합니다.</Text>
            <TouchableOpacity
              style={[styles.updateButton, isCheckingUpdates && styles.updateButtonDisabled]}
              onPress={handleCheckUpdates}
              disabled={isCheckingUpdates}
            >
              <Text style={styles.updateButtonText}>
                {isCheckingUpdates ? '업데이트 확인 중...' : '앱 자동 업데이트 확인 🔄'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {/* 개인정보 보호 및 데이터 관리 (Apple App Store 가이드라인 준수) */}
        <View style={styles.backupCard}>
          <Text style={styles.backupTitle}>🔒 개인정보 보호 및 데이터 관리</Text>
          <Text style={styles.backupDesc}>
            아기기록은 사용자의 개인정보를 소중히 다룹니다. 계정은 익명으로 안전하게 생성되며, 이름과 수유 기록은 가족 연결 시에만 암호화된 통신으로 보호자 간 공유됩니다.
          </Text>
          <View style={styles.privacyNoteBox}>
            <Text style={styles.privacyNoteText}>
              ℹ️ 안내: 가족 연결 해제는 기기 간 실시간 동기화만 중단하며, 서버의 가족 기록은 남습니다.
              서버에 저장된 가족 기록까지 완전히 지우려면 아래 "가족 서버 데이터 영구 삭제"를 사용하세요.
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.restoreButton, { marginTop: 12, borderColor: COLORS.border }]}
            onPress={() => {
              Alert.alert(
                '개인정보 처리 및 보관 방침',
                '1. 수집 항목: 아기 이름/태명, 생년월일, 출생 체중, 수유/배변/목욕/체중 기록\n' +
                '2. 보관 방법: 사용자 기기 내 로컬 저장소에 우선 보관되며, 가족 연결 시 Firebase 클라우드를 통해 가족 간에만 동기화됩니다.\n' +
                '3. 제3자 제공: 광고 식별자나 마케팅 목적의 개인정보 제3자 제공은 일체 없습니다.\n' +
                '4. 문의 및 삭제: 가족 연결 해제 및 "가족 서버 데이터 영구 삭제" 기능을 통해 언제든지 데이터를 관리할 수 있습니다.',
                [{ text: '확인' }],
              );
            }}
          >
            <Text style={styles.restoreButtonText}>개인정보처리방침 요약 보기 📋</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.restoreButton, { marginTop: 10, borderColor: COLORS.border }]}
            onPress={() => {
              Linking.openURL(PRIVACY_POLICY_URL).catch(() => {
                Alert.alert('열기 실패', '개인정보처리방침 페이지를 열지 못했습니다.');
              });
            }}
          >
            <Text style={styles.restoreButtonText}>개인정보처리방침 전문 보기 🔗</Text>
          </TouchableOpacity>

          {!!profile.syncKey && (
            <View style={styles.dangerZone}>
              {deletionStatus?.scheduled ? (
                <>
                  <Text style={styles.dangerWarningText}>
                    {deletionStatus.canDeleteNow
                      ? '⚠️ 예약 시각이 지나 자동 삭제를 시도했지만 실패했습니다(오프라인 등). 아래 버튼으로 다시 시도할 수 있습니다.'
                      : `⏳ 가족 서버 데이터 삭제가 예약되어 있습니다. ${deletionStatus.readyAt ? new Date(deletionStatus.readyAt).toLocaleString('ko-KR') : ''}에 별도 확인 없이 자동으로 삭제됩니다. 그 전까지는 취소할 수 있습니다.`}
                  </Text>
                  <View style={styles.backupButtonsRow}>
                    <TouchableOpacity
                      style={styles.backupButton}
                      onPress={handleCancelFamilyDeletion}
                      disabled={isProcessingDeletion}
                    >
                      <Text style={styles.backupButtonText}>삭제 예약 취소</Text>
                    </TouchableOpacity>
                    {deletionStatus.canDeleteNow && (
                      <TouchableOpacity
                        style={[styles.dangerButton, { flex: 1 }, isProcessingDeletion && styles.restoreButtonDisabled]}
                        onPress={handleExecuteFamilyDeletion}
                        disabled={isProcessingDeletion}
                      >
                        <Text style={styles.dangerButtonText}>
                          {isProcessingDeletion ? '처리 중...' : '다시 시도'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </>
              ) : !showDeleteFamilyConfirm ? (
                <TouchableOpacity
                  style={styles.dangerButton}
                  onPress={() => setShowDeleteFamilyConfirm(true)}
                >
                  <Text style={styles.dangerButtonText}>가족 서버 데이터 영구 삭제 🗑️</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <Text style={styles.dangerWarningText}>
                    ⚠️ 배우자를 포함한 가족 전체의 서버 기록(수유·기저귀 등 모든 기록, 공유 프로필,
                    가족 연결)이 영구히 삭제됩니다. 되돌릴 수 없습니다. 이 기기의 로컬 기록은
                    지워지지 않습니다. 진행 전 "데이터 내보내기"로 백업하는 것을 권장합니다.
                    {'\n\n'}예약을 누르면 즉시 지워지지 않고, 1시간 뒤에 별도 확인 없이 자동으로
                    삭제됩니다. 그 전까지는 언제든 취소할 수 있습니다.
                  </Text>
                  <TextInput
                    style={styles.input}
                    value={deleteFamilyConfirmText}
                    onChangeText={setDeleteFamilyConfirmText}
                    placeholder={`확인을 위해 "${DELETE_FAMILY_CONFIRM_PHRASE}" 입력`}
                    placeholderTextColor={COLORS.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View style={styles.backupButtonsRow}>
                    <TouchableOpacity
                      style={styles.backupButton}
                      onPress={() => {
                        setShowDeleteFamilyConfirm(false);
                        setDeleteFamilyConfirmText('');
                      }}
                      disabled={isProcessingDeletion}
                    >
                      <Text style={styles.backupButtonText}>취소</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.dangerButton,
                        { flex: 1 },
                        (deleteFamilyConfirmText.trim() !== DELETE_FAMILY_CONFIRM_PHRASE || isProcessingDeletion)
                          && styles.restoreButtonDisabled,
                      ]}
                      onPress={handleScheduleFamilyDeletion}
                      disabled={deleteFamilyConfirmText.trim() !== DELETE_FAMILY_CONFIRM_PHRASE || isProcessingDeletion}
                    >
                      <Text style={styles.dangerButtonText}>
                        {isProcessingDeletion ? '처리 중...' : '1시간 뒤 자동 삭제 예약'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          )}
        </View>

        {/* Info Box */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>💡 신생아 상식 꿀팁!</Text>
          <Text style={styles.infoText}>
            • 생후 1개월 신생아의 하루 총 분유 수유량은 약 600~900ml가 표준입니다.
          </Text>
          <Text style={styles.infoText}>
            • 아기가 한 번에 너무 많이 먹으면 게워내기 쉬우니 D-day 기준 몸무게를 고려해 조금씩 나눠 수유해 주세요.
          </Text>
          <Text style={styles.infoText}>
            • 대소변 색상이나 횟수가 평소와 확연히 다를 땐 타임라인의 메모 기능을 활용하여 소아과 상담 시 지참하세요.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  keyboardView: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginBottom: 20,
  },
  formCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: COLORS.text,
    backgroundColor: COLORS.background,
  },
  saveButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
    marginBottom: 20,
  },
  saveButtonDisabled: {
    backgroundColor: COLORS.textMuted,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  infoCard: {
    backgroundColor: COLORS.lightYellow,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.accent + '30',
  },
  infoTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#B37D00',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 12,
    color: '#666666',
    lineHeight: 18,
    marginBottom: 6,
  },
  backupCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 18,
    width: '100%',
    alignSelf: 'stretch',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  backupTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 6,
    flexShrink: 1,
  },
  backupDesc: {
    fontSize: 12,
    color: COLORS.textMuted,
    lineHeight: 18,
    marginBottom: 16,
  },
  reminderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  reminderText: {
    flex: 1,
    paddingRight: 12,
  },
  reminderHint: {
    color: COLORS.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 7,
  },
  intervalPresets: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  intervalPreset: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: COLORS.background,
  },
  intervalPresetActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary + '15',
  },
  intervalPresetText: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  intervalPresetTextActive: {
    color: COLORS.primary,
    fontWeight: 'bold',
  },
  backupButtonsRow: {
    gap: 10,
  },
  backupButton: {
    width: '100%',
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  backupButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  updateButton: {
    backgroundColor: COLORS.secondary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
    marginTop: 8,
  },
  updateButtonDisabled: {
    backgroundColor: COLORS.textMuted,
  },
  updateButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  syncButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
    marginTop: 4,
  },
  syncButtonDisabled: {
    backgroundColor: COLORS.textMuted,
  },
  syncButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
    textAlign: 'center',
    paddingHorizontal: 8,
    flexShrink: 1,
  },
  restoreSection: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  restoreLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginBottom: 8,
  },
  restoreButton: {
    backgroundColor: '#FF8C42',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginTop: 10,
  },
  restoreButtonDisabled: {
    backgroundColor: COLORS.textMuted,
    opacity: 0.5,
  },
  restoreButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold' as const,
  },
  dangerZone: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  dangerButton: {
    backgroundColor: COLORS.danger,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  dangerButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold' as const,
  },
  dangerWarningText: {
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.danger,
    marginBottom: 10,
  },
  privacyNoteBox: {
    backgroundColor: '#F7F7F9',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  privacyNoteText: {
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textMuted,
  },
});
