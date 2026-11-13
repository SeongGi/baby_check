// 상대 기기 기록 알림의 설정 저장과 서버 등록 맞추기(reconcile) 순수 로직입니다.
// node 테스트가 이 파일을 바로 실행하므로 런타임에는 다른 파일을 가져오지 않고 enum과 namespace를 쓰지 않습니다.
// 알림 권한, 푸시 토큰, 저장소, 서버 호출은 모두 deps로 받습니다. 실제 구현은 partnerPushDeps.ts에 있습니다.

export type PartnerPushType =
  | 'formula'
  | 'urine'
  | 'stool'
  | 'bath'
  | 'weight'
  | 'temperature'
  | 'sleep'
  | 'tummyTime'
  | 'play';

// 서버(server/src/push.ts PUSH_TYPES)와 같은 9종이며, 지문에 넣을 때도 이 순서를 씁니다.
export const PARTNER_PUSH_TYPES: PartnerPushType[] = [
  'formula',
  'urine',
  'stool',
  'bath',
  'weight',
  'temperature',
  'sleep',
  'tummyTime',
  'play',
];

export type PartnerPushSettings = {
  enabled: boolean;
  types: PartnerPushType[];
  /** 방해 금지 시간대(하루 중 분 단위, 0~1439). 없으면 null입니다. */
  quiet: { start: number; end: number } | null;
};

export const PARTNER_PUSH_SETTINGS_KEY = '@partner_push_settings';
export const PARTNER_PUSH_REGISTERED_KEY = '@partner_push_registered';
/** 해제 요청이 실패해 서버에 행이 남았을 수 있는 (가족 키, 기기 번호) 쌍의 목록 키입니다. */
export const PARTNER_PUSH_UNREGISTER_PENDING_KEY = '@partner_push_unregister_pending';

/** 서버에 등록해 둔 내용의 기록입니다. 해제 요청에 옛 키가 필요해서 syncKey 원문을 따로 보관합니다. */
export type PartnerPushRegisteredRecord = {
  fingerprint: string;
  syncKey: string;
  clientId: string;
};

/** 서버(server/src/push.ts parsePushRegistration)가 받는 등록 본문입니다. cloudClient.ts의 PushRegisterBody가 이 타입을 그대로 씁니다. */
export type PartnerPushRegisterBody = {
  token: string;
  types: PartnerPushType[];
  quietStart: number | null;
  quietEnd: number | null;
  /** 현지 시각 - UTC를 분으로 나타낸 값입니다(한국은 540). */
  tzOffsetMinutes: number;
};

/** 해제 요청이 아직 서버에 닿지 않은 등록 하나입니다. */
export type PartnerPushPendingUnregister = {
  syncKey: string;
  clientId: string;
};

export type PartnerPushChannelSpec = {
  name: string;
  importance: 'high' | 'low';
  sound: boolean;
  vibrate: boolean;
};

export interface PartnerPushDeps {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  /** 권한을 조회만 합니다. 요청 창은 절대 띄우지 않습니다. */
  getPermissionsAsync(): Promise<{ status: string }>;
  setNotificationChannelAsync(channelId: string, spec: PartnerPushChannelSpec): Promise<unknown>;
  getExpoPushTokenAsync(options: { projectId: string }): Promise<{ data: string }>;
  sha256Hex(text: string): Promise<string>;
  registerPushDevice(
    syncKey: string,
    clientId: string,
    body: PartnerPushRegisterBody
  ): Promise<{ ok: boolean; error?: string }>;
  unregisterPushDevice(
    syncKey: string,
    clientId: string,
    options?: { timeoutMs?: number }
  ): Promise<{ ok: boolean; error?: string }>;
  platformOS: string;
  /** JS `Date#getTimezoneOffset`과 같은 값(UTC - 현지, 분)입니다. 한국은 -540입니다. */
  getTimezoneOffset(): number;
  projectId: string;
  /** 권한 조회를 기다리는 최대 시간(ms)입니다. 없으면 5초이며, 시험에서만 줄여 씁니다. */
  permissionTimeoutMs?: number;
  /** 푸시 토큰 조회를 기다리는 최대 시간(ms)입니다. 없으면 10초이며, 시험에서만 줄여 씁니다. */
  tokenTimeoutMs?: number;
}

export type PartnerPushSettingsDeps = Pick<PartnerPushDeps, 'storage' | 'getPermissionsAsync'>;

export const PARTNER_PUSH_CHANNEL_ID = 'partner-records';
export const PARTNER_PUSH_QUIET_CHANNEL_ID = 'partner-records-quiet';

