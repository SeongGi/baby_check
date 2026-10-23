import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BabyLogEntry, BabyProfile } from '../types';
import {
  backupLocalData,
  FamilySyncLedger,
  readSyncLedger,
  saveSyncedDataWithoutLoss,
  writeSyncLedger,
} from './storage';
import * as cloudClient from './cloudClient';

const SYNC_INVITE_PREFIX = 'babycheck://family/';
const SHARED_PROFILE_KEYS = ['name', 'birthDate', 'birthWeight', 'targetFormula'] as const;
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLIENT_ID_STORAGE_KEY = '@baby_check_client_id';

let cachedClientId: string | null = null;

export const getSyncClientId = async (): Promise<string> => {
  if (cachedClientId) return cachedClientId;
  try {
    const stored = await AsyncStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (stored) {
      cachedClientId = stored;
      return stored;
    }
  } catch {}
  const created = Crypto.randomUUID().replace(/-/g, '');
  try {
    await AsyncStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
  } catch {}
  cachedClientId = created;
  return created;
};

export const refreshCloudConnection = async (): Promise<void> => {
  // REST 기반 통신에서는 상시 소켓이 없으므로 특별한 재연결 처리가 불필요합니다.
};

export const createFamilySyncId = (): string => Crypto.randomUUID().replace(/-/g, '');

export const createFamilyInviteLink = (syncId: string): string =>
  `${SYNC_INVITE_PREFIX}${syncId.trim()}`;

export const parseFamilySyncId = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const fromLink = trimmed.match(/^babycheck:\/\/family\/([a-zA-Z0-9_-]+)$/i)?.[1];
  const key = fromLink || trimmed;
  return /^[a-zA-Z0-9_-]+$/.test(key) ? key : null;
};

export interface SyncAbortToken {
  aborted: boolean;
}

const sharedStamp = (profile: Partial<BabyProfile> | null | undefined): number =>
  (typeof profile?.sharedUpdatedAt === 'number' ? profile.sharedUpdatedAt : undefined)
  ?? (typeof profile?.updatedAt === 'number' ? profile.updatedAt : 0);

const sharedFieldsOf = (profile: Partial<BabyProfile>) => ({
  name: profile.name,
  birthDate: profile.birthDate,
  birthWeight: profile.birthWeight,
  targetFormula: profile.targetFormula,
});

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((sorted, key) => {
            const field = (item as Record<string, unknown>)[key];
            if (field !== undefined) sorted[key] = field;
            return sorted;
          }, {})
      : item,
  );

const mergeLogs = (localLogs: BabyLogEntry[], remoteLogs: BabyLogEntry[], deletedIds: Set<string>) => {
  const byId = new Map<string, BabyLogEntry>();
  [...localLogs, ...remoteLogs].forEach(log => {
    if (!log || deletedIds.has(log.id)) return;
    const current = byId.get(log.id);
    const candidateUpdated = log.updatedAt || log.timestamp;
    const currentUpdated = current?.updatedAt || current?.timestamp || 0;
    const candidateTieBreaker = canonical(log);
    const currentTieBreaker = current ? canonical(current) : '';
    if (!current || candidateUpdated > currentUpdated ||
      (candidateUpdated === currentUpdated && candidateTieBreaker > currentTieBreaker)) {
      byId.set(log.id, log);
    }
  });
  return Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
};

const describeSyncError = (error: unknown): string => {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
  if (typeof error === 'string') return error;
  const msg = (error as Error).message || '';
  if (msg.includes('family_not_found') || (error as any).status === 404) {
    return '가족 연결 키가 서버의 초대 정보와 일치하지 않거나, 가족 데이터가 삭제되었습니다. 초대 링크를 다시 받아 주세요.';
  }
  if (msg.includes('Network request failed') || (error as any).isTimeout || msg.includes('Failed to fetch')) {
    return '서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.';
  }
  return msg;
};

