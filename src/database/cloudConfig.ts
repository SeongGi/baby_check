// Cloudflare Worker 백엔드 설정

export const DEFAULT_WORKER_URL = 'https://baby-check-sync.baby-check-sync-server.workers.dev';

let customWorkerUrl: string | null = null;

export const setCustomWorkerUrl = (url: string | null) => {
  customWorkerUrl = url;
};

export const getWorkerUrl = (): string => {
  if (customWorkerUrl) return customWorkerUrl;
  return DEFAULT_WORKER_URL;
};