// 해제 요청은 화면 흐름을 막지 않도록 이 시간까지만 기다립니다.
const UNREGISTER_TIMEOUT_MS = 2000;
// 권한 조회와 토큰 조회가 끝나지 않아도 reconcile이 멈춰 있지 않도록 기다리는 최대 시간입니다.
const PERMISSION_TIMEOUT_MS = 5000;
const TOKEN_TIMEOUT_MS = 10000;
// 해제 대기 목록은 이 개수까지만 두고, 넘치면 가장 오래된 것부터 버립니다.
const MAX_PENDING_UNREGISTER = 5;

// 약속이 시간 안에 끝나지 않으면 거절합니다. 타이머는 끝나면 반드시 지웁니다.
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const isMinuteOfDay = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1439;

const sanitizeQuiet = (value: unknown): { start: number; end: number } | null => {
  if (!value || typeof value !== 'object') return null;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (!isMinuteOfDay(start) || !isMinuteOfDay(end) || start === end) return null;
  return { start, end };
};

// 알 수 없는 종류와 중복을 버리고 정해진 순서로 되돌립니다.
const canonicalTypes = (value: unknown): PartnerPushType[] => {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return PARTNER_PUSH_TYPES.filter(type => list.includes(type));
};

const defaultSettings = (enabled: boolean): PartnerPushSettings => ({
  enabled,
  types: [...PARTNER_PUSH_TYPES],
  quiet: null,
});

// 저장된 문자열을 설정으로 바꿉니다. 깨졌거나 모양이 맞지 않으면 null이며 "저장된 값 없음"과 같게 다룹니다.
const parseSettings = (raw: string | null): PartnerPushSettings | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.enabled !== 'boolean') return null;
    return {
      enabled: parsed.enabled,
      types: Array.isArray(parsed.types) ? canonicalTypes(parsed.types) : [...PARTNER_PUSH_TYPES],
      quiet: sanitizeQuiet(parsed.quiet),
    };
  } catch {
    return null;
  }
};

export const savePartnerPushSettings = async (
  deps: Pick<PartnerPushDeps, 'storage'>,
  settings: PartnerPushSettings
): Promise<void> => {
  const clean: PartnerPushSettings = {
    enabled: settings.enabled === true,
    types: canonicalTypes(settings.types),
    quiet: sanitizeQuiet(settings.quiet),
  };
  await deps.storage.setItem(PARTNER_PUSH_SETTINGS_KEY, JSON.stringify(clean));
};

// 저장된 설정을 읽습니다. 값이 아직 없으면 그때 알림 권한을 조회(요청 창 없음)해서 처음 상태를 정하고 저장합니다.
// 한 번 저장한 뒤에는 권한이 바뀌어도 다시 정하지 않습니다.
export const loadPartnerPushSettings = async (deps: PartnerPushSettingsDeps): Promise<PartnerPushSettings> => {
  const stored = parseSettings(await deps.storage.getItem(PARTNER_PUSH_SETTINGS_KEY));
  if (stored) return stored;

  let granted = false;
  try {
    granted = (await deps.getPermissionsAsync()).status === 'granted';
  } catch {
    // 권한을 조회하지 못하면 꺼진 상태로 돌려주되 저장하지 않아서, 다음 호출 때 다시 정하게 합니다.
    return defaultSettings(false);
  }
  const initial = defaultSettings(granted);
  await savePartnerPushSettings(deps, initial);
  return initial;
};

/** 서버에 보낸 내용을 가리키는 지문입니다. 가족 키 원문은 넣지 않고 해시만 넣습니다. */
export const buildPartnerPushFingerprint = (parts: {
  syncKeyHash: string;
  clientId: string;
  token: string;
  types: PartnerPushType[];
  quietStart: number | null;
  quietEnd: number | null;
  tzOffsetMinutes: number;
}): string =>
  [
    parts.syncKeyHash,
    parts.clientId,
    parts.token,
    canonicalTypes(parts.types).join(','),
    parts.quietStart === null ? '' : String(parts.quietStart),
    parts.quietEnd === null ? '' : String(parts.quietEnd),
    String(parts.tzOffsetMinutes),
  ].join('|');

// JS의 getTimezoneOffset은 서버가 쓰는 값과 부호가 반대이므로 뒤집어서 보냅니다(한국: -540 -> 540).
export const toTzOffsetMinutes = (jsTimezoneOffset: number): number => Math.round(-jsTimezoneOffset) || 0;