export const readFamilyChangeToken = async (syncKey: string): Promise<string | null> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) return null;
  const clientId = await getSyncClientId();
  try {
    const res = await cloudClient.getSyncToken(normalizedKey, clientId);
    if (!res.ok || !res.changeToken) return null;
    // 본인이 마지막으로 쓴 변경은 null로 취급하여 불필요한 자기 풀(Self-echo pull) 차단
    const parts = res.changeToken.split(':');
    if (parts[1] && parts[1] === clientId) {
      return null;
    }
    return res.changeToken;
  } catch {
    return null;
  }
};

const readyFamilyKeys = new Set<string>();

export const syncWithCloud = async (
  syncKey: string,
  localLogs: BabyLogEntry[],
  localProfile: BabyProfile,
  createBackup = true,
  abortToken?: SyncAbortToken,
  allowFamilyCreation = true,
  forceFullRead = false,
): Promise<{
  logs: BabyLogEntry[];
  profile: BabyProfile;
  success: boolean;
  merged: boolean;
  error?: string;
  familyUnavailable?: boolean;
}> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return {
      logs: localLogs,
      profile: localProfile,
      success: false,
      merged: false,
      error: '가족 연결 키가 올바르지 않습니다.',
    };
  }

  try {
    if (createBackup) await backupLocalData();
    const clientId = await getSyncClientId();

    // 1. 가족 연결 상태 확인 및 등록 (새 가족 생성이거나 미등록 시에만 호출)
    if (allowFamilyCreation || !readyFamilyKeys.has(normalizedKey)) {
      try {
        await cloudClient.connectFamily(normalizedKey, clientId, allowFamilyCreation);
        readyFamilyKeys.add(normalizedKey);
      } catch (connErr: any) {
        readyFamilyKeys.delete(normalizedKey);
        if (connErr?.status === 404 || connErr?.message?.includes('family_not_found')) {
          return {
            logs: localLogs,
            profile: localProfile,
            success: false,
            merged: false,
            familyUnavailable: true,
            error: '가족 연결 키가 서버의 초대 정보와 일치하지 않거나, 가족 데이터가 삭제되었습니다.',
          };
        }
        throw connErr;
      }
    }

    if (abortToken?.aborted) {
      return { logs: localLogs, profile: localProfile, success: false, merged: false, error: '동기화가 시간 초과로 중단되었습니다.' };
    }

    // 2. 증분 장부 대조
    const ledger = await readSyncLedger(normalizedKey);
    const canUseDelta = !forceFullRead
      && !!ledger
      && ledger.cursorMillis > 0
      && Date.now() - ledger.lastFullReadAt < FULL_RECONCILE_INTERVAL_MS;

    const lastSyncedAt = canUseDelta && ledger ? ledger.cursorMillis : 0;
    const uploadedLedger = canUseDelta && ledger ? ledger.uploaded : {};
    const tombstonedLedger = new Set(canUseDelta && ledger ? ledger.tombstoned : []);

    // 3. 업로드할 로그 및 삭제 표식 준비
    const pushLogs: BabyLogEntry[] = [];
    localLogs.forEach(log => {
      const localUpdated = log.updatedAt || log.timestamp;
      if (!canUseDelta || uploadedLedger[log.id] !== localUpdated) {
        pushLogs.push(log);
      }
    });

    const pushDeletedIds: string[] = [];
    (localProfile.deletedLogIds || []).forEach(id => {
      if (!canUseDelta || !tombstonedLedger.has(id)) {
        pushDeletedIds.push(id);
      }
    });

    const pushProfile = {
      name: localProfile.name,
      birthDate: localProfile.birthDate,
      birthWeight: localProfile.birthWeight,
      targetFormula: localProfile.targetFormula,
      sharedUpdatedAt: sharedStamp(localProfile),
    };

    if (abortToken?.aborted) {
      return { logs: localLogs, profile: localProfile, success: false, merged: false, error: '동기화가 시간 초과로 중단되었습니다.' };
    }

    // 4. Cloudflare Worker로 원자적 동기화 요청 (Push & Pull 동시 수행)
    const syncRes = await cloudClient.postSync(normalizedKey, clientId, {
      lastSyncedAt,
      pushLogs,
      pushProfile,
      pushDeletedIds,
    });

    if (abortToken?.aborted) {
      return { logs: localLogs, profile: localProfile, success: false, merged: false, error: '동기화가 시간 초과로 중단되었습니다.' };
    }

    // 5. 원격 데이터와 로컬 데이터 병합
    const remoteLogs = syncRes.remoteLogs || [];
    const remoteDeletedIds = syncRes.remoteDeletedIds || [];
    const remoteProfile = syncRes.remoteProfile || null;

    const combinedDeletedIds = new Set([
      ...(localProfile.deletedLogIds || []),
      ...remoteDeletedIds,
    ]);

    let mergedLogs = mergeLogs(localLogs, remoteLogs, combinedDeletedIds);
    let mergedProfile: BabyProfile = {
      ...localProfile,
      deletedLogIds: Array.from(combinedDeletedIds),
      syncKey: normalizedKey,
    };

    if (remoteProfile) {
      const remoteSharedKey = canonical(sharedFieldsOf(remoteProfile));
      const remoteWins = sharedStamp(remoteProfile) > sharedStamp(localProfile)
        || (sharedStamp(remoteProfile) === sharedStamp(localProfile)
          && (remoteSharedKey as string) > canonical(sharedFieldsOf(localProfile)));

      if (remoteWins) {
        SHARED_PROFILE_KEYS.forEach(key => {
          const val = remoteProfile[key];
          if (val !== undefined) (mergedProfile as any)[key] = val;
        });
        mergedProfile.sharedUpdatedAt = sharedStamp(remoteProfile);
      }
    }

    // 6. 안전한 로컬 저장 (동시성 큐 보호)
    const safelySaved = await saveSyncedDataWithoutLoss(
      mergedLogs,
      mergedProfile,
      localProfile.syncKey || null,
      abortToken,
    );
    if (!safelySaved.success) {
      throw new Error('기기에 병합 결과를 저장하지 못했습니다.');
    }
    mergedLogs = safelySaved.logs;
    mergedProfile = safelySaved.profile;

    const changedLocally = canonical(mergedLogs) !== canonical(localLogs)
      || canonical(mergedProfile) !== canonical(localProfile);

    // 네트워크 대기 중 로컬에 새 삭제가 발생했다면 같은 회차에 서버로 즉시 전파
    const unpushedDeletes = (mergedProfile.deletedLogIds || []).filter(
      id => !pushDeletedIds.includes(id) && (!canUseDelta || !tombstonedLedger.has(id))
    );
    if (unpushedDeletes.length > 0 && !abortToken?.aborted) {
      await cloudClient.postSync(normalizedKey, clientId, {
        pushDeletedIds: unpushedDeletes,
      });
    }

    // 7. 증분 장부 갱신
    if (!abortToken?.aborted && syncRes.serverTime) {
      const nextUploaded: Record<string, number> = canUseDelta ? { ...uploadedLedger } : {};
      mergedLogs.forEach(log => {
        nextUploaded[log.id] = log.updatedAt || log.timestamp;
      });

      // 서버가 더 최신이라 받아들여지지 않은 기록은 장부에서 제거해 다음 회차에 전체 대조
      const supersededSet = new Set(syncRes.supersededIds || []);
      supersededSet.forEach(id => {
        delete nextUploaded[id];
      });

      const nextTombstoned = new Set(canUseDelta ? tombstonedLedger : []);
      combinedDeletedIds.forEach(id => nextTombstoned.add(id));

      const nextLedger: FamilySyncLedger = {
        familyKey: normalizedKey,
        cursorMillis: syncRes.serverTime,
        lastFullReadAt: supersededSet.size > 0
          ? 0
          : canUseDelta && ledger ? ledger.lastFullReadAt : Date.now(),
        uploaded: nextUploaded,
        tombstoned: Array.from(nextTombstoned),
      };
      await writeSyncLedger(nextLedger, mergedLogs.map(l => l.id));
    }

    return {
      logs: mergedLogs,
      profile: mergedProfile,
      success: true,
      merged: changedLocally,
    };
  } catch (error: any) {
    if (error?.status === 404 || error?.message?.includes('family_not_found')) {
      readyFamilyKeys.delete(normalizedKey);
      return {
        logs: localLogs,
        profile: localProfile,
        success: false,
        merged: false,
        familyUnavailable: true,
        error: describeSyncError(error),
      };
    }
    return {
      logs: localLogs,
      profile: localProfile,
      success: false,
      merged: false,
      error: describeSyncError(error),
    };
  }
};

