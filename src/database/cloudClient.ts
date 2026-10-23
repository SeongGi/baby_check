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

export interface SyncDataPayload {
  lastSyncedAt?: number;
  pushLogs?: BabyLogEntry[];
  pushProfile?: Partial<BabyProfile>;
  pushDeletedIds?: string[];
}

export interface SyncDataResponse {
  ok: boolean;
  serverTime?: number;
  remoteLogs?: BabyLogEntry[];
  remoteDeletedIds?: string[];
  remoteProfile?: Partial<BabyProfile>;
  supersededIds?: string[];
  error?: string;
}

export interface FamilyDeletionStatusResponse {
  ok: boolean;
  scheduled: boolean;
  readyAt?: number;
  canDeleteNow: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
