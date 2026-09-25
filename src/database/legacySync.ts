import { BabyLogEntry, BabyProfile } from '../types';

const KEYVALUE_APP_KEY = '1w3sbtb8';
const KEYVALUE_BASE_URL = 'https://keyvalue.immanuel.co/api/KeyVal';
const EXTENDSCLASS_BASE_URL = 'https://extendsclass.com/api/json-storage/bin';
const TIMEOUT_MS = 12_000;

const request = async (url: string, init?: RequestInit) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const mappingKey = (syncKey: string) => `baby_check_map_${syncKey}`;

const getLegacyBinId = async (syncKey: string): Promise<string | null> => {
  const response = await request(
    `${KEYVALUE_BASE_URL}/GetValue/${KEYVALUE_APP_KEY}/${mappingKey(syncKey)}?t=${Date.now()}`,
  );
  if (!response.ok) throw new Error(`Legacy mapping read failed (${response.status})`);
  let value = (await response.text()).trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return value || null;
};

export const readLegacyCloud = async (
  syncKey: string,
): Promise<{ logs: BabyLogEntry[]; profile: BabyProfile | null } | null> => {
  try {
    const binId = await getLegacyBinId(syncKey);
    if (!binId) return null;
    const response = await request(`${EXTENDSCLASS_BASE_URL}/${binId}?t=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Legacy data read failed (${response.status})`);
    const data = await response.json();
    return {
      logs: Array.isArray(data?.logs) ? data.logs : [],
      profile: data?.profile && typeof data.profile === 'object' ? data.profile : null,
    };
  } catch (error) {
    // Firebase 전환 중에도 서버 장애가 앱 사용을 막지 않게 하되, 로컬/Firebase
    // 데이터는 그대로 유지합니다. 다음 동기화에서 다시 읽습니다.
    console.warn('Legacy cloud migration read failed', error);
    return null;
  }
};
