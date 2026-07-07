import { BabyLogEntry, BabyProfile } from '../types';
import { saveLogs, saveProfile, backupLocalData } from './storage';

const KEYVALUE_APP_KEY = '1w3sbtb8';
const KEYVALUE_BASE_URL = 'https://keyvalue.immanuel.co/api/KeyVal';
const EXTENDSCLASS_BASE_URL = 'https://extendsclass.com/api/json-storage/bin';

// Cache to hold resolved bin ID in memory during app session
let cachedBinId: string | null = null;

export const getOrCreateBinId = async (sanitizedKey: string, forceNew = false): Promise<string | null> => {
  if (cachedBinId && !forceNew) return cachedBinId;
  
  try {
    const lookupKey = `baby_check_map_${sanitizedKey}`;
    
    if (!forceNew) {
      // Fetch mapping from keyvalue.immanuel.co (cache-busted)
      const res = await fetch(`${KEYVALUE_BASE_URL}/GetValue/${KEYVALUE_APP_KEY}/${lookupKey}?t=${Date.now()}`);
      if (!res.ok) {
        throw new Error(`Mapping registry check failed (status ${res.status})`);
      }
      const text = await res.text();
      let binId = text.trim();
      // Remove surrounding quotes if present (Hermes safe parsing)
      if (binId.startsWith('"') && binId.endsWith('"')) {
        binId = binId.slice(1, -1);
      }
      if (binId !== "") {
        cachedBinId = binId;
        return binId;
      }
    }
    
    // Create a new bin on ExtendsClass
    const createRes = await fetch(EXTENDSCLASS_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: [], profile: {} }),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create cloud storage bin (status ${createRes.status})`);
    }
    const createData = await createRes.json();
    const newBinId = createData.id;
    if (!newBinId) {
      throw new Error('Cloud storage bin creation did not return ID');
    }
    
    // Save mapping back to keyvalue.immanuel.co
    const saveRes = await fetch(`${KEYVALUE_BASE_URL}/UpdateValue/${KEYVALUE_APP_KEY}/${lookupKey}/${newBinId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    if (!saveRes.ok) {
      throw new Error(`Failed to save mapping registry (status ${saveRes.status})`);
    }
    
    cachedBinId = newBinId;
    return newBinId;
  } catch (err) {
    console.error('Error in getOrCreateBinId', err);
    throw err; // Propagate error so that sync doesn't show false success
  }
};

