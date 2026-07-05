import { BabyLogEntry, BabyProfile } from '../types';
import { saveLogs, saveProfile } from './storage';

const KEYVALUE_APP_KEY = '1w3sbtb8';
const KEYVALUE_BASE_URL = 'https://keyvalue.immanuel.co/api/KeyVal';
const EXTENDSCLASS_BASE_URL = 'https://extendsclass.com/api/json-storage/bin';

// Cache to hold resolved bin ID in memory during app session
let cachedBinId: string | null = null;

export const getOrCreateBinId = async (sanitizedKey: string): Promise<string | null> => {
  if (cachedBinId) return cachedBinId;
  
  try {
    const lookupKey = `baby_check_map_${sanitizedKey}`;
    // Fetch mapping from keyvalue.immanuel.co (cache-busted)
    const res = await fetch(`${KEYVALUE_BASE_URL}/GetValue/${KEYVALUE_APP_KEY}/${lookupKey}?t=${Date.now()}`);
    if (res.ok) {
      let binId = await res.json();
      if (binId) {
        binId = binId.trim();
        if (binId !== "") {
          cachedBinId = binId;
          return binId;
        }
      }
    }
    
    // If not found, create a new bin on ExtendsClass
    const createRes = await fetch(EXTENDSCLASS_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: [], profile: {} }),
    });
    if (!createRes.ok) {
      console.error('Failed to create ExtendsClass bin');
      return null;
    }
    const createData = await createRes.json();
    const newBinId = createData.id;
    if (!newBinId) return null;
    
    // Save mapping back to keyvalue.immanuel.co
    const saveRes = await fetch(`${KEYVALUE_BASE_URL}/UpdateValue/${KEYVALUE_APP_KEY}/${lookupKey}/${newBinId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    if (!saveRes.ok) {
      console.warn('Failed to save bin mapping to KeyVal');
    }
    
    cachedBinId = newBinId;
    return newBinId;
  } catch (err) {
    console.error('Error in getOrCreateBinId', err);
    return null;
  }
};

// Merge logs by ID and compare updatedAt
export const mergeLogs = (localLogs: BabyLogEntry[], remoteLogs: BabyLogEntry[]): BabyLogEntry[] => {
  const mergedMap = new Map<string, BabyLogEntry>();
  
  localLogs.forEach(log => {
    mergedMap.set(log.id, log);
  });
  
  remoteLogs.forEach(log => {
    const existing = mergedMap.get(log.id);
    if (!existing) {
      mergedMap.set(log.id, log);
    } else {
      const localUpdated = existing.updatedAt || existing.timestamp;
      const remoteUpdated = log.updatedAt || log.timestamp;
      if (remoteUpdated > localUpdated) {
        mergedMap.set(log.id, log);
      }
    }
  });
  
  return Array.from(mergedMap.values()).sort((a, b) => b.timestamp - a.timestamp);
};

// Merge profile by comparing updatedAt
export const mergeProfile = (localProfile: BabyProfile, remoteProfile: BabyProfile): BabyProfile => {
  const localUpdated = localProfile.updatedAt || 0;
  const remoteUpdated = remoteProfile.updatedAt || 0;
  
  if (remoteUpdated > localUpdated) {
    // Keep local syncKey
    return {
      ...remoteProfile,
      syncKey: localProfile.syncKey,
    };
  }
  return localProfile;
};

// Upload logs and profile to cloud sync (ExtendsClass)
export const uploadToCloud = async (syncKey: string, logs: BabyLogEntry[], profile: BabyProfile): Promise<boolean> => {
  if (!syncKey || !syncKey.trim()) return false;
  
  const sanitizedKey = syncKey.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitizedKey) return false;
  
  try {
    const binId = await getOrCreateBinId(sanitizedKey);
    if (!binId) return false;
    
    const res = await fetch(`${EXTENDSCLASS_BASE_URL}/${binId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs, profile }),
    });
    
    return res.ok;
  } catch (error) {
    console.error('Error uploading to cloud sync', error);
    return false;
  }
};

// Download from cloud sync and merge
export const syncWithCloud = async (
  syncKey: string, 
  localLogs: BabyLogEntry[], 
  localProfile: BabyProfile
): Promise<{ logs: BabyLogEntry[]; profile: BabyProfile; success: boolean; merged: boolean }> => {
  if (!syncKey || !syncKey.trim()) {
    return { logs: localLogs, profile: localProfile, success: false, merged: false };
  }
  
  const sanitizedKey = syncKey.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitizedKey) {
    return { logs: localLogs, profile: localProfile, success: false, merged: false };
  }
  
  try {
    const binId = await getOrCreateBinId(sanitizedKey);
    if (!binId) {
      return { logs: localLogs, profile: localProfile, success: false, merged: false };
    }
    
    // Fetch with cache-busting query parameter and headers to prevent local CDN/device caching
    const res = await fetch(`${EXTENDSCLASS_BASE_URL}/${binId}?t=${Date.now()}`, {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (!res.ok) {
      return { logs: localLogs, profile: localProfile, success: false, merged: false };
    }
    
    const remoteData = await res.json();
    const remoteLogs = remoteData?.logs;
    const remoteProfile = remoteData?.profile;
    
    let mergedLogs = localLogs;
    let mergedProfile = localProfile;
    let merged = false;
    
    if (remoteLogs && Array.isArray(remoteLogs)) {
      mergedLogs = mergeLogs(localLogs, remoteLogs);
      if (JSON.stringify(mergedLogs) !== JSON.stringify(localLogs)) {
        merged = true;
        await saveLogs(mergedLogs);
      }
    }
    
    if (remoteProfile && typeof remoteProfile === 'object') {
      mergedProfile = mergeProfile(localProfile, remoteProfile);
      if (JSON.stringify(mergedProfile) !== JSON.stringify(localProfile)) {
        merged = true;
        await saveProfile(mergedProfile);
      }
    }
    
    // If we merged remote changes or if we did initial connection, upload back the combined set to ensure they are identical
    if (merged || (remoteLogs && remoteProfile)) {
      await uploadToCloud(sanitizedKey, mergedLogs, mergedProfile);
    } else if (!remoteLogs && !remoteProfile) {
      // First time setting up this key: upload local data as primary
      await uploadToCloud(sanitizedKey, localLogs, localProfile);
      merged = true; // flag to trigger state updates
    }
    
    return { logs: mergedLogs, profile: mergedProfile, success: true, merged };
  } catch (error) {
    console.error('Error syncing with cloud', error);
    return { logs: localLogs, profile: localProfile, success: false, merged: false };
  }
};
