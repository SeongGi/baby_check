import AsyncStorage from '@react-native-async-storage/async-storage';
import { BabyLogEntry, BabyProfile } from '../types';

const LOGS_STORAGE_KEY = '@baby_logs';
const PROFILE_STORAGE_KEY = '@baby_profile';
const BACKUP_STORAGE_KEY = '@baby_local_backup';
const MIGRATION_BACKUP_STORAGE_KEY = '@baby_migration_backup_v2';
const SCHEMA_VERSION_STORAGE_KEY = '@baby_schema_version';
const SYNC_LEDGER_STORAGE_KEY = '@baby_sync_ledger_v1';
const CURRENT_SCHEMA_VERSION = 2;

// AsyncStorage의 읽기→수정→쓰기는 원자적이지 않습니다. 서버 동기화와 사용자의
// 기록 추가가 겹쳐도 늦게 끝난 쓰기가 최신 기록을 지우지 않도록 모든 저장을 직렬화합니다.
let storageWriteQueue: Promise<void> = Promise.resolve();
const runStorageWrite = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = storageWriteQueue.catch(() => undefined).then(operation);
  storageWriteQueue = next.then(() => undefined, () => undefined);
  return next;
};

/** 가족 전체가 함께 쓰는 항목입니다. 이 값이 바뀔 때만 공유 시각을 올립니다. */
export const SHARED_PROFILE_FIELDS = ['name', 'birthDate', 'birthWeight', 'targetFormula'] as const;

const DEFAULT_PROFILE: BabyProfile = {
  name: '희성이',
  birthDate: new Date().toISOString().split('T')[0], // Default to today
  birthWeight: '3.2',
  targetFormula: 800, // 800ml is a standard daily intake target for infants
  // 아직 아무것도 입력하지 않은 기본값이므로 가장 오래된 값으로 둡니다. 이렇게 해야
  // 새로 설치한 기기가 가족의 진짜 프로필을 덮어쓰지 않고 받아옵니다.
  updatedAt: 0,
  sharedUpdatedAt: 0,
  feedingReminderEnabled: false,
  feedingIntervalMinutes: 180,
};

const normalizeProfile = (profile: BabyProfile): BabyProfile => ({
  ...DEFAULT_PROFILE,
  ...profile,
  // 이전 버전에서 올라온 프로필에는 공유 시각이 없습니다. 그 기기는 이미 진짜
  // 프로필을 갖고 있으므로 기존 updatedAt 을 그대로 물려받게 합니다.
  sharedUpdatedAt:
    typeof profile.sharedUpdatedAt === 'number'
      ? profile.sharedUpdatedAt
      : typeof profile.updatedAt === 'number'
        ? profile.updatedAt
        : 0,
  // 예전 데이터나 클라우드에서 문자열로 들어오는 경우가 있어 형을 맞춰 둡니다.
  // 목표 수유량이 문자열이면 통계·대시보드의 계산이 어긋납니다.
  name: String(profile.name ?? DEFAULT_PROFILE.name),
  birthDate: String(profile.birthDate ?? DEFAULT_PROFILE.birthDate),
  birthWeight: String(profile.birthWeight ?? DEFAULT_PROFILE.birthWeight),
  targetFormula:
    Number.isFinite(Number(profile.targetFormula)) && Number(profile.targetFormula) > 0
      ? Number(profile.targetFormula)
      : DEFAULT_PROFILE.targetFormula,
  deletedLogIds: Array.isArray(profile.deletedLogIds) ? profile.deletedLogIds : [],
  feedingReminderEnabled: profile.feedingReminderEnabled === true,
  feedingIntervalMinutes:
    typeof profile.feedingIntervalMinutes === 'number' &&
    profile.feedingIntervalMinutes >= 30 &&
    profile.feedingIntervalMinutes <= 720
      ? Math.round(profile.feedingIntervalMinutes)
      : 180,
});

/**
 * Runs before normal reads. It first stores the exact legacy values and only
 * then adds new defaults, so an app upgrade never replaces existing logs.
 */
