import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BabyLogEntry, BabyProfile } from '../types';
import {
  applySyncResponse,
  backupLocalData,
  CloudSyncLedger,
  getLogs,
  getProfile,
  readSyncLedger,
  stableValue,
  SyncCursor,
  writeSyncLedger,
} from './storage';
import * as cloudClient from './cloudClient';
import { SyncDataPayload, SyncDataResponse } from './cloudClient';
import {
  classifyFailure,
  effectiveLimit,
  FailureKind,
  GONE_MESSAGE,
  LimitOutcome,
  MIN_LIMIT,
  nextLimits,
  nextStepAfterFailure,
  NOT_FOUND_MESSAGE,
  PULL_TOO_SLOW_MESSAGE,
  RequestStage,
  UPLOAD_STALLED_MESSAGE,
} from './syncDecision';
import { utf8ByteLength } from '../utils/utf8';
import { compareCodePoints } from '../utils/compareCodePoints';

const SYNC_INVITE_PREFIX = 'babycheck://family/';
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLIENT_ID_STORAGE_KEY = '@baby_check_client_id';
// 묶음 하나의 직렬화 크기(UTF-8 바이트) 상한입니다. 서버의 본문 한도 1MB 밑에서 여유를 둡니다.
const MAX_PUSH_BYTES = 900 * 1024;
// 한 회차에 보내는 올리기 묶음 수의 상한입니다. 남으면 다음 회차가 이어 갑니다.
const MAX_PUSH_BATCHES_PER_ROUND = 20;
const ABORTED_MESSAGE = '동기화가 시간 초과로 중단되었습니다.';
const ALREADY_DELETED_MESSAGE = '이미 삭제된 가족입니다.';

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

const describeSyncError = (error: unknown): string => {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
  if (typeof error === 'string') return error;
  const msg = (error as Error).message || '';
  const status = (error as { status?: unknown }).status;
  if (msg.includes('family_deleted') || status === 410) return GONE_MESSAGE;
  if (msg.includes('family_not_found') || status === 404) return NOT_FOUND_MESSAGE;
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

export interface SyncWithCloudResult {
  logs: BabyLogEntry[];
  profile: BabyProfile;
  success: boolean;
  merged: boolean;
  error?: string;
  /** 410(family_deleted): 가족이 영구 삭제되었습니다. */
  familyUnavailable?: boolean;
  /** 404(family_not_found): 서버에 가족이 없습니다. 연결은 끊지 않습니다. */
  familyNotFound?: boolean;
  /** 시간 예산, 묶음 수 상한, 전체 모드 미완료로 할 일이 남은 채 끝났습니다. */
  continuing?: boolean;
  /** 이 회차에서 저장이 한 번이라도 의미 있게 바뀌었습니다(크기 조절만은 제외). */
  progressed?: boolean;
  uploadStalled?: boolean;
  oversizedIds?: string[];
  pullTooSlow?: boolean;
}

const protocolError = (message: string): Error => {
  const err = new Error(message);
  (err as any).status = 502;
  return err;
};

// 서버의 (updated_at, log_id) 정렬(SQLite BINARY)과 같은 코드 포인트 순서로 비교합니다.
const isCursorAfter = (next: SyncCursor, current: SyncCursor): boolean =>
  next.updatedAt > current.updatedAt
  || (next.updatedAt === current.updatedAt && compareCodePoints(next.logId, current.logId) > 0);

const readNextAfter = (value: unknown): SyncCursor | null => {
  const v = value as { updatedAt?: unknown; logId?: unknown } | null | undefined;
  return v && typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) && typeof v.logId === 'string'
    ? { updatedAt: v.updatedAt, logId: v.logId }
    : null;
};

const stampOf = (log: BabyLogEntry): number => log.updatedAt || log.timestamp;

const sharedProfilePayload = (profile: BabyProfile) => ({
  name: profile.name,
  birthDate: profile.birthDate,
  birthWeight: profile.birthWeight,
  targetFormula: profile.targetFormula,
  sharedUpdatedAt: sharedStamp(profile),
});