export interface FamilyDeletionStatus {
  scheduled: boolean;
  readyAt?: number;
  canDeleteNow: boolean;
  error?: string;
}

export const getFamilyDeletionStatus = async (syncKey: string): Promise<FamilyDeletionStatus> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { scheduled: false, canDeleteNow: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  const clientId = await getSyncClientId();
  try {
    const res = await cloudClient.getFamilyDeletionStatus(normalizedKey, clientId);
    return {
      scheduled: res.scheduled,
      readyAt: res.readyAt,
      canDeleteNow: res.canDeleteNow,
    };
  } catch (error) {
    return { scheduled: false, canDeleteNow: false, error: describeSyncError(error) };
  }
};

export const scheduleFamilyDeletion = async (
  syncKey: string,
): Promise<{ success: boolean; readyAt?: number; error?: string }> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { success: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  const clientId = await getSyncClientId();
  try {
    const res = await cloudClient.scheduleFamilyDeletion(normalizedKey, clientId);
    return { success: true, readyAt: res.readyAt };
  } catch (error) {
    return { success: false, error: describeSyncError(error) };
  }
};

export const cancelFamilyDeletion = async (
  syncKey: string,
): Promise<{ success: boolean; error?: string }> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { success: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  const clientId = await getSyncClientId();
  try {
    await cloudClient.cancelFamilyDeletion(normalizedKey, clientId);
    return { success: true };
  } catch (error) {
    return { success: false, error: describeSyncError(error) };
  }
};