/**
 * reconcilePartnerPush 결과 상태입니다.
 * - no_family: 가족 키나 기기 번호가 없어서 푸시 관련 호출을 하지 않았습니다.
 * - disabled: 설정이 꺼졌거나 받을 종류가 없습니다(등록 기록이 있었다면 해제했습니다).
 * - permission_denied: 알림 권한이 허용 상태가 아닙니다(등록 기록이 있었다면 해제했습니다).
 * - registered: 서버에 새로 등록(또는 갱신)했습니다.
 * - unchanged: 이미 같은 내용으로 등록돼 있어서 보내지 않았습니다.
 * - rejected: 서버가 403·404·410으로 거절했습니다. 기록을 지웠고 같은 입력으로는 앱을 다시 켤 때까지 다시 시도하지 않습니다.
 * - network_error: 네트워크나 그 밖의 오류입니다. 삼켰고 기록은 그대로 두어서 다음 호출 때 다시 시도합니다.
 * - token_error: 권한 조회나 푸시 토큰 조회가 실패해서 등록하지 않았습니다(화면 안내용).
 */
export type PartnerPushStatus =
  | 'no_family'
  | 'disabled'
  | 'permission_denied'
  | 'registered'
  | 'unchanged'
  | 'rejected'
  | 'network_error'
  | 'token_error';

export type ReconcileArgs = {
  syncKey: string | null | undefined;
  clientId: string | null | undefined;
  settings: PartnerPushSettings;
};

const parseRegisteredRecord = (raw: string | null): PartnerPushRegisteredRecord | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.fingerprint === 'string' &&
      typeof parsed.syncKey === 'string' &&
      typeof parsed.clientId === 'string'
    ) {
      return { fingerprint: parsed.fingerprint, syncKey: parsed.syncKey, clientId: parsed.clientId };
    }
  } catch {
    // 깨진 기록은 없는 것으로 봅니다.
  }
  return null;
};

type ReconcileState = {
  running: boolean;
  pending: { args: ReconcileArgs; waiters: Array<(status: PartnerPushStatus) => void> } | null;
  /** 서버가 거절한 입력(토큰 제외)입니다. 같은 입력이면 다시 보내지 않습니다. 앱을 다시 켜면 비워집니다. */
  rejectedKey: string | null;
};

// deps 하나마다 직렬화 상태를 따로 둡니다.
const states = new WeakMap<object, ReconcileState>();

const getState = (deps: PartnerPushDeps): ReconcileState => {
  let state = states.get(deps);
  if (!state) {
    state = { running: false, pending: null, rejectedKey: null };
    states.set(deps, state);
  }
  return state;
};

const clearRecord = async (deps: PartnerPushDeps): Promise<void> => {
  await deps.storage.removeItem(PARTNER_PUSH_REGISTERED_KEY);
};

const parsePending = (raw: string | null): PartnerPushPendingUnregister[] => {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list: PartnerPushPendingUnregister[] = [];
    for (const item of parsed) {
      if (item && typeof item.syncKey === 'string' && typeof item.clientId === 'string') {
        if (!list.some(entry => entry.syncKey === item.syncKey && entry.clientId === item.clientId)) {
          list.push({ syncKey: item.syncKey, clientId: item.clientId });
        }
      }
    }
    return list.slice(-MAX_PENDING_UNREGISTER);
  } catch {
    // 깨진 목록은 비어 있는 것으로 봅니다.
    return [];
  }
};

const readPending = async (deps: PartnerPushDeps): Promise<PartnerPushPendingUnregister[]> =>
  parsePending(await deps.storage.getItem(PARTNER_PUSH_UNREGISTER_PENDING_KEY));

const writePending = async (deps: PartnerPushDeps, list: PartnerPushPendingUnregister[]): Promise<void> => {
  if (list.length === 0) {
    await deps.storage.removeItem(PARTNER_PUSH_UNREGISTER_PENDING_KEY);
  } else {
    await deps.storage.setItem(PARTNER_PUSH_UNREGISTER_PENDING_KEY, JSON.stringify(list));
  }
};

// 같은 쌍은 하나로 합치고, 최대 개수를 넘으면 가장 오래된 것을 버립니다.
const addPending = async (deps: PartnerPushDeps, entry: PartnerPushPendingUnregister): Promise<void> => {
  const list = (await readPending(deps)).filter(item => item.syncKey !== entry.syncKey || item.clientId !== entry.clientId);
  list.push({ syncKey: entry.syncKey, clientId: entry.clientId });
  await writePending(deps, list.slice(-MAX_PENDING_UNREGISTER));
};

