import AsyncStorage from '@react-native-async-storage/async-storage';
import { BabyLogEntry, BabyProfile } from '../types';

const LOGS_STORAGE_KEY = '@baby_logs';
const PROFILE_STORAGE_KEY = '@baby_profile';

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
    return await saveLogs(filteredLogs);
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