// Merge logs by ID and compare updatedAt, filtering out tombstoned entries
export const mergeLogs = (
  localLogs: BabyLogEntry[],
  remoteLogs: BabyLogEntry[],
  deletedLogIds: Set<string> = new Set()
): BabyLogEntry[] => {
  const mergedMap = new Map<string, BabyLogEntry>();
  
  localLogs.forEach(log => {
    if (!deletedLogIds.has(log.id)) {
      mergedMap.set(log.id, log);
    }
  });
  
  remoteLogs.forEach(log => {
    if (deletedLogIds.has(log.id)) return; // tombstone된 로그는 무시
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

// Merge profile by comparing updatedAt and merging deletedLogIds
export const mergeProfile = (localProfile: BabyProfile, remoteProfile: BabyProfile): BabyProfile => {
  const localUpdated = localProfile.updatedAt || 0;
  const remoteUpdated = remoteProfile.updatedAt || 0;
  
  // deletedLogIds는 항상 합집합으로 붙이기
  const mergedDeletedIds = Array.from(new Set([
    ...(localProfile.deletedLogIds || []),
    ...(remoteProfile.deletedLogIds || []),
  ]));
  
  if (remoteUpdated > localUpdated) {
    // Keep local syncKey
    return {
      ...remoteProfile,
      syncKey: localProfile.syncKey,
      deletedLogIds: mergedDeletedIds,
    };
  }
  return {
    ...localProfile,
    deletedLogIds: mergedDeletedIds,
  };
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
): Promise<{ logs: BabyLogEntry[]; profile: BabyProfile; success: boolean; merged: boolean; error?: string }> => {
  if (!syncKey || !syncKey.trim()) {
    return { logs: localLogs, profile: localProfile, success: false, merged: false, error: 'Empty sync key' };
  }
  
  const sanitizedKey = syncKey.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitizedKey) {
    return { logs: localLogs, profile: localProfile, success: false, merged: false, error: 'Invalid characters in sync key' };
  }
  
  try {
    // ━━━ 동기화 전 로컬 백업 자동 수행 ━━━
    await backupLocalData();
    
    let binId = await getOrCreateBinId(sanitizedKey);
    if (!binId) {
      return { logs: localLogs, profile: localProfile, success: false, merged: false, error: 'Could not resolve or create storage mapping key' };
    }
    
    // Fetch with cache-busting query parameter and headers to prevent local CDN/device caching
    let res = await fetch(`${EXTENDSCLASS_BASE_URL}/${binId}?t=${Date.now()}`, {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    let remoteLogs = null;
    let remoteProfile = null;
    
    if (res.status === 404 || !res.ok) {
      // Bin has expired or doesn't exist anymore on ExtendsClass: Recreate it and force update mapping!
      console.log('Sync target bin expired or missing, recreating...');
      const newBinId = await getOrCreateBinId(sanitizedKey, true);
      if (!newBinId) {
        return { logs: localLogs, profile: localProfile, success: false, merged: false, error: 'Failed to recreate expired storage bin' };
      }
      binId = newBinId;
    } else {
      try {
        const remoteData = await res.json();
        // ━━━ 원격 데이터 구조 검증 ━━━
        if (remoteData && typeof remoteData === 'object') {
          if (Array.isArray(remoteData.logs)) {
            remoteLogs = remoteData.logs;
          } else {
            console.warn('Remote data has invalid logs format, ignoring remote logs');
          }
          if (remoteData.profile && typeof remoteData.profile === 'object' && remoteData.profile.name) {
            remoteProfile = remoteData.profile;
          } else {
            console.warn('Remote data has invalid profile format, ignoring remote profile');
          }
        }
      } catch (parseErr) {
        console.warn('Failed to parse remote JSON, syncing local data as fallback', parseErr);
      }
    }
    
    let mergedLogs = localLogs;
    let mergedProfile = localProfile;
    let merged = false;
    
    // 프로필을 먼저 머지하여 deletedLogIds 합집합을 확보
    if (remoteProfile && typeof remoteProfile === 'object') {
      mergedProfile = mergeProfile(localProfile, remoteProfile);
      if (JSON.stringify(mergedProfile) !== JSON.stringify(localProfile)) {
        merged = true;
        await saveProfile(mergedProfile);
      }
    }
    
    // deletedLogIds 합집합으로 tombstone 필터링 적용
    const allDeletedIds = new Set(mergedProfile.deletedLogIds || []);
    
    if (remoteLogs && Array.isArray(remoteLogs)) {
      mergedLogs = mergeLogs(localLogs, remoteLogs, allDeletedIds);
      if (JSON.stringify(mergedLogs) !== JSON.stringify(localLogs)) {
        merged = true;
        await saveLogs(mergedLogs);
      }
    } else if (allDeletedIds.size > 0) {
      // 원격 로그가 없더라도 로컬에서 tombstone된 항목을 걸러내기
      const filteredLocal = localLogs.filter(log => !allDeletedIds.has(log.id));
      if (filteredLocal.length !== localLogs.length) {
        mergedLogs = filteredLocal;
        merged = true;
        await saveLogs(mergedLogs);
      }
    }
    
    // If we merged remote changes or if we did initial connection, upload back the combined set to ensure they are identical
    if (merged || (remoteLogs && remoteProfile)) {
      const uploaded = await uploadToCloud(sanitizedKey, mergedLogs, mergedProfile);
      if (!uploaded) {
        return { logs: localLogs, profile: localProfile, success: false, merged: false, error: 'Failed to upload merged data to cloud storage' };
      }
    } else if (!remoteLogs && !remoteProfile) {
      // First time setting up this key (or recreated): upload local data as primary
      const uploaded = await uploadToCloud(sanitizedKey, localLogs, localProfile);
      if (!uploaded) {
        return { logs: localLogs, profile: localProfile, success: false, merged: false, error: 'Failed to initialize cloud storage data' };
      }
      merged = true; // flag to trigger state updates
    }
    
    return { logs: mergedLogs, profile: mergedProfile, success: true, merged };
  } catch (error) {
    console.error('Error syncing with cloud', error);
    return { logs: localLogs, profile: localProfile, success: false, merged: false, error: error instanceof Error ? error.message : String(error) };
  }
};
