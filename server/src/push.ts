import type { Env } from './index';

/** 알림 대상 기록 종류 9종. diary, diaryComment는 대상이 아니다. */
export const PUSH_TYPES = [
  'formula',
  'urine',
  'stool',
  'bath',
  'weight',
  'temperature',
  'sleep',
  'tummyTime',
  'play',
] as const;
export type PushType = (typeof PUSH_TYPES)[number];

const PUSH_TYPE_SET: ReadonlySet<string> = new Set(PUSH_TYPES);

/** 이 시간보다 오래된 기록은 새 기록으로 보지 않는다(이전, 전체 대조, 백업 복원을 거른다). */
export const PUSH_RECENT_WINDOW_MS = 30 * 60 * 1000;
/** 한 요청에서 확정된 새 기록이 이 수를 넘으면 알림을 보내지 않는다. */
export const PUSH_MAX_NEW_LOGS = 40;
const EXPO_BATCH_SIZE = 100;
const EXPO_TIMEOUT_MS = 5000;
const DEFAULT_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_TOKEN_LENGTH = 200;
const MINUTE_MS = 60_000;

export interface PushCandidate {
  id: string;
  raw: string;
  type: PushType;
  timestamp: number;
  log: Record<string, unknown>;
}

export interface NewPushLog {
  id: string;
  type: PushType;
  timestamp: number;
  log: Record<string, unknown>;
}

export interface PushDeviceRow {
  client_id: string;
  token: string;
  types_json: string;
  quiet_start: number | null;
  quiet_end: number | null;
  tz_offset_min: number;
}

/** 2.4의 1단계: 메모리 계산만으로 후보를 고른다. D1 문장은 쓰지 않는다. */
export function pickPushCandidates(
  pushLogs: ReadonlyArray<{ id: string; raw: string }>,
  serverNow: number,
): PushCandidate[] {
  const candidates: PushCandidate[] = [];
  for (const entry of pushLogs) {
    try {
      const log = JSON.parse(entry.raw) as Record<string, unknown> | null;
      if (!log || typeof log !== 'object') continue;
      const type = log.type;
      if (typeof type !== 'string' || !PUSH_TYPE_SET.has(type)) continue;
      const timestamp = log.timestamp;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
      if (timestamp < serverNow - PUSH_RECENT_WINDOW_MS) continue;
      candidates.push({ id: entry.id, raw: entry.raw, type: type as PushType, timestamp, log });
    } catch {
      // 해석할 수 없는 기록은 후보에서 뺀다.
    }
  }
  return candidates;
}

/**
 * 2.4의 4~5단계: 쓰기 뒤 읽은 행으로 새 기록을 확정한다.
 * 쓰기 배치 안에서 이미 있던 것으로 확인된 id(preExisting)와 삭제 표식이 있거나 보낸 값과 다른 행은 뺀다.
 * 확정된 기록이 한도를 넘으면 빈 배열을 돌려준다.
 */
export function confirmNewPushLogs(
  candidates: ReadonlyArray<PushCandidate>,
  preExisting: ReadonlySet<string>,
  serverRows: ReadonlyMap<string, { deleted_at: number | null; raw_json: string }>,
): NewPushLog[] {
  const confirmed: NewPushLog[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (preExisting.has(candidate.id) || seen.has(candidate.id)) continue;
    const row = serverRows.get(candidate.id);
    if (!row || row.deleted_at !== null || row.raw_json !== candidate.raw) continue;
    seen.add(candidate.id);
    confirmed.push({ id: candidate.id, type: candidate.type, timestamp: candidate.timestamp, log: candidate.log });
  }
  return confirmed.length > PUSH_MAX_NEW_LOGS ? [] : confirmed;
}

/** 등록 본문 검증 결과. types가 비면 등록하지 않고 해제와 같게 처리한다. */
export interface PushRegistration {
  token: string;
  types: PushType[];
  quietStart: number | null;
  quietEnd: number | null;
  tzOffsetMinutes: number;
}

const isMinuteOfDay = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1439;

