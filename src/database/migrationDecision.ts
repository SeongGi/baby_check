// 기존 사용자 이전(07)의 판정을 "무엇을 할지"로 바꾸는 순수 함수 모음입니다. 이 파일은 저장소,
// 네트워크, 시계를 건드리지 않으므로(시각은 인자로 받습니다) 하네스가 그대로 불러 단위 검사할 수 있고,
// App과 설정 화면은 여기 함수의 결과만 따릅니다(07 2.3 "화면 판정의 순수 함수").
// 아무것도 불러오지 않으며 import된 저장소 호출도 없습니다.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ────────────── 러너 관문 (07 2.3 규칙 1~6) ──────────────

export type MigrationGate = 'proceed' | 'paused';
/** 이전 모듈이 메모리에 두는 D1 가족 상태. 아직 모르면 undefined입니다. */
export type D1Status = 'exists' | 'missing' | 'deleted';

export interface MigrationGateInput {
  /** 연결 회차(`connecting: true`)인가 */
  connecting?: boolean;
  /** 이전 완료(`mergedAt`과 `d1UploadedAt`이 모두 있음) */
  complete: boolean;
  d1Status?: D1Status;
  /** 1.7.9 연결 근거(2.2): 표식의 keys에 이 키가 있거나 `legacyJoinedAt`이 있음 */
  hasEvidence: boolean;
}

/**
 * 러너가 평소 요청을 실행하기 전에 묻는 관문. 위에서부터 차례로 적용합니다.
 * 1 연결 회차는 거치지 않음, 2 이전 완료, 3 deleted(410 처리가 연결을 끊어야 함), 4 근거 없음(1.8.0 가족),
 * 5 근거 있고 exists, 6 그 밖(근거 있고 missing이거나 모름)은 paused.
 */
export const decideMigrationGate = (input: MigrationGateInput): MigrationGate => {
  if (input.connecting) return 'proceed';
  if (input.complete) return 'proceed';
  if (input.d1Status === 'deleted') return 'proceed';
  if (!input.hasEvidence) return 'proceed';
  if (input.d1Status === 'exists') return 'proceed';
  return 'paused';
};

/** 이전 완료는 `mergedAt`과 `d1UploadedAt`이 모두 있는 상태입니다(2.2). */
export const isMigrationComplete = (state: { mergedAt?: number; d1UploadedAt?: number } | null | undefined): boolean =>
  typeof state?.mergedAt === 'number' && typeof state?.d1UploadedAt === 'number';

/** "근거가 있다": 표식의 keys에 키가 있거나 이 키의 `legacyJoinedAt`이 있습니다(2.2). 옛 장부는 쓰지 않습니다. */
export const hasLegacyEvidence = (input: {
  syncKey: string;
  markerKeys?: readonly string[] | null;
  legacyJoinedAt?: number;
}): boolean => {
  if (typeof input.legacyJoinedAt === 'number') return true;
  const key = input.syncKey.trim();
  return !!input.markerKeys?.some(candidate => candidate.trim() === key);
};

// ────────────── 화면 판정 (07 2.3) ──────────────

/** 당겨서 새로고침의 경고창 여부. `migrationPending`은 실패가 아니므로 경고창을 띄우지 않습니다. */
export const shouldAlertOnRefresh = (result: { success: boolean; migrationPending?: boolean }): boolean =>
  !result.success && result.migrationPending !== true;

/** 폴링 시작 여부. 관문이 `'proceed'`일 때만 참입니다. */
export const shouldStartPolling = (gate: MigrationGate): boolean => gate === 'proceed';

/** 설정 화면의 D1 삭제 상태 확인 여부. 관문이 `'paused'`이면 거짓이고, 삭제 영역에 "이전 준비 중"을 보여 줍니다. */
export const shouldCheckDeletionStatus = (gate: MigrationGate): boolean => gate !== 'paused';

// ────────────── Firestore 실패 간격 (07 2.3 "실패 간격") ──────────────

export type FailureWeight = 'light' | 'heavy';