export const migrateStoredData = async (): Promise<void> => {
  const [versionRaw, logsRaw, profileRaw] = await Promise.all([
    AsyncStorage.getItem(SCHEMA_VERSION_STORAGE_KEY),
    AsyncStorage.getItem(LOGS_STORAGE_KEY),
    AsyncStorage.getItem(PROFILE_STORAGE_KEY),
  ]);
  const version = Number(versionRaw || 0);
  if (version >= CURRENT_SCHEMA_VERSION) return;

  await AsyncStorage.setItem(
    MIGRATION_BACKUP_STORAGE_KEY,
    JSON.stringify({ timestamp: Date.now(), schemaVersion: version, logsRaw, profileRaw }),
  );

  let profile: BabyProfile | null = null;
  if (profileRaw) {
    try {
      const parsed = JSON.parse(profileRaw);
      if (parsed && typeof parsed === 'object') profile = normalizeProfile(parsed as BabyProfile);
    } catch (error) {
      console.error('Legacy profile could not be parsed; raw migration backup retained', error);
    }
  }

  const writes: [string, string][] = [[SCHEMA_VERSION_STORAGE_KEY, String(CURRENT_SCHEMA_VERSION)]];
  if (profile) writes.push([PROFILE_STORAGE_KEY, JSON.stringify(profile)]);
  await AsyncStorage.multiSet(writes);
};

const readLogsUnsafe = async (): Promise<BabyLogEntry[]> => {
  const rawData = await AsyncStorage.getItem(LOGS_STORAGE_KEY);
  if (!rawData) return [];
  const parsedLogs: unknown = JSON.parse(rawData);
  if (!Array.isArray(parsedLogs)) throw new Error('저장된 기록 형식이 올바르지 않습니다.');
  const valid = parsedLogs.every(log =>
    log && typeof log === 'object'
    && typeof (log as BabyLogEntry).id === 'string'
    && typeof (log as BabyLogEntry).type === 'string'
    && typeof (log as BabyLogEntry).timestamp === 'number');
  if (!valid) throw new Error('저장된 기록 일부가 손상되었습니다.');
  return (parsedLogs as BabyLogEntry[]).sort((a, b) => b.timestamp - a.timestamp);
};

export const getLogs = async (): Promise<BabyLogEntry[]> => {
  await storageWriteQueue.catch(() => undefined);
  try {
    return await readLogsUnsafe();
  } catch (error) {
    console.error('Error fetching logs from AsyncStorage', error);
    return [];
  }
};

export const saveLogs = async (logs: BabyLogEntry[]): Promise<boolean> => {
  return runStorageWrite(async () => {
    try {
      await AsyncStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(logs));
      return true;
    } catch (error) {
      console.error('Error saving logs to AsyncStorage', error);
      return false;
    }
  });
};

export const addLog = async (log: Omit<BabyLogEntry, 'id'>): Promise<BabyLogEntry | null> => {
  return runStorageWrite(async () => {
    try {
      const logs = await readLogsUnsafe();
      const newLog = {
        ...log,
        id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
        updatedAt: Date.now(),
      } as BabyLogEntry;
      logs.push(newLog);
      await AsyncStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(logs));
      return newLog;
    } catch (error) {
      console.error('Error adding log to AsyncStorage', error);
      return null;
    }
  });
};

export const deleteLog = async (id: string): Promise<boolean> => {
  return runStorageWrite(async () => {
    try {
      const logs = await readLogsUnsafe();
      const profile = await readProfileUnsafe();
      const deletedIds = new Set(profile.deletedLogIds || []);
      deletedIds.add(id);
      const updatedProfile = normalizeProfile({
        ...profile,
        deletedLogIds: Array.from(deletedIds),
        updatedAt: Date.now(),
      });
      await AsyncStorage.multiSet([
        [LOGS_STORAGE_KEY, JSON.stringify(logs.filter(log => log.id !== id))],
        [PROFILE_STORAGE_KEY, JSON.stringify(updatedProfile)],
      ]);
      return true;
    } catch (error) {
      console.error('Error deleting log from AsyncStorage', error);
      return false;
    }
  });
};

export const updateLog = async (updatedLog: BabyLogEntry): Promise<boolean> => {
  return runStorageWrite(async () => {
    try {
      const logs = await readLogsUnsafe();
      const index = logs.findIndex(log => log.id === updatedLog.id);
      if (index === -1) return false;
      logs[index] = { ...updatedLog, updatedAt: Date.now() };
      await AsyncStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(logs));
      return true;
    } catch (error) {
      console.error('Error updating log in AsyncStorage', error);
      return false;
    }
  });
};