// 해당 쌍을 대기 목록에서 지웁니다. 바뀐 것이 없으면 저장소에 쓰지 않습니다.
const removePending = async (deps: PartnerPushDeps, syncKey: string, clientId: string): Promise<void> => {
  const list = await readPending(deps);
  const kept = list.filter(item => item.syncKey !== syncKey || item.clientId !== clientId);
  if (kept.length !== list.length) await writePending(deps, kept);
};

// 해제 요청을 한 번 보냅니다. 서버가 처리했거나 가족이 이미 없어졌으면(404·410) true, 그 밖의 실패는 false입니다.
const sendUnregister = async (deps: PartnerPushDeps, syncKey: string, clientId: string): Promise<boolean> => {
  try {
    const response = await deps.unregisterPushDevice(syncKey, clientId, { timeoutMs: UNREGISTER_TIMEOUT_MS });
    return !!response && response.ok === true;
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    return status === 404 || status === 410;
  }
};

// 지난번에 실패한 해제 요청을 하나씩 한 번만 다시 보냅니다. 성공했거나 404·410인 것만 목록에서 빼고 나머지는 남깁니다.
const retryPendingUnregisters = async (deps: PartnerPushDeps): Promise<void> => {
  const list = await readPending(deps);
  if (list.length === 0) return;
  const kept: PartnerPushPendingUnregister[] = [];
  for (const entry of list) {
    if (!(await sendUnregister(deps, entry.syncKey, entry.clientId))) kept.push(entry);
  }
  if (kept.length !== list.length) await writePending(deps, kept);
};

// 저장된 값으로 해제 요청을 보낸 뒤 기록을 지웁니다.
// 해제 요청이 실패하면 서버에 행이 남아 있을 수 있으므로(서버는 가족 삭제, 토큰 만료, 같은 토큰의 다른 등록 때만 행을 지웁니다)
// 같은 값을 대기 목록에 넣어 다음 reconcile에서 다시 보냅니다. 기록은 지금 등록 상태를 설명하지 않으므로 어느 경우든 지웁니다.
const unregisterStored = async (deps: PartnerPushDeps, record: PartnerPushRegisteredRecord): Promise<void> => {
  const done = await sendUnregister(deps, record.syncKey, record.clientId);
  if (!done) await addPending(deps, record);
  await clearRecord(deps);
};

const rejectedStatus = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404 || status === 410;
};