/** 가벼운 실패(logs 읽기 전): 30분부터 두 배씩, 최대 6시간 */
export const LIGHT_BASE_MS = 30 * MINUTE;
export const LIGHT_MAX_MS = 6 * HOUR;
/** 무거운 실패(logs 읽기를 시작한 뒤): 1시간부터 두 배씩, 최대 12시간 */
export const HEAVY_BASE_MS = HOUR;
export const HEAVY_MAX_MS = 12 * HOUR;
/** 한 페이지 이상 합쳐 저장했을 때의 다음 시도 간격 */
export const PROGRESS_RETRY_MS = 5 * MINUTE;

/** `failureCount`번째(1부터) 실패 뒤의 대기 시간 */
export const failureDelayMs = (weight: FailureWeight, failureCount: number): number => {
  const base = weight === 'heavy' ? HEAVY_BASE_MS : LIGHT_BASE_MS;
  const max = weight === 'heavy' ? HEAVY_MAX_MS : LIGHT_MAX_MS;
  const exponent = Math.max(0, Math.floor(failureCount) - 1);
  // 지수가 커도 넘치지 않도록 먼저 상한을 확인합니다.
  if (exponent >= 20) return max;
  return Math.min(max, base * 2 ** exponent);
};

const nthSundayOfMonth = (year: number, monthIndex: number, nth: number): number => {
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((7 - firstWeekday) % 7) + 7 * (nth - 1);
};

/** 미국 서머타임: 3월 둘째 일요일 02:00(PST)부터 11월 첫째 일요일 02:00(PDT) 전까지 */
const pacificOffsetMs = (utcMs: number): number => {
  const year = new Date(utcMs - 8 * HOUR).getUTCFullYear();
  const start = Date.UTC(year, 2, nthSundayOfMonth(year, 2, 2), 10);
  const end = Date.UTC(year, 10, nthSundayOfMonth(year, 10, 1), 9);
  return (utcMs >= start && utcMs < end ? -7 : -8) * HOUR;
};

/** 자정 직후의 시계 오차를 피하려는 여유 */
export const PACIFIC_MIDNIGHT_MARGIN_MS = MINUTE;

/** 다음 태평양 시간 자정 + 1분(밀리초). Firestore 일일 할당량이 이 시각에 새로 시작합니다. */
export const nextPacificMidnight = (nowMs: number): number => {
  const offsetNow = pacificOffsetMs(nowMs);
  const nextLocalMidnight = (Math.floor((nowMs + offsetNow) / DAY) + 1) * DAY;
  const offsetThen = pacificOffsetMs(nextLocalMidnight - offsetNow);
  return nextLocalMidnight - offsetThen + PACIFIC_MIDNIGHT_MARGIN_MS;
};

export interface FailureScheduleInput {
  now: number;
  previousFailureCount?: number;
  weight: FailureWeight;
  /** 이번 시도에서 한 페이지 이상 합쳐 저장했음 */
  progressed?: boolean;
  /** `resource-exhausted` */
  quotaExhausted?: boolean;
}

export interface FailureSchedule {
  failureCount: number;
  nextFirestoreAttemptAt: number;
}

/**
 * Firestore 읽기 실패 뒤의 다음 시도 시각. 할당량 소진은 태평양 시간 자정 뒤로 미루고, 진척이 있으면
 * 실패 횟수를 0으로 되돌리고 5분 뒤로 두며, 그 밖에는 가벼운/무거운 간격을 두 배씩 늘립니다.
 */
export const nextFailureSchedule = (input: FailureScheduleInput): FailureSchedule => {
  const previous = Math.max(0, Math.floor(input.previousFailureCount ?? 0));
  if (input.quotaExhausted) {
    return { failureCount: previous + 1, nextFirestoreAttemptAt: nextPacificMidnight(input.now) };
  }
  if (input.progressed) {
    return { failureCount: 0, nextFirestoreAttemptAt: input.now + PROGRESS_RETRY_MS };
  }
  const failureCount = previous + 1;
  return { failureCount, nextFirestoreAttemptAt: input.now + failureDelayMs(input.weight, failureCount) };
};

/**
 * 실패 간격 안이라 이번에는 Firestore를 읽지 않는가. `ignoreBackoff`는 사용자가 방금 예약을 취소하는 따위로 곧바로
 * 다시 판정해야 하는 재실행에서만 참입니다. 병합을 마친 키(`mergeSource: 'ok'`)의 가족 문서 다시 읽기도 같은
 * 간격을 지킵니다(저장, 앱 복귀, 새로고침마다 `ensure`가 불리므로 간격이 없으면 그때마다 읽습니다).
 */