const readProfileUnsafe = async (): Promise<BabyProfile> => {
  const rawData = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
  if (!rawData) return { ...DEFAULT_PROFILE };
  const parsed: unknown = JSON.parse(rawData);
  if (!parsed || typeof parsed !== 'object') throw new Error('저장된 프로필 형식이 올바르지 않습니다.');
  return normalizeProfile(parsed as BabyProfile);
};

export const getProfile = async (): Promise<BabyProfile> => {
  await storageWriteQueue.catch(() => undefined);
  try {
    return await readProfileUnsafe();
  } catch (error) {
    console.error('Error fetching profile from AsyncStorage', error);
    return { ...DEFAULT_PROFILE };
  }
};

const saveProfileUnsafe = async (incomingProfile: BabyProfile): Promise<boolean> => {
  try {
    const profile = { ...incomingProfile };
    let existing: Partial<BabyProfile> = {};
    const rawExisting = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    if (rawExisting) {
      const parsed: unknown = JSON.parse(rawExisting);
      if (!parsed || typeof parsed !== 'object') throw new Error('저장된 프로필 형식이 올바르지 않습니다.');
      existing = parsed as Partial<BabyProfile>;
    }
    // 알림 토글이나 기록 삭제 같은 내 기기 전용 변경으로 공유 시각까지 올리면,
    // 아무것도 안 바꾼 기기가 상대방의 최신 프로필을 되돌려 버립니다.
    // 저장된 프로필이 없는 새 기기는 기본값과 비교합니다. 기본값 그대로 저장하는
    // 것(가족 연결 시 syncKey 만 붙이는 경우)은 사용자가 입력한 변경이 아닙니다.
    const previousShared = { ...DEFAULT_PROFILE, ...existing } as BabyProfile;
    // "3.20" 과 "3.2", 문자열 "800" 과 숫자 800 처럼 표기만 다른 값을 변경으로
    // 보면, 아무것도 안 고친 기기가 상대방의 최신 프로필을 되돌립니다.
    const comparable = (field: (typeof SHARED_PROFILE_FIELDS)[number], value: unknown) =>
      field === 'targetFormula' ? Number(value)
        : field === 'birthWeight' ? String(Number(value))
          : String(value ?? '').trim();
    // 프로필을 읽지 못해 기본값이 들어온 경우입니다. 저장된 진짜 값이 있는데
    // 기본값으로 덮어쓰면 두 기기의 아기 정보가 통째로 날아갑니다.
    const incomingIsUntouchedDefault = SHARED_PROFILE_FIELDS.every(
      field => comparable(field, profile[field]) === comparable(field, DEFAULT_PROFILE[field]),
    );
    const storedHasRealValues = SHARED_PROFILE_FIELDS.some(
      field => existing[field] !== undefined
        && comparable(field, existing[field]) !== comparable(field, DEFAULT_PROFILE[field]),
    );
    if (incomingIsUntouchedDefault && storedHasRealValues) {
      console.warn('[storage] 기본값 프로필로 기존 아기 정보를 덮어쓰려 해 공유 항목을 지켰습니다.');
      SHARED_PROFILE_FIELDS.forEach(field => {
        if (existing[field] !== undefined) (profile as any)[field] = existing[field];
      });
    }

    // 보호를 적용한 뒤에 실제 변경 여부를 판단해야 합니다.
    const sharedChanged = SHARED_PROFILE_FIELDS.some(
      field => comparable(field, previousShared[field]) !== comparable(field, profile[field]),
    );

    const previousSharedUpdatedAt =
      typeof existing.sharedUpdatedAt === 'number'
        ? existing.sharedUpdatedAt
        : typeof existing.updatedAt === 'number'
          ? existing.updatedAt
          : 0;
    const profileWithUpdate = {
      ...existing,
      ...profile,
      updatedAt: Date.now(),
      sharedUpdatedAt: sharedChanged ? Date.now() : previousSharedUpdatedAt,
    };
    await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalizeProfile(profileWithUpdate as BabyProfile)));
    return true;
  } catch (error) {
    console.error('Error saving profile to AsyncStorage', error);
    return false;
  }
};

export const saveProfile = async (profile: BabyProfile): Promise<boolean> =>
  runStorageWrite(() => saveProfileUnsafe(profile));

/** 원격에서 받은 원래 updatedAt을 유지하면서 로컬 프로필만 갱신합니다. */
export const saveProfileFromSync = async (profile: BabyProfile): Promise<boolean> => {
  return runStorageWrite(async () => {
    try {
      await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalizeProfile(profile)));
      return true;
    } catch (error) {
      console.error('Error saving synced profile to AsyncStorage', error);
      return false;
    }
  });
};

