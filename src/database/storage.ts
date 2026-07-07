import AsyncStorage from '@react-native-async-storage/async-storage';
import { BabyLogEntry, BabyProfile } from '../types';

const LOGS_STORAGE_KEY = '@baby_logs';
const PROFILE_STORAGE_KEY = '@baby_profile';
const BACKUP_STORAGE_KEY = '@baby_local_backup';

const DEFAULT_PROFILE: BabyProfile = {
  name: '희성이',
  birthDate: new Date().toISOString().split('T')[0], // Default to today
  birthWeight: '3.2',
  targetFormula: 800, // 800ml is a standard daily intake target for infants
  updatedAt: Date.now(),
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
    const profile: BabyProfile = JSON.parse(rawData);
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
    const profileWithUpdate = {
      ...profile,
      updatedAt: Date.now(),
    };
    await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileWithUpdate));
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