export const isFirestoreReadDeferred = (input: {
  now: number;
  nextFirestoreAttemptAt?: number;
  ignoreBackoff?: boolean;
}): boolean =>
  !input.ignoreBackoff
  && typeof input.nextFirestoreAttemptAt === 'number'
  && input.nextFirestoreAttemptAt > input.now;

export const DEFAULT_PAGE_SIZE = 500;
export const MIN_PAGE_SIZE = 50;

/** 페이지 상한(15초)에 걸린 뒤 다음 시도의 페이지 크기: 절반, 하한 50건 */
export const nextPageSize = (current: number): number =>
  Math.max(MIN_PAGE_SIZE, Math.floor(current / 2));

// ────────────── 거부와 종료 (07 2.5) ──────────────

/** 안내를 "다시 확인해 주세요"로 바꾸는 기간 */
export const BLOCKED_NOTICE_AFTER_MS = 7 * DAY;
/** D1이 exists인 가족에서 거부·예약·가족 문서 없음이 이어지면 Firestore 읽기를 멈추는 기간 */
export const GIVE_UP_AFTER_MS = 14 * DAY;

export const isBlockedLong = (input: { now: number; blockedSince?: number }): boolean =>
  typeof input.blockedSince === 'number' && input.now - input.blockedSince > BLOCKED_NOTICE_AFTER_MS;

/** D1이 missing인 가족은 멈추지 않습니다(멈추면 이어받을 길이 없습니다). */
export const shouldGiveUpFirestoreRead = (input: {
  d1Status?: D1Status;
  now: number;
  blockedSince?: number;
}): boolean =>
  input.d1Status === 'exists'
  && typeof input.blockedSince === 'number'
  && input.now - input.blockedSince > GIVE_UP_AFTER_MS;

// ────────────── 결정표 (07 2.4-6) ──────────────

/** 2.4-3~5를 마친 뒤의 Firestore 쪽 상태 */
export type FirestoreState =
  /** 읽을 필요가 없어 읽지 않았음(근거 없음) */
  | 'unread'
  /** `nextFirestoreAttemptAt` 전이라 읽지 않았음 */
  | 'not_due'
  /** 이번 시도에서 읽어 합쳤음(firestore_ok) */
  | 'merged_now'
  /** 이전 시도에서 읽어 합쳤음(`mergeSource: 'ok'`) */
  | 'merged_before_ok'
  /** `mergeSource: 'skipped'` */
  | 'merged_before_skipped'
  | 'denied'
  | 'absent'
  | 'pending_deletion'
  | 'error';

export type FamilyAction =
  /** 이전을 멈춘다(410) */
  | 'stop_deleted'
  /** 7번(D1 전체 업로드)으로 */
  | 'upload'
  /** 7번으로 가되 예약 값이 다르면 선택 화면(2.6.3과 같음) */
  | 'upload_with_prompt'
  /** `connectFamily(allowCreate=true)`로 이어받고 7번 */
  | 'adopt'
  /** 가족 문서를 다시 읽어 이어받기 여부 결정 */
  | 'recheck_then_adopt'
  /** 서버 이상: 오류만 보이고 이어받지 않음 */
  | 'server_anomaly'
  /** 2.4.1 선택 화면 */
  | 'choose_pending_deletion'
  /** 2.5 */
  | 'denied'
  | 'absent'
  /** 실패로 끝내고 연결은 유지 */
  | 'fail';

/** 2.4-6 결정표를 그대로 옮긴 판정입니다. */
export const decideFamilyAction = (input: { d1: D1Status; firestore: FirestoreState }): FamilyAction => {
  if (input.d1 === 'deleted') return 'stop_deleted';
  if (input.d1 === 'exists') {
    return input.firestore === 'pending_deletion' ? 'upload_with_prompt' : 'upload';
  }
  switch (input.firestore) {
    case 'merged_now': return 'adopt';
    case 'merged_before_ok': return 'recheck_then_adopt';
    case 'merged_before_skipped': return 'server_anomaly';
    case 'pending_deletion': return 'choose_pending_deletion';
    case 'denied': return 'denied';
    case 'absent': return 'absent';
    default: return 'fail';
  }
};