const stableValue = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
          const field = (item as Record<string, unknown>)[key];
          if (field !== undefined) result[key] = field;
          return result;
        }, {})
      : item,
  );

/**
 * 서버 응답을 기다리는 동안 추가·수정·삭제된 로컬 기록을 다시 병합한 뒤 한 번에
 * 저장합니다. 이 함수와 모든 로컬 쓰기는 같은 큐를 사용하므로 최신 기록을 덮지 않습니다.
 */
export const saveSyncedDataWithoutLoss = async (
  syncedLogs: BabyLogEntry[],
  syncedProfile: BabyProfile,
  expectedStoredSyncKey?: string | null,
  abortToken?: { aborted: boolean },
): Promise<{ logs: BabyLogEntry[]; profile: BabyProfile; success: boolean }> =>
  runStorageWrite(async () => {
    try {
      const currentLogs = await readLogsUnsafe();
      const currentProfile = await readProfileUnsafe();
      if (abortToken?.aborted) {
        return { logs: currentLogs, profile: currentProfile, success: false };
      }
      if (expectedStoredSyncKey !== undefined
        && (currentProfile.syncKey || null) !== expectedStoredSyncKey) {
        console.warn('[storage] 가족 연결이 바뀌어 오래된 동기화 결과를 폐기했습니다.');
        return { logs: currentLogs, profile: currentProfile, success: false };
      }
      const deletedIds = new Set([
        ...(currentProfile.deletedLogIds || []),
        ...(syncedProfile.deletedLogIds || []),
      ]);
      const byId = new Map<string, BabyLogEntry>();
      [...syncedLogs, ...currentLogs].forEach(log => {
        if (!log || deletedIds.has(log.id)) return;
        const existing = byId.get(log.id);
        const candidateStamp = log.updatedAt || log.timestamp || 0;
        const existingStamp = existing?.updatedAt || existing?.timestamp || 0;
        if (!existing || candidateStamp > existingStamp
          || (candidateStamp === existingStamp && stableValue(log) > stableValue(existing))) {
          byId.set(log.id, log);
        }
      });
      const logs = Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);

      // 알림·수유 간격 같은 기기 전용 값은 현재 기기 값이 이기고, 가족 공유 항목은
      // sharedUpdatedAt과 내용 타이브레이커로 최신 값을 확정합니다.
      const currentStamp = currentProfile.sharedUpdatedAt ?? currentProfile.updatedAt ?? 0;
      const syncedStamp = syncedProfile.sharedUpdatedAt ?? syncedProfile.updatedAt ?? 0;
      const currentShared = SHARED_PROFILE_FIELDS.reduce<Record<string, unknown>>((result, field) => {
        result[field] = currentProfile[field];
        return result;
      }, {});
      const syncedShared = SHARED_PROFILE_FIELDS.reduce<Record<string, unknown>>((result, field) => {
        result[field] = syncedProfile[field];
        return result;
      }, {});
      const syncedSharedWins = syncedStamp > currentStamp
        || (syncedStamp === currentStamp && stableValue(syncedShared) > stableValue(currentShared));
      const profile = normalizeProfile({
        ...syncedProfile,
        ...currentProfile,
        ...(syncedSharedWins ? syncedShared : currentShared),
        syncKey: currentProfile.syncKey || syncedProfile.syncKey,
        deletedLogIds: Array.from(deletedIds),
        sharedUpdatedAt: syncedSharedWins ? syncedStamp : currentStamp,
      } as BabyProfile);
      await AsyncStorage.multiSet([
        [LOGS_STORAGE_KEY, JSON.stringify(logs)],
        [PROFILE_STORAGE_KEY, JSON.stringify(profile)],
      ]);
      return { logs, profile, success: true };
    } catch (error) {
      console.error('Error saving merged sync data', error);
      return { logs: syncedLogs, profile: syncedProfile, success: false };
    }
  });

// ────────────── 증분 동기화 장부 ──────────────