const reconcileOnce = async (args: ReconcileArgs, deps: PartnerPushDeps): Promise<PartnerPushStatus> => {
  const state = getState(deps);
  const syncKey = typeof args.syncKey === 'string' ? args.syncKey : '';
  const clientId = typeof args.clientId === 'string' ? args.clientId : '';

  // 0. 지난번에 실패한 해제 요청을 먼저 다시 보냅니다. 가족 키가 없어도 하는 유일한 서버 호출이며, 대기 목록이 비어 있으면 호출이 없습니다.
  await retryPendingUnregisters(deps);

  // 1. 등록 기록의 가족 키나 기기 번호가 지금과 다르면 저장된 값으로 해제하고 기록을 지웁니다.
  let record = parseRegisteredRecord(await deps.storage.getItem(PARTNER_PUSH_REGISTERED_KEY));
  if (record && (record.syncKey !== syncKey || record.clientId !== clientId)) {
    await unregisterStored(deps, record);
    record = null;
  }

  // 2. 가족 키가 없으면 여기서 끝냅니다. 권한, 채널, 토큰, 서버 호출을 하지 않습니다.
  if (!syncKey || !clientId) return 'no_family';

  const types = canonicalTypes(args.settings.types);
  const quiet = sanitizeQuiet(args.settings.quiet);

  // 3. 꺼져 있거나 받을 종류가 없거나 권한이 없으면 등록 기록이 있을 때만 해제합니다.
  if (args.settings.enabled !== true || types.length === 0) {
    if (record) await unregisterStored(deps, record);
    return 'disabled';
  }
  let permissionStatus: string;
  try {
    permissionStatus = (await withTimeout(deps.getPermissionsAsync(), deps.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS)).status;
  } catch {
    return 'token_error';
  }
  if (permissionStatus !== 'granted') {
    if (record) await unregisterStored(deps, record);
    return 'permission_denied';
  }

  const tzOffsetMinutes = toTzOffsetMinutes(deps.getTimezoneOffset());
  const syncKeyHash = await deps.sha256Hex(syncKey);

  // 서버가 거절한 입력은 토큰 조회 전에 걸러서, 같은 입력으로 되풀이해 묻지 않습니다.
  const inputKey = buildPartnerPushFingerprint({
    syncKeyHash,
    clientId,
    token: '',
    types,
    quietStart: quiet ? quiet.start : null,
    quietEnd: quiet ? quiet.end : null,
    tzOffsetMinutes,
  });
  if (state.rejectedKey === inputKey) return 'rejected';

  // 4. Android는 토큰을 얻기 전에 채널 두 개를 만듭니다. 이미 있으면 그대로 두는 호출이라 매번 불러도 됩니다.
  // 채널이 한 번 만들어진 뒤에는 중요도와 소리를 바꿀 수 없으므로, 이 사양을 바꾸려면 새 채널 번호를 써야 합니다.
  if (deps.platformOS === 'android') {
    try {
      await deps.setNotificationChannelAsync(PARTNER_PUSH_CHANNEL_ID, {
        name: '가족 기록 알림',
        importance: 'high',
        sound: true,
        vibrate: true,
      });
      await deps.setNotificationChannelAsync(PARTNER_PUSH_QUIET_CHANNEL_ID, {
        name: '가족 기록 알림(조용히)',
        importance: 'low',
        sound: false,
        vibrate: false,
      });
    } catch {
      // 채널을 못 만들어도 토큰 조회는 시도합니다. 알림은 기본 채널로 도착할 수 있습니다.
    }
  }

  let token: string;
  try {
    token = (
      await withTimeout(
        deps.getExpoPushTokenAsync({ projectId: deps.projectId }),
        deps.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS
      )
    ).data;
  } catch {
    return 'token_error';
  }
  if (typeof token !== 'string' || !token) return 'token_error';

  const fingerprint = buildPartnerPushFingerprint({
    syncKeyHash,
    clientId,
    token,
    types,
    quietStart: quiet ? quiet.start : null,
    quietEnd: quiet ? quiet.end : null,
    tzOffsetMinutes,
  });
  if (record && record.fingerprint === fingerprint) return 'unchanged';

  try {
    const response = await deps.registerPushDevice(syncKey, clientId, {
      token,
      types,
      quietStart: quiet ? quiet.start : null,
      quietEnd: quiet ? quiet.end : null,
      tzOffsetMinutes,
    });
    if (!response || response.ok !== true) return 'network_error';
  } catch (error) {
    if (rejectedStatus(error)) {
      // 가족 상태는 동기화가 처리하므로 여기서는 기록만 지우고 같은 입력으로는 다시 시도하지 않습니다.
      state.rejectedKey = inputKey;
      await clearRecord(deps);
      return 'rejected';
    }
    // 네트워크 오류 등은 기록을 그대로 두어 다음 호출 때 다시 시도합니다.
    return 'network_error';
  }
  state.rejectedKey = null;
  // 방금 등록한 쌍의 해제 대기가 남아 있으면 이후 재시도가 새 등록을 지우므로, 기록을 저장하기 전에 먼저 뺍니다.
  await removePending(deps, syncKey, clientId);
  const saved: PartnerPushRegisteredRecord = { fingerprint, syncKey, clientId };
  await deps.storage.setItem(PARTNER_PUSH_REGISTERED_KEY, JSON.stringify(saved));
  return 'registered';
};

const reconcileSafely = async (args: ReconcileArgs, deps: PartnerPushDeps): Promise<PartnerPushStatus> => {
  try {
    return await reconcileOnce(args, deps);
  } catch {
    // 저장소 오류 등 예상 밖 오류도 삼킵니다. 호출한 쪽 화면 흐름을 깨지 않고 다음 호출 때 다시 맞춥니다.
    return 'network_error';
  }
};

/**
 * 등록과 해제를 한 곳에서 맞춥니다(설계 3.2). 동시에 여러 번 불리면 직렬로 실행합니다.
 * 실행 중에 들어온 호출들은 하나로 합쳐서 가장 나중 인자로 한 번만 더 실행하고,
 * 합쳐진 호출들은 그 마지막 실행의 결과를 받습니다.
 */
export const reconcilePartnerPush = (args: ReconcileArgs, deps: PartnerPushDeps): Promise<PartnerPushStatus> => {
  const state = getState(deps);
  if (state.running) {
    return new Promise<PartnerPushStatus>(resolve => {
      if (state.pending) {
        state.pending.args = args;
        state.pending.waiters.push(resolve);
      } else {
        state.pending = { args, waiters: [resolve] };
      }
    });
  }
  state.running = true;
  return (async () => {
    try {
      const first = await reconcileSafely(args, deps);
      while (state.pending) {
        const next = state.pending;
        state.pending = null;
        const status = await reconcileSafely(next.args, deps);
        for (const resolve of next.waiters) resolve(status);
      }
      return first;
    } finally {
      state.running = false;
    }
  })();
};