/**
 * 1.7.9 삭제 예약 안내를 보일지(2.2 `promptedPendingDeletionAt`). 화면에 보일 예약 값이 이미 물어본 값과
 * 같으면 다시 묻지 않습니다. 예약 값이 없으면(null) 물을 일이 없습니다.
 */
export const shouldPromptPendingDeletion = (input: {
  pendingDeletionAt: number | null | undefined;
  promptedPendingDeletionAt?: number;
}): boolean =>
  typeof input.pendingDeletionAt === 'number' && input.pendingDeletionAt !== input.promptedPendingDeletionAt;

// ────────────── 전환기 (07 2.6) ──────────────

export const TRANSITION_INTERVAL_MS = 5 * MINUTE;
export const TRANSITION_SLOW_INTERVAL_MS = 30 * MINUTE;
export const TRANSITION_SLOW_AFTER_MS = 14 * DAY;
export const TRANSITION_MAX_MS = 30 * DAY;
export const PARTNER_GRACE_MS = 24 * HOUR;

export type TransitionEndReason = 'max_duration' | 'partner_grace';

export interface TransitionDecision {
  ended: boolean;
  reason?: TransitionEndReason;
  /** 가족 문서를 읽는 최소 간격 */
  intervalMs: number;
}

/**
 * 시작은 `mergedAt`입니다. 30일이 지나면 무조건 끝나고, 상대를 처음 본(`partnerSeenAt`) 때부터 24시간이 지나면
 * 끝납니다. 14일이 지나거나 상대를 본 뒤에는 간격이 30분입니다.
 */
export const decideTransition = (input: {
  now: number;
  mergedAt: number;
  partnerSeenAt?: number;
}): TransitionDecision => {
  const sinceMerged = input.now - input.mergedAt;
  const slow = sinceMerged >= TRANSITION_SLOW_AFTER_MS || typeof input.partnerSeenAt === 'number';
  const intervalMs = slow ? TRANSITION_SLOW_INTERVAL_MS : TRANSITION_INTERVAL_MS;
  if (sinceMerged >= TRANSITION_MAX_MS) return { ended: true, reason: 'max_duration', intervalMs };
  if (typeof input.partnerSeenAt === 'number' && input.now - input.partnerSeenAt >= PARTNER_GRACE_MS) {
    return { ended: true, reason: 'partner_grace', intervalMs };
  }
  return { ended: false, intervalMs };
};

/** `otherMembers`가 1 이상일 때만 상대를 본 것입니다(자기 자신은 서버가 뺍니다). */
export const isPartnerSeen = (otherMembers: unknown): boolean =>
  typeof otherMembers === 'number' && Number.isFinite(otherMembers) && otherMembers >= 1;

/** 전환기 읽기를 이번에 해도 되는지: 마지막 읽기로부터 간격이 지났거나 처음입니다. */
export const isTransitionReadDue = (input: { now: number; lastReadAt?: number; intervalMs: number }): boolean =>
  input.lastReadAt === undefined || input.now - input.lastReadAt >= input.intervalMs;

// ────────────── D1 업로드 완료 판정 (07 2.3 "d1UploadedAt 판정") ──────────────

/**
 * 이 키의 `succeeded` 사건 가운데 요청 번호가 7단계 요청 번호 이상이고, `continuing`이 거짓이며, 장부에
 * `full`이 없는 첫 사건에서 `d1UploadedAt`을 적습니다. 7단계보다 먼저 시작한 회차는 번호가 작아 걸러집니다.
 */
export const shouldMarkD1Uploaded = (input: {
  eventRequestId: number;
  uploadRequestId: number | undefined;
  continuing: boolean | undefined;
  /** 장부를 읽을 수 없으면 undefined(적지 않고 다음 사건을 기다립니다) */
  ledgerHasFull: boolean | undefined;
}): boolean =>
  input.uploadRequestId !== undefined
  && input.eventRequestId >= input.uploadRequestId
  && !input.continuing
  && input.ledgerHasFull === false;