/**
 * 매번 기록 전체를 서버에서 다시 읽으면 무료 등급의 하루 읽기 한도(5만)가
 * 금방 소진되고, 한도가 끝나면 동기화가 통째로 멈춥니다. 마지막으로 반영한
 * 서버 변경 지점과 "이미 올린 것으로 확인된" 기록을 기기에 적어 두고, 다음
 * 동기화에서는 그 이후에 바뀐 문서만 받아옵니다.
 *
 * 이 장부는 어디까지나 비용을 줄이기 위한 힌트입니다. 값이 없거나 깨졌거나
 * 가족이 바뀌면 그냥 전체 읽기로 되돌아가므로, 장부가 틀려서 기록이 사라지는
 * 경우는 없습니다.
 */
export interface FamilySyncLedger {
  familyKey: string;
  /** 서버 시각 기준으로 마지막까지 반영한 지점 (밀리초). */
  cursorMillis: number;
  /** 마지막으로 기록 전체를 읽은 기기 시각. 주기적 전체 대조에 씁니다. */
  lastFullReadAt: number;
  /** 기록 id → 서버에 올린 것이 확인된 로컬 updatedAt. */
  uploaded: Record<string, number>;
  /** 서버에 삭제 표시가 올라간 것이 확인된 기록 id. */
  tombstoned: string[];
}

const isLedgerShape = (value: unknown): value is FamilySyncLedger =>
  !!value && typeof value === 'object'
  && typeof (value as FamilySyncLedger).familyKey === 'string'
  && typeof (value as FamilySyncLedger).cursorMillis === 'number'
  && typeof (value as FamilySyncLedger).lastFullReadAt === 'number'
  && !!(value as FamilySyncLedger).uploaded
  && typeof (value as FamilySyncLedger).uploaded === 'object'
  && Array.isArray((value as FamilySyncLedger).tombstoned);

/** 요청한 가족의 장부만 돌려줍니다. 다른 가족 것이면 없는 것으로 취급합니다. */
export const readSyncLedger = async (familyKey: string): Promise<FamilySyncLedger | null> => {
  try {
    await storageWriteQueue.catch(() => undefined);
    const rawData = await AsyncStorage.getItem(SYNC_LEDGER_STORAGE_KEY);
    if (!rawData) return null;
    const parsed: unknown = JSON.parse(rawData);
    if (!isLedgerShape(parsed) || parsed.familyKey !== familyKey) return null;
    return parsed;
  } catch (error) {
    console.warn('[storage] 증분 동기화 장부를 읽지 못해 전체 읽기로 되돌립니다.', error);
    return null;
  }
};

/**
 * 장부를 저장하면서, 기기에 더 이상 없는 기록의 항목은 버립니다. 그대로 두면
 * 삭제한 기록까지 장부에 영원히 쌓입니다.
 */
export const writeSyncLedger = async (
  ledger: FamilySyncLedger,
  liveLogIds: Iterable<string>,
): Promise<boolean> =>
  runStorageWrite(async () => {
    try {
      const live = new Set(liveLogIds);
      const uploaded: Record<string, number> = {};
      Object.entries(ledger.uploaded).forEach(([id, stamp]) => {
        if (live.has(id) && typeof stamp === 'number') uploaded[id] = stamp;
      });
      await AsyncStorage.setItem(
        SYNC_LEDGER_STORAGE_KEY,
        JSON.stringify({ ...ledger, uploaded }),
      );
      return true;
    } catch (error) {
      console.warn('[storage] 증분 동기화 장부를 저장하지 못했습니다. 다음 동기화는 전체를 읽습니다.', error);
      return false;
    }
  });

// ────────────── 로컬 백업 / 복원 API ──────────────

export interface LocalBackup {
  timestamp: number;
  logs: BabyLogEntry[];
  profile: BabyProfile;
}

