import { BabyLogEntry, BabyProfile } from '../types';
import { saveLogs, saveProfile } from './storage';

const BUCKET_URL = 'https://kvdb.io/79563103-adf4-45c2-b610-ae4c461868f0';

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

// Upload logs and profile to kvdb
export const uploadToCloud = async (syncKey: string, logs: BabyLogEntry[], profile: BabyProfile): Promise<boolean> => {
  if (!syncKey || !syncKey.trim()) return false;
  
  const sanitizedKey = syncKey.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitizedKey) return false;
  
  try {
    const logsPromise = fetch(`${BUCKET_URL}/${sanitizedKey}_logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logs),
    });
    
    const profilePromise = fetch(`${BUCKET_URL}/${sanitizedKey}_profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    
    const [resLogs, resProfile] = await Promise.all([logsPromise, profilePromise]);
    return resLogs.ok && resProfile.ok;
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
    const logsPromise = fetch(`${BUCKET_URL}/${sanitizedKey}_logs`).then(r => r.ok ? r.json() : null);
    const profilePromise = fetch(`${BUCKET_URL}/${sanitizedKey}_profile`).then(r => r.ok ? r.json() : null);
    
    const [remoteLogs, remoteProfile] = await Promise.all([logsPromise, profilePromise]);
    
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