export const syncWithCloud = async (
  syncKey: string,
  localLogs: BabyLogEntry[],
  localProfile: BabyProfile,
  createBackup = true,
  abortToken?: SyncAbortToken,
  allowFamilyCreation = true,
  forceFullRead = false,
  startedAt?: number,
): Promise<SyncWithCloudResult> => {
  const roundStart = startedAt ?? Date.now();
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
  const key: string = normalizedKey;
  const timing = cloudClient.getSyncTiming();
  const elapsed = () => Date.now() - roundStart;
  const isAborted = () => !!abortToken?.aborted;

  // 회차가 시작할 때 저장돼 있던 키. 가족 만들기와 합류에서는 null입니다.
  const startKey = localProfile.syncKey || null;

  let logs = localLogs;
  let profile = localProfile;
  let ledger: CloudSyncLedger = {
    familyKey: key, cursorMillis: 0, lastFullReadAt: 0, uploaded: {}, tombstoned: [],
  };
  let storedOnce = false; // 첫 저장이 성공했는가(기대 키 규칙)
  let progressed = false;
  let profileSent = false;
  let abortedRound = false;
  let continuing = false;
  let uploadStalled = false;
  let pullTooSlow = false;
  let familyUnavailable = false;
  let familyNotFound = false;
  let failure: { error: unknown; kind: FailureKind } | null = null;
  let saveFailure: string | null = null;
  let endRound = false;
  let skipPull = false;
  let skipPush = false;
  let skipIncremental = false;
  const oversized = new Set<string>();

  const compose = (): SyncWithCloudResult => {
    const hasSaved = storedOnce;
    const merged = hasSaved
      && (stableValue(logs) !== stableValue(localLogs) || stableValue(profile) !== stableValue(localProfile));
    const base = { logs, profile, merged, progressed };
    const extras: Partial<SyncWithCloudResult> = {};
    if (oversized.size > 0) extras.oversizedIds = Array.from(oversized);
    if (familyUnavailable) extras.familyUnavailable = true;
    else if (familyNotFound) extras.familyNotFound = true;
    if (pullTooSlow) extras.pullTooSlow = true;
    if (uploadStalled) extras.uploadStalled = true;
    if (failure) {
      return {
        ...base, ...extras, success: false,
        error: pullTooSlow ? PULL_TOO_SLOW_MESSAGE : describeSyncError(failure.error),
      };
    }
    if (saveFailure) return { ...base, ...extras, success: false, error: saveFailure };
    if (abortedRound || isAborted()) return { ...base, ...extras, success: false, error: ABORTED_MESSAGE };
    if (uploadStalled) return { ...base, ...extras, success: false, error: UPLOAD_STALLED_MESSAGE };
    return { ...base, ...extras, success: true, ...(continuing ? { continuing: true } : {}) };
  };

  const persistLimitsNow = async (outcome: LimitOutcome) => {
    const limits = nextLimits(ledger.limits, outcome);
    if (stableValue(limits) === stableValue(ledger.limits)) return;
    ledger = { ...ledger, limits };
    if (isAborted()) return;
    await writeSyncLedger(ledger, logs.map(log => log.id));
  };

  const onFailure = async (stage: RequestStage, error: unknown, usedLimit: number) => {
    const kind = classifyFailure(error);
    if (!failure) failure = { error, kind };
    if (kind === 'notFound') { familyNotFound = true; readyFamilyKeys.delete(key); }
    if (kind === 'gone') { familyUnavailable = true; readyFamilyKeys.delete(key); }
    if (stage === 'pull' && kind === 'timeout' && usedLimit <= MIN_LIMIT) pullTooSlow = true;
    await persistLimitsNow({ kind: stage, result: 'failure', failure: kind });
    const step = nextStepAfterFailure(stage, kind);
    if (step === 'endRound') endRound = true;
    else if (step === 'skipPull') skipPull = true;
    else if (step === 'skipPush') skipPush = true;
    else { skipPush = true; skipIncremental = true; }
  };

  // 응답 하나를 원자적으로 저장합니다. 저장하지 못하면 회차를 끝냅니다.
  const applyResponse = async (
    res: SyncDataResponse,
    stage: RequestStage,
    options: {
      sentLogs?: BabyLogEntry[];
      sentDeletedIds?: string[];
      mutate?: (ledger: CloudSyncLedger) => void;
    } = {},
  ) => {
    const outcome: LimitOutcome = {
      kind: stage,
      result: 'success',
      hints: { maxPushItems: res.maxPushItems, maxPageRows: res.maxPageRows },
    };
    const applied = await applySyncResponse({
      familyKey: key,
      allowedStoredKeys: storedOnce ? [key] : [startKey, key],
      abortToken,
      remoteLogs: Array.isArray(res.remoteLogs) ? res.remoteLogs : [],
      remoteDeletedIds: Array.isArray(res.remoteDeletedIds) ? res.remoteDeletedIds : [],
      remoteProfile: res.remoteProfile,
      sentLogs: options.sentLogs,
      sentDeletedIds: options.sentDeletedIds,
      acceptedIds: Array.isArray(res.acceptedIds) ? res.acceptedIds : [],
      ledger,
      updateLedger: next => {
        options.mutate?.(next);
        next.limits = nextLimits(next.limits, outcome);
      },
    });
    if (!applied.success) {
      endRound = true;
      if (applied.reason === 'aborted') abortedRound = true;
      else if (applied.reason === 'keyChanged') saveFailure = '가족 연결이 해제되었거나 변경되었습니다.';
      else saveFailure = '기기에 병합 결과를 저장하지 못했습니다.';
      return applied;
    }
    storedOnce = true;
    ledger = applied.ledger;
    logs = applied.logs;
    profile = applied.profile;
    if (applied.meaningful) progressed = true;
    if (res.profileRejected) console.warn('[sync] 서버가 아기 정보를 받아들이지 않았습니다.');
    return applied;
  };

  const profilePart = async (): Promise<Pick<SyncDataPayload, 'pushProfile'>> =>
    profileSent ? {} : { pushProfile: sharedProfilePayload(await getProfile()) };

  const localResult = (success: boolean): SyncWithCloudResult =>
    ({ logs: localLogs, profile: localProfile, success, merged: false });

  try {
    if (createBackup) await backupLocalData();
    const clientId = await getSyncClientId();

    // 1. 연결: 새 가족을 만들거나 아직 등록하지 않은 가족일 때만 부릅니다.
    if (allowFamilyCreation || !readyFamilyKeys.has(key)) {
      try {
        await cloudClient.connectFamily(key, clientId, allowFamilyCreation);
        readyFamilyKeys.add(key);
      } catch (connErr: any) {
        readyFamilyKeys.delete(key);
        const kind = classifyFailure(connErr);
        if (kind === 'gone') {
          return { ...localResult(false), familyUnavailable: true, error: describeSyncError(connErr) };
        }
        if (kind === 'notFound') {
          return { ...localResult(false), familyNotFound: true, error: describeSyncError(connErr) };
        }
        throw connErr;
      }
    }
    if (isAborted()) return { ...localResult(false), error: ABORTED_MESSAGE };

    // 2~3. 장부 읽기와 모드 결정
    const stored = await readSyncLedger(key);
    const fullMode = !stored
      || forceFullRead
      || Date.now() - stored.lastFullReadAt >= FULL_RECONCILE_INTERVAL_MS
      || !!stored.full;
    if (stored) ledger = stored;
    if (fullMode && !ledger.full) {
      ledger = {
        ...ledger,
        full: { after: { updatedAt: 0, logId: '' }, uploaded: {}, tombstoned: [] },
      };
      delete ledger.pullAfter;
      delete ledger.pullCursorAtStart;
    }

    // 4. 전체 모드 당겨 받기
    while (fullMode && ledger.full && !endRound && !skipPull) {
      if (isAborted()) { abortedRound = true; break; }
      if (elapsed() >= timing.pullBudgetMs || elapsed() >= timing.cycleBudgetMs) { continuing = true; break; }
      const after = ledger.full.after;
      const limit = effectiveLimit(ledger.limits, 'pull');
      let res: SyncDataResponse;
      try {
        res = await cloudClient.postSync(key, clientId, {
          ...(await profilePart()),
          pull: { afterUpdatedAt: after.updatedAt, afterLogId: after.logId, limit },
        });
        const next = res.hasMore ? readNextAfter(res.nextAfter) : null;
        if (res.hasMore && (!next || !isCursorAfter(next, after))) throw protocolError('서버 응답의 nextAfter가 올바르지 않습니다.');
      } catch (error) {
        if (isAborted()) { abortedRound = true; break; }
        await onFailure('pull', error, limit);
        break;
      }
      if (isAborted()) { abortedRound = true; break; }
      profileSent = true;
      const nextAfter = res.hasMore ? readNextAfter(res.nextAfter) : null;
      const applied = await applyResponse(res, 'pull', {
        mutate: next => {
          const full = next.full;
          if (!full) return;
          if (full.cursorAtStart === undefined) {
            full.cursorAtStart = typeof res.cursorCandidate === 'number' ? res.cursorCandidate : 0;
          }
          if (nextAfter) {
            full.after = nextAfter;
          } else {
            // 끝까지 받았습니다. 기존 장부를 이번 대조 결과로 바꿔 끼웁니다.
            next.uploaded = full.uploaded;
            next.tombstoned = full.tombstoned;
            next.cursorMillis = full.cursorAtStart;
            next.lastFullReadAt = Date.now();
            delete next.full;
            delete next.pullAfter;
            delete next.pullCursorAtStart;
          }
        },
      });
      if (!applied.success) break;
    }

    // 5. 올리기
    const excluded = new Set<string>();
    let batches = 0;
    let noProgressBatches = 0;
    while (!skipPush && !endRound && !abortedRound) {
      if (isAborted()) { abortedRound = true; break; }
      const limit = effectiveLimit(ledger.limits, 'push');
      const freshLogs = await getLogs();
      const freshProfile = await getProfile();
      const tombstoned = new Set(ledger.tombstoned);
      const pushIds: string[] = [];
      const pushLogs: BabyLogEntry[] = [];
      let bytes = 0;
      let count = 0;
      let full = false;
      for (const id of freshProfile.deletedLogIds || []) {
        if (tombstoned.has(id) || excluded.has(id)) continue;
        const size = utf8ByteLength(JSON.stringify(id)) + 1;
        if (count >= limit || bytes + size > MAX_PUSH_BYTES) { full = true; break; }
        pushIds.push(id);
        bytes += size;
        count += 1;
      }
      if (!full) {
        for (const log of freshLogs) {
          if (excluded.has(log.id) || oversized.has(log.id)) continue;
          if (ledger.uploaded[log.id] === stampOf(log)) continue;
          const size = utf8ByteLength(JSON.stringify(log));
          if (size > MAX_PUSH_BYTES) { oversized.add(log.id); continue; }
          if (count >= limit || bytes + size + 1 > MAX_PUSH_BYTES) { full = true; break; }
          pushLogs.push(log);
          bytes += size + 1;
          count += 1;
        }
      }
      if (count === 0) break;
      if (batches >= MAX_PUSH_BATCHES_PER_ROUND || elapsed() >= timing.cycleBudgetMs) {
        continuing = true;
        break;
      }
      batches += 1;
      let res: SyncDataResponse;
      try {
        res = await cloudClient.postSync(key, clientId, {
          ...(await profilePart()),
          pushLogs,
          pushDeletedIds: pushIds,
        });
      } catch (error) {
        if (isAborted()) { abortedRound = true; break; }
        await onFailure('push', error, limit);
        break;
      }
      if (isAborted()) { abortedRound = true; break; }
      profileSent = true;
      const applied = await applyResponse(res, 'push', { sentLogs: pushLogs, sentDeletedIds: pushIds });
      if (!applied.success) break;
      if (applied.ledgerItemsAdded === 0) {
        // 비교 규칙이 조금만 어긋나도 같은 묶음을 계속 보내는 일을 막습니다.
        pushLogs.forEach(log => excluded.add(log.id));
        pushIds.forEach(id => excluded.add(id));
        noProgressBatches += 1;
        if (noProgressBatches >= 2) { uploadStalled = true; break; }
      }
    }

    // 6. 증분 당겨 받기: 전체 모드인 회차는 건너뜁니다.
    // 다만 이 회차에 전체 모드를 끝내고 올리기까지 했다면 한 번 더 받습니다. 마지막 페이지를 받은 뒤
    // 상대 기기가 쓴 기록은 이 기기의 올리기가 변경 토큰을 자기 것으로 덮어 폴링으로 알 수 없기 때문입니다.
    while ((!fullMode || (!ledger.full && batches > 0)) && !skipIncremental && !endRound && !abortedRound) {
      if (isAborted()) { abortedRound = true; break; }
      if (elapsed() >= timing.cycleBudgetMs) { continuing = true; break; }
      const after: SyncCursor = ledger.pullAfter ?? { updatedAt: ledger.cursorMillis, logId: '' };
      const limit = effectiveLimit(ledger.limits, 'pull');
      let res: SyncDataResponse;
      try {
        res = await cloudClient.postSync(key, clientId, {
          ...(await profilePart()),
          pull: { afterUpdatedAt: after.updatedAt, afterLogId: after.logId, limit },
        });
        const next = res.hasMore ? readNextAfter(res.nextAfter) : null;
        if (res.hasMore && (!next || !isCursorAfter(next, after))) throw protocolError('서버 응답의 nextAfter가 올바르지 않습니다.');
      } catch (error) {
        if (isAborted()) { abortedRound = true; break; }
        await onFailure('pull', error, limit);
        break;
      }
      if (isAborted()) { abortedRound = true; break; }
      profileSent = true;
      const nextAfter = res.hasMore ? readNextAfter(res.nextAfter) : null;
      const applied = await applyResponse(res, 'pull', {
        mutate: next => {
          // 끊겼다가 이어 받는 회차의 첫 페이지가 원래 커서를 덮지 않도록 값이 없을 때만 적습니다.
          if (next.pullCursorAtStart === undefined) {
            next.pullCursorAtStart = typeof res.cursorCandidate === 'number' ? res.cursorCandidate : next.cursorMillis;
          }
          if (nextAfter) {
            next.pullAfter = nextAfter;
          } else {
            next.cursorMillis = next.pullCursorAtStart;
            delete next.pullAfter;
            delete next.pullCursorAtStart;
          }
        },
      });
      if (!applied.success || !nextAfter) break;
    }

    // 전체 모드가 끝나지 않은 채 끝났다면 다음 회차가 이어 갑니다.
    if (fullMode && ledger.full && !failure && !abortedRound && !endRound && !uploadStalled) continuing = true;

    return compose();
  } catch (error: any) {
    const kind = classifyFailure(error);
    if (kind === 'notFound') { familyNotFound = true; readyFamilyKeys.delete(key); }
    if (kind === 'gone') { familyUnavailable = true; readyFamilyKeys.delete(key); }
    if (!failure) failure = { error, kind };
    return compose();
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
    if ((error as { status?: unknown } | null)?.status === 410) readyFamilyKeys.delete(normalizedKey);
    return {
      scheduled: false,
      canDeleteNow: false,
      error: (error as { status?: unknown } | null)?.status === 410 ? ALREADY_DELETED_MESSAGE : describeSyncError(error),
    };
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
    return { success: false, error: (error as { status?: unknown } | null)?.status === 410 ? ALREADY_DELETED_MESSAGE : describeSyncError(error) };
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
    return { success: false, error: (error as { status?: unknown } | null)?.status === 410 ? ALREADY_DELETED_MESSAGE : describeSyncError(error) };
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
    // 410: 다른 기기가 먼저 영구 삭제했습니다. 원하던 결과이므로 성공으로 봅니다.
    if ((error as { status?: unknown } | null)?.status === 410) return { success: true };
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

  let intervalId: ReturnType<typeof setInterval> | undefined;

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
      if (!active) return;
      // 410은 가족이 영구 삭제됐다는 뜻이라 폴링을 멈춥니다. 오류 객체의 status로 호출자가 구별합니다.
      if (err?.status === 410) {
        active = false;
        if (intervalId) clearInterval(intervalId);
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // 초기 1회 즉시 실행
  check().catch(() => {});

  // 90초 주기 경량 폴링
  intervalId = setInterval(() => {
    check().catch(() => {});
  }, 90_000);

  return () => {
    active = false;
    if (intervalId) clearInterval(intervalId);
  };
};