export const importDataWithoutLoss = async (
  importedLogs: BabyLogEntry[],
  importedProfile: BabyProfile,
): Promise<{ logs: BabyLogEntry[]; profile: BabyProfile }> => runStorageWrite(async () => {
  const currentLogs = await readLogsUnsafe();
  const currentProfile = await readProfileUnsafe();
  await AsyncStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify({
    timestamp: Date.now(),
    logs: currentLogs,
    profile: currentProfile,
  }));
  const logsById = new Map<string, BabyLogEntry>();
  [...currentLogs, ...importedLogs].forEach(log => {
    if (!log || typeof log.id !== 'string' || typeof log.timestamp !== 'number') return;
    const existing = logsById.get(log.id);
    const existingUpdated = existing?.updatedAt || existing?.timestamp || 0;
    const candidateUpdated = log.updatedAt || log.timestamp;
    if (!existing || candidateUpdated >= existingUpdated) logsById.set(log.id, log);
  });
  const deletedIds = new Set([
    ...(currentProfile.deletedLogIds || []),
    ...(importedProfile.deletedLogIds || []),
  ]);
  const logs = Array.from(logsById.values())
    .filter(log => !deletedIds.has(log.id))
    .sort((a, b) => b.timestamp - a.timestamp);
  const profile = normalizeProfile({
    ...currentProfile,
    ...importedProfile,
    syncKey: currentProfile.syncKey,
    deletedLogIds: Array.from(deletedIds),
  });
  // 복원한 프로필이 클라우드의 값보다 오래돼 보이면, 방금 되돌린 아기 정보가
  // 곧바로 다시 덮여 버립니다. 복원은 사용자의 명시적 변경으로 취급합니다.
  const restoredShared = ['name', 'birthDate', 'birthWeight', 'targetFormula'].some(
    field => (currentProfile as any)[field] !== (profile as any)[field],
  );
  const restored = {
    ...profile,
    updatedAt: Date.now(),
    sharedUpdatedAt: restoredShared ? Date.now() : profile.sharedUpdatedAt,
  };
  await AsyncStorage.multiSet([
    [LOGS_STORAGE_KEY, JSON.stringify(logs)],
    [PROFILE_STORAGE_KEY, JSON.stringify(restored)],
  ]);
  // 가져온 기록은 서버에 없을 수 있으므로 다음 동기화는 전체를 대조합니다.
  await AsyncStorage.removeItem(SYNC_LEDGER_STORAGE_KEY);
  return { logs, profile: restored };
});

/** 동기화 전에 호출하여 현재 로컬 데이터를 백업합니다. */
export const backupLocalData = async (): Promise<boolean> => {
  return runStorageWrite(async () => {
    try {
      const logs = await readLogsUnsafe();
      const profile = await readProfileUnsafe();
      const backup: LocalBackup = { timestamp: Date.now(), logs, profile };
      await AsyncStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(backup));
      return true;
    } catch (error) {
      console.error('Error backing up local data', error);
      return false;
    }
  });
};

/** 최근 로컬 백업 정보를 가져옵니다 (타임스탬프 확인용). */
export const getLocalBackup = async (): Promise<LocalBackup | null> => {
  try {
    await storageWriteQueue.catch(() => undefined);
    const rawData = await AsyncStorage.getItem(BACKUP_STORAGE_KEY);
    if (!rawData) return null;
    return JSON.parse(rawData) as LocalBackup;
  } catch (error) {
    console.error('Error reading local backup', error);
    return null;
  }
};

/** 최근 로컬 백업으로 데이터를 복원합니다. */
export const restoreFromLocalBackup = async (): Promise<{ success: boolean; backup: LocalBackup | null }> => {
  return runStorageWrite(async () => {
    try {
      const rawData = await AsyncStorage.getItem(BACKUP_STORAGE_KEY);
      if (!rawData) return { success: false, backup: null };
      const backup = JSON.parse(rawData) as LocalBackup;
      if (!Array.isArray(backup.logs) || !backup.profile) {
        throw new Error('로컬 백업 형식이 올바르지 않습니다.');
      }
      const currentProfile = await readProfileUnsafe();
      const restoredAt = Date.now();
      const restoredLogs = backup.logs.map(log => ({ ...log, updatedAt: restoredAt }));
      const restoredProfile = normalizeProfile({
        ...backup.profile,
        syncKey: currentProfile.syncKey,
        updatedAt: restoredAt,
        sharedUpdatedAt: restoredAt,
      });
      await AsyncStorage.multiSet([
        [LOGS_STORAGE_KEY, JSON.stringify(restoredLogs)],
        [PROFILE_STORAGE_KEY, JSON.stringify(restoredProfile)],
      ]);
      // 되돌린 기록은 서버 상태와 다시 맞춰 봐야 합니다. 증분 장부를 지워
      // 다음 동기화가 기록 전체를 대조하게 합니다.
      await AsyncStorage.removeItem(SYNC_LEDGER_STORAGE_KEY);
      return {
        success: true,
        backup: { ...backup, logs: restoredLogs, profile: restoredProfile },
      };
    } catch (error) {
      console.error('Error restoring from local backup', error);
      return { success: false, backup: null };
    }
  });
};