export const deleteFamilyCloudData = async (
  syncKey: string,
): Promise<{ success: boolean; error?: string; partiallyDeleted?: boolean }> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { success: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  const clientId = await getSyncClientId();
  try {
    readyFamilyKeys.delete(normalizedKey);
    await cloudClient.deleteFamilyData(normalizedKey, clientId);
    return { success: true };
  } catch (error) {
    return { success: false, error: describeSyncError(error) };
  }
};

export const subscribeToCloudChanges = async (
  syncKey: string,
  onChange: () => void,
  onError: (error: Error) => void,
): Promise<() => void> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) throw new Error('가족 연결 키가 올바르지 않습니다.');

  const clientId = await getSyncClientId();
  let lastToken: string | null = null;
  let active = true;

  const check = async () => {
    if (!active) return;
    try {
      const res = await cloudClient.getSyncToken(normalizedKey, clientId);
      if (!active) return;
      if (res.ok && res.changeToken) {
        if (lastToken === null) {
          lastToken = res.changeToken;
        } else if (res.changeToken !== lastToken) {
          lastToken = res.changeToken;
          // 본인의 변경인지 확인 (토큰 형식: ${updated_at}:${last_client_id})
          const parts = res.changeToken.split(':');
          const lastWriterClientId = parts[1];
          if (lastWriterClientId && lastWriterClientId === clientId) {
            return;
          }
          onChange();
        }
      }
    } catch (err: any) {
      if (active) onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // 초기 1회 즉시 실행
  check().catch(() => {});

  // 90초 주기 경량 폴링
  const intervalId = setInterval(() => {
    check().catch(() => {});
  }, 90_000);

  return () => {
    active = false;
    clearInterval(intervalId);
  };
};