/** 2.2의 검증 규칙. 토큰이 잘못되면 null을 돌려주고 호출한 쪽이 400 invalid_push_token으로 답한다. */
export function parsePushRegistration(body: any): PushRegistration | null {
  const token = body?.token;
  if (
    typeof token !== 'string' ||
    token.length > MAX_TOKEN_LENGTH ||
    !(token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['))
  ) {
    return null;
  }
  const rawTypes: unknown[] = Array.isArray(body.types) ? body.types : [];
  const types = PUSH_TYPES.filter(type => rawTypes.includes(type));
  const quietOk =
    isMinuteOfDay(body.quietStart) && isMinuteOfDay(body.quietEnd) && body.quietStart !== body.quietEnd;
  const tz = body.tzOffsetMinutes;
  const tzOk = typeof tz === 'number' && Number.isInteger(tz) && tz >= -840 && tz <= 840;
  return {
    token,
    types,
    quietStart: quietOk ? body.quietStart : null,
    quietEnd: quietOk ? body.quietEnd : null,
    tzOffsetMinutes: tzOk ? tz : 540,
  };
}

/** 기기 현지 시각의 하루 중 분(0~1439). */
function localMinuteOfDay(utcMs: number, tzOffsetMin: number): number {
  return ((Math.floor(utcMs / MINUTE_MS) + tzOffsetMin) % 1440 + 1440) % 1440;
}

/** 방해 금지 시간대인지 판정한다. 시작이 끝보다 크면 자정을 넘는 구간이다. */
export function isQuietNow(
  serverNow: number,
  tzOffsetMin: number,
  quietStart: number | null,
  quietEnd: number | null,
): boolean {
  if (quietStart === null || quietEnd === null || quietStart === quietEnd) return false;
  const m = localMinuteOfDay(serverNow, tzOffsetMin);
  return quietStart < quietEnd ? m >= quietStart && m < quietEnd : m >= quietStart || m < quietEnd;
}

/** "오전/오후 h:mm" 형식. Intl에 기대지 않고 직접 만든다. */
export function formatClock(utcMs: number, tzOffsetMin: number): string {
  const m = localMinuteOfDay(utcMs, tzOffsetMin);
  const hour24 = Math.floor(m / 60);
  const minute = m % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour24 < 12 ? '오전' : '오후'} ${hour12}:${String(minute).padStart(2, '0')}`;
}

const positiveNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** 소수 digits자리까지 반올림하고 끝의 0을 지운다. */
function trimmedDecimal(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

function durationLabel(startMs: number, endedAt: unknown): string {
  const end = positiveNumber(endedAt);
  if (end === null) return '';
  const minutes = Math.round((end - startMs) / MINUTE_MS);
  if (minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return ` ${rest}분`;
  return rest === 0 ? ` ${hours}시간` : ` ${hours}시간 ${rest}분`;
}

/** 2.6의 요약 규칙. 수치가 없거나 유한하지 않거나 0 이하이면 수치를 뺀다. */
export function summarizeLog(entry: NewPushLog): string {
  const log = entry.log;
  switch (entry.type) {
    case 'formula': {
      const kind = log.feedingType === 'breast' ? '모유' : log.feedingType === 'mixed' ? '혼합' : '분유';
      const amount = positiveNumber(log.amount);
      return `🍼 ${kind}${amount === null ? '' : ` ${trimmedDecimal(amount, 1)}ml`}`;
    }
    case 'urine':
      return '💧 소변';
    case 'stool':
      return '💩 대변';
    case 'bath': {
      const minutes = positiveNumber(log.durationMinutes);
      return `🛁 목욕${minutes === null ? '' : ` ${trimmedDecimal(minutes, 1)}분`}`;
    }
    case 'weight': {
      const kg = positiveNumber(log.weightKg);
      return `⚖️ 체중${kg === null ? '' : ` ${trimmedDecimal(kg, 2)}kg`}`;
    }
    case 'temperature': {
      const c = positiveNumber(log.temperatureC);
      return `🌡️ 체온${c === null ? '' : ` ${trimmedDecimal(c, 1)}℃`}`;
    }
    case 'sleep':
    case 'tummyTime':
    case 'play': {
      const label = entry.type === 'sleep' ? '😴 수면' : entry.type === 'tummyTime' ? '🧸 터미타임' : '🎈 놀이';
      if (log.endedAt === undefined || log.endedAt === null) return `${label} 시작`;
      return `${label}${durationLabel(entry.timestamp, log.endedAt)}`;
    }
  }
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { kind: 'partnerLog'; logId: string; type: PushType };
  channelId: string;
  priority: 'high' | 'normal';
  sound: 'default' | null;
}

/** 2.6의 메시지 한 개. newLogs는 이 기기가 받을 종류로 걸러져 비어 있지 않아야 한다. */
export function buildExpoMessage(
  device: PushDeviceRow,
  newLogs: ReadonlyArray<NewPushLog>,
  babyName: string | null,
  serverNow: number,
): ExpoMessage {
  let latest = newLogs[0];
  for (const entry of newLogs) {
    if (entry.timestamp >= latest.timestamp) latest = entry;
  }
  const extra = newLogs.length > 1 ? ` 외 ${newLogs.length - 1}건` : '';
  const quiet = isQuietNow(serverNow, device.tz_offset_min, device.quiet_start, device.quiet_end);
  return {
    to: device.token,
    title: babyName ? `${babyName} 새 기록` : '아기 새 기록',
    body: `${summarizeLog(latest)} · ${formatClock(latest.timestamp, device.tz_offset_min)}${extra}`,
    data: { kind: 'partnerLog', logId: latest.id, type: latest.type },
    channelId: quiet ? 'partner-records-quiet' : 'partner-records',
    priority: quiet ? 'normal' : 'high',
    sound: quiet ? null : 'default',
  };
}

/** 공유 아기 정보(shared_json)에서 이름을 꺼낸다. 없거나 해석할 수 없으면 null. */
export function babyNameFromShared(sharedJson: string | null): string | null {
  if (!sharedJson) return null;
  try {
    const name = (JSON.parse(sharedJson) as { name?: unknown }).name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

function parseTypes(typesJson: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(typesJson);
    return new Set(Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * 2.5의 발송. 받을 기기를 조회해 기기마다 메시지를 만들고, 100개씩 묶어 Expo 푸시 API로 보낸다.
 * 재시도하지 않고 5초 안에 끝내며, DeviceNotRegistered 토큰의 행만 지운다.
 * 첫 줄의 await는 호출한 쪽이 waitUntil을 먼저 부르게 해서, 하네스가 이 함수의 D1 문장을 백그라운드 쿼리로 세게 한다.
 * 이 줄을 지우면 P14가 실패한다. 운영 동작에는 차이가 없다.
 */
export async function sendPartnerPush(
  env: Env,
  familyId: string,
  senderClientId: string,
  newLogs: ReadonlyArray<NewPushLog>,
  babyName: string | null,
): Promise<void> {
  await Promise.resolve();
  const found = await env.DB.prepare(
    `SELECT client_id, token, types_json, quiet_start, quiet_end, tz_offset_min
     FROM push_devices WHERE family_id = ?1 AND client_id != ?2`,
  )
    .bind(familyId, senderClientId)
    .all<PushDeviceRow>();
  const devices = found.results ?? [];
  if (devices.length === 0) return;

  const serverNow = env.clock ? env.clock() : Date.now();
  const outgoing: Array<{ device: PushDeviceRow; message: ExpoMessage }> = [];
  for (const device of devices) {
    const wanted = parseTypes(device.types_json);
    const mine = newLogs.filter(entry => wanted.has(entry.type));
    if (mine.length === 0) continue;
    outgoing.push({ device, message: buildExpoMessage(device, mine, babyName, serverNow) });
  }
  if (outgoing.length === 0) return;

  const pushFetch = env.pushFetch ?? fetch;
  const url = env.EXPO_PUSH_URL || DEFAULT_EXPO_PUSH_URL;
  const dead: PushDeviceRow[] = [];
  for (let i = 0; i < outgoing.length; i += EXPO_BATCH_SIZE) {
    const chunk = outgoing.slice(i, i + EXPO_BATCH_SIZE);
    try {
      const response = await pushFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk.map(item => item.message)),
        signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn('Expo push request failed', response.status);
        continue;
      }
      const tickets = ((await response.json()) as { data?: unknown })?.data;
      if (!Array.isArray(tickets)) continue;
      tickets.forEach((ticket: any, index: number) => {
        if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered' && chunk[index]) {
          dead.push(chunk[index].device);
        }
      });
    } catch (err) {
      console.warn('Expo push request error', err);
    }
  }

  if (dead.length > 0) {
    await env.DB.batch(
      dead.map(device =>
        env.DB.prepare('DELETE FROM push_devices WHERE family_id = ?1 AND client_id = ?2 AND token = ?3').bind(
          familyId,
          device.client_id,
          device.token,
        ),
      ),
    );
  }
}
