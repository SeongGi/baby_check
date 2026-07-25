import AsyncStorage from '@react-native-async-storage/async-storage';
import { BabyLogEntry, BabyProfile } from '../types';

const LOGS_STORAGE_KEY = '@baby_logs';
const PROFILE_STORAGE_KEY = '@baby_profile';
const BACKUP_STORAGE_KEY = '@baby_local_backup';
const MIGRATION_BACKUP_STORAGE_KEY = '@baby_migration_backup_v2';
const SCHEMA_VERSION_STORAGE_KEY = '@baby_schema_version';
const CURRENT_SCHEMA_VERSION = 2;

const DEFAULT_PROFILE: BabyProfile = {
  name: '희성이',
  birthDate: new Date().toISOString().split('T')[0], // Default to today
  birthWeight: '3.2',
  targetFormula: 800, // 800ml is a standard daily intake target for infants
  updatedAt: Date.now(),
  feedingReminderEnabled: false,
  feedingIntervalMinutes: 180,
};

const normalizeProfile = (profile: BabyProfile): BabyProfile => ({
  ...DEFAULT_PROFILE,
  ...profile,
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

export const getLogs = async (): Promise<BabyLogEntry[]> => {
  try {
    const rawData = await AsyncStorage.getItem(LOGS_STORAGE_KEY);
    if (!rawData) return [];
    const parsedLogs: BabyLogEntry[] = JSON.parse(rawData);
    // Sort descending by timestamp (newest first)
    return parsedLogs.sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    console.error('Error fetching logs from AsyncStorage', error);
    return [];
  }
};

export const saveLogs = async (logs: BabyLogEntry[]): Promise<boolean> => {
  try {
    await AsyncStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(logs));
    return true;
  } catch (error) {
    console.error('Error saving logs to AsyncStorage', error);
    return false;
  }
};

export const addLog = async (log: Omit<BabyLogEntry, 'id'>): Promise<BabyLogEntry | null> => {
  try {
    const logs = await getLogs();
    const newLog = {
      ...log,
      id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
      updatedAt: Date.now(),
    } as BabyLogEntry;
    
    logs.push(newLog);
    const success = await saveLogs(logs);
    return success ? newLog : null;
  } catch (error) {
    console.error('Error adding log to AsyncStorage', error);
    return null;
  }
};

export const deleteLog = async (id: string): Promise<boolean> => {
  try {
    const logs = await getLogs();
    const filteredLogs = logs.filter(log => log.id !== id);
    const saved = await saveLogs(filteredLogs);
    if (saved) {
      // Tombstone: 삭제된 ID를 프로필에 기록하여 동기화 시 재출현 방지
      const profile = await getProfile();
      const deletedIds = new Set(profile.deletedLogIds || []);
      deletedIds.add(id);
      profile.deletedLogIds = Array.from(deletedIds);
      await saveProfile(profile);
    }
    return saved;
  } catch (error) {
    console.error('Error deleting log from AsyncStorage', error);
    return false;
  }
};

export const updateLog = async (updatedLog: BabyLogEntry): Promise<boolean> => {
  try {
    const logs = await getLogs();
    const index = logs.findIndex(log => log.id === updatedLog.id);
    if (index === -1) return false;
    
    const logWithUpdateTime = {
      ...updatedLog,
      updatedAt: Date.now(),
    };
    logs[index] = logWithUpdateTime;
    return await saveLogs(logs);
  } catch (error) {
    console.error('Error updating log in AsyncStorage', error);
    return false;
  }
};

export const getProfile = async (): Promise<BabyProfile> => {
  try {
    const rawData = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    if (!rawData) return DEFAULT_PROFILE;
    const profile: BabyProfile = normalizeProfile(JSON.parse(rawData));
    // If the profile name is still default '꼬꼬마', update it to '희성이'
    if (profile.name === '꼬꼬마') {
      profile.name = '희성이';
      profile.updatedAt = Date.now();
      await saveProfile(profile);
    }
    return profile;
  } catch (error) {
    console.error('Error fetching profile from AsyncStorage', error);
    return DEFAULT_PROFILE;
  }
};

export const saveProfile = async (profile: BabyProfile): Promise<boolean> => {
  try {
    let existing: Partial<BabyProfile> = {};
    const rawExisting = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    if (rawExisting) {
      try {
        existing = JSON.parse(rawExisting);
      } catch {
        // The exact broken value is retained by migrateStoredData's raw backup.
      }
    }
    const profileWithUpdate = {
      ...existing,
      ...profile,
      updatedAt: Date.now(),
    };
    await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalizeProfile(profileWithUpdate as BabyProfile)));
    return true;
  } catch (error) {
    console.error('Error saving profile to AsyncStorage', error);
    return false;
  }
};

// ────────────── 로컬 백업 / 복원 API ──────────────

export interface LocalBackup {
  timestamp: number;
  logs: BabyLogEntry[];
  profile: BabyProfile;
}

export const importDataWithoutLoss = async (
  importedLogs: BabyLogEntry[],
  importedProfile: BabyProfile,
): Promise<{ logs: BabyLogEntry[]; profile: BabyProfile }> => {
  await backupLocalData();
  const currentLogs = await getLogs();
  const currentProfile = await getProfile();
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
    syncKey: currentProfile.syncKey || importedProfile.syncKey,
    deletedLogIds: Array.from(deletedIds),
  });
  await AsyncStorage.multiSet([
    [LOGS_STORAGE_KEY, JSON.stringify(logs)],
    [PROFILE_STORAGE_KEY, JSON.stringify({ ...profile, updatedAt: Date.now() })],
  ]);
  return { logs, profile };
};

/** 동기화 전에 호출하여 현재 로컬 데이터를 백업합니다. */
export const backupLocalData = async (): Promise<boolean> => {
  try {
    const logs = await getLogs();
    const profile = await getProfile();
    const backup: LocalBackup = {
      timestamp: Date.now(),
      logs,
      profile,
    };
    await AsyncStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(backup));
    return true;
  } catch (error) {
    console.error('Error backing up local data', error);
    return false;
  }
};

/** 최근 로컬 백업 정보를 가져옵니다 (타임스탬프 확인용). */
export const getLocalBackup = async (): Promise<LocalBackup | null> => {
  try {
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
  try {
    const backup = await getLocalBackup();
    if (!backup) {
      return { success: false, backup: null };
    }
    await saveLogs(backup.logs);
    await saveProfile(backup.profile);
    return { success: true, backup };
  } catch (error) {
    console.error('Error restoring from local backup', error);
    return { success: false, backup: null };
  }
};
