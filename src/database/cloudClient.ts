import { BabyLogEntry, BabyProfile } from '../types';
import { getWorkerUrl } from './cloudConfig';

export interface ConnectFamilyResponse {
  ok: boolean;
  isNewFamily?: boolean;
  error?: string;
}

export interface SyncTokenResponse {
  ok: boolean;
  changeToken?: string;
  profileUpdatedAt?: number;
  deletionReadyAt?: number | null;
  error?: string;
}

export interface SyncPullRequest {
  afterUpdatedAt: number;
  afterLogId: string;
  limit: number;
}

export interface SyncDataPayload {
  pushLogs?: BabyLogEntry[];
  pushProfile?: Partial<BabyProfile>;
  pushDeletedIds?: string[];
  /** 없으면 서버는 당겨 받기를 하지 않습니다(skipPull). */
  pull?: SyncPullRequest;
}

export interface SyncDataResponse {
  ok: boolean;
  acceptedIds?: string[];
  remoteLogs?: BabyLogEntry[];
  remoteDeletedIds?: string[];
  remoteProfile?: Partial<BabyProfile>;
  profileRejected?: boolean;
  hasMore?: boolean;
  nextAfter?: { updatedAt: number; logId: string };
  cursorCandidate?: number;
  maxPushItems?: number;
  maxPageRows?: number;
  error?: string;
}

export interface FamilyDeletionStatusResponse {
  ok: boolean;
  scheduled: boolean;
  readyAt?: number;
  canDeleteNow: boolean;
  error?: string;
}

// 요청 하나의 상한(10초)과 한 회차의 시간 예산(전체 모드 당겨 받기 6초, 모든 요청 8초)입니다.
// 모두 20초 회차 상한(App의 SYNC_TIMEOUT_MS) 안에 올리기 시간을 남기려는 값이고,
// 시험에서만 setSyncTimingForTests로 줄입니다. 앱 코드는 이 함수를 부르지 않습니다.
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PULL_BUDGET_MS = 6_000;
const DEFAULT_CYCLE_BUDGET_MS = 8_000;

let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
let pullBudgetMs = DEFAULT_PULL_BUDGET_MS;
let cycleBudgetMs = DEFAULT_CYCLE_BUDGET_MS;

export interface SyncTiming {
  requestTimeoutMs: number;
  pullBudgetMs: number;
  cycleBudgetMs: number;
}

export const setSyncTimingForTests = (timing: Partial<SyncTiming>): void => {
  if (timing.requestTimeoutMs !== undefined) requestTimeoutMs = timing.requestTimeoutMs;
  if (timing.pullBudgetMs !== undefined) pullBudgetMs = timing.pullBudgetMs;
  if (timing.cycleBudgetMs !== undefined) cycleBudgetMs = timing.cycleBudgetMs;
};

export const getSyncTiming = (): SyncTiming => ({ requestTimeoutMs, pullBudgetMs, cycleBudgetMs });

async function requestJson<T>(
  endpoint: string,
  syncKey: string,
  clientId: string,
  options: {
    method?: string;
    body?: any;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const workerUrl = getWorkerUrl().replace(/\/+$/, '');
  const url = `${workerUrl}${endpoint}`;
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${syncKey}`,
      'X-Client-Id': clientId,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const errorMsg = data?.error || `HTTP ${res.status}`;
      const err = new Error(errorMsg);
      (err as any).status = res.status;
      (err as any).error = errorMsg;
      throw err;
    }

    return data as T;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      const err = new Error('네트워크 요청 시간이 초과되었습니다.');
      (err as any).isTimeout = true;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const connectFamily = async (
  syncKey: string,
  clientId: string,
  allowCreate: boolean
): Promise<ConnectFamilyResponse> => {
  return requestJson<ConnectFamilyResponse>('/api/family/connect', syncKey, clientId, {
    method: 'POST',
    body: { allowCreate },
  });
};

export const getSyncToken = async (
  syncKey: string,
  clientId: string
): Promise<SyncTokenResponse> => {
  return requestJson<SyncTokenResponse>('/api/family/token', syncKey, clientId, {
    method: 'GET',
  });
};

export const postSync = async (
  syncKey: string,
  clientId: string,
  payload: SyncDataPayload
): Promise<SyncDataResponse> => {
  return requestJson<SyncDataResponse>('/api/family/sync', syncKey, clientId, {
    method: 'POST',
    body: payload,
  });
};

export const scheduleFamilyDeletion = async (
  syncKey: string,
  clientId: string
): Promise<{ ok: boolean; readyAt?: number; error?: string }> => {
  return requestJson<{ ok: boolean; readyAt?: number; error?: string }>(
    '/api/family/delete-schedule',
    syncKey,
    clientId,
    { method: 'POST' }
  );
};

export const cancelFamilyDeletion = async (
  syncKey: string,
  clientId: string
): Promise<{ ok: boolean; error?: string }> => {
  return requestJson<{ ok: boolean; error?: string }>(
    '/api/family/cancel-delete',
    syncKey,
    clientId,
    { method: 'POST' }
  );
};

export const deleteFamilyData = async (
  syncKey: string,
  clientId: string
): Promise<{ ok: boolean; error?: string }> => {
  return requestJson<{ ok: boolean; error?: string }>(
    '/api/family/delete',
    syncKey,
    clientId,
    { method: 'POST' }
  );
};

export const getFamilyDeletionStatus = async (
  syncKey: string,
  clientId: string
): Promise<FamilyDeletionStatusResponse> => {
  return requestJson<FamilyDeletionStatusResponse>(
    '/api/family/deletion-status',
    syncKey,
    clientId,
    { method: 'GET' }
  );
};
