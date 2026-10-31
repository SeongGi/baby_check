// 동기화 결과를 "무엇을 할지"로 바꾸는 순수 함수 모음입니다. 이 파일은 저장소나
// 네트워크를 건드리지 않으므로 하네스가 그대로 불러 단위 검사할 수 있습니다.

// 아래 문구는 06 설계(2.6.2, 2.7)의 원문 그대로라서 종결 반복을 고치지 않았습니다.
export const NOT_FOUND_MESSAGE = '서버에서 가족 정보를 찾지 못했습니다. 기록은 이 기기에 그대로 있습니다.';
export const JOIN_NOT_FOUND_MESSAGE = '초대 정보를 찾지 못했습니다. 초대 링크를 다시 받아 주세요.';
export const GONE_MESSAGE = '이 가족 공유는 영구 삭제되었습니다.';
export const GONE_JOIN_MESSAGE = '이 가족 공유는 영구 삭제되었습니다. 새 초대 링크를 받아 주세요.';
export const DISCONNECTED_MESSAGE = '가족 데이터가 삭제되어 연결이 해제되었습니다.';
export const UPLOAD_STALLED_MESSAGE = '일부 기록을 올리지 못했습니다. 다음 동기화 때 다시 시도합니다.';
export const PULL_TOO_SLOW_MESSAGE = '네트워크가 느려 기록을 받지 못했습니다. 와이파이에서 다시 시도해 주세요.';
export const OVERSIZED_MESSAGE = '공유하지 못한 기록이 있습니다(너무 큼)';
export const DEFAULT_ERROR_MESSAGE = '서버에 연결하지 못했습니다.';

// ────────────── 공유 아기 정보 검사 (2.6.1) ──────────────

export interface CompleteSharedProfile {
  name: string;
  birthDate: string;
  birthWeight: string;
  targetFormula: number;
}

/** 공유 항목 4개가 모두 있고 형식이 서버의 검사와 같을 때만 참입니다. */
export const isCompleteSharedProfile = (value: unknown): value is CompleteSharedProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string'
    && typeof v.birthDate === 'string'
    && typeof v.birthWeight === 'string'
    && typeof v.targetFormula === 'number'
    && Number.isFinite(v.targetFormula);
};

// ────────────── 요청 크기 조절 (2.6.2) ──────────────

export type FailureKind =
  | 'tooLarge'
  | 'serverError'
  | 'timeout'
  | 'network'
  | 'notFound'
  | 'gone'
  | 'clientError';

export type RequestStage = 'pull' | 'push';

export type NextStep = 'endRound' | 'skipPull' | 'skipPush' | 'skipPushAndIncremental';

/** 요청 실패를 2.6.2 표의 실패 종류로 나눕니다. 상태 코드가 없으면 네트워크 끊김으로 봅니다. */
export const classifyFailure = (error: unknown): FailureKind => {
  const e = error as { status?: unknown; isTimeout?: unknown } | null | undefined;
  if (e?.isTimeout) return 'timeout';
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 404) return 'notFound';
  if (status === 410) return 'gone';
  if (status === 413) return 'tooLarge';
  if (status !== undefined && status >= 500) return 'serverError';
  if (status !== undefined && status >= 400) return 'clientError';
  return 'network';
};

/** 2.6.2 표: 실패한 단계와 종류에 따라 같은 회차의 다음 단계를 정합니다. */
export const nextStepAfterFailure = (stage: RequestStage, failure: FailureKind): NextStep => {
  switch (failure) {
    case 'network':
    case 'notFound':
    case 'gone':
      return 'endRound';
    case 'tooLarge':
    case 'serverError':
    case 'timeout':
      return stage === 'pull' ? 'skipPull' : 'skipPushAndIncremental';
    case 'clientError':
    default:
      return stage === 'pull' ? 'skipPull' : 'skipPush';
  }
};

export interface SyncLimits {
  push: number;
  pull: number;
  pushStreak: number;
  pullStreak: number;
  serverPush?: number;
  serverPull?: number;
}

export const DEFAULT_PUSH_LIMIT = 400;
export const DEFAULT_PULL_LIMIT = 500;
export const MIN_LIMIT = 25;
export const GROW_AFTER_SUCCESSES = 10;

export const defaultLimits = (): SyncLimits => ({
  push: DEFAULT_PUSH_LIMIT,
  pull: DEFAULT_PULL_LIMIT,
  pushStreak: 0,
  pullStreak: 0,
});

export type LimitOutcome =
  | { kind: RequestStage; result: 'success'; hints?: { maxPushItems?: unknown; maxPageRows?: unknown } }
  | { kind: RequestStage; result: 'failure'; failure: FailureKind };

const validHint = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;

/** 실제로 쓰는 크기: min(장부 값, 서버 힌트), 하한 25. */
export const effectiveLimit = (limits: SyncLimits | undefined, kind: RequestStage): number => {
  const base = limits ?? defaultLimits();
  const stored = kind === 'push' ? base.push : base.pull;
  const hint = kind === 'push' ? base.serverPush : base.serverPull;
  return Math.max(MIN_LIMIT, Math.min(stored, hint ?? stored));
};

/** 요청 결과를 반영한 새 크기 설정입니다. 입력을 바꾸지 않습니다. */
export const nextLimits = (limits: SyncLimits | undefined, outcome: LimitOutcome): SyncLimits => {
  const next: SyncLimits = { ...(limits ?? defaultLimits()) };
  const isPush = outcome.kind === 'push';

  if (outcome.result === 'success') {
    const pushHint = validHint(outcome.hints?.maxPushItems);
    const pullHint = validHint(outcome.hints?.maxPageRows);
    if (pushHint !== undefined) next.serverPush = pushHint;
    if (pullHint !== undefined) next.serverPull = pullHint;
    const streak = (isPush ? next.pushStreak : next.pullStreak) + 1;
    if (streak >= GROW_AFTER_SUCCESSES) {
      const stored = isPush ? next.push : next.pull;
      const ceiling = isPush ? DEFAULT_PUSH_LIMIT : DEFAULT_PULL_LIMIT;
      const hint = isPush ? next.serverPush : next.serverPull;
      const grown = Math.max(MIN_LIMIT, Math.min(stored * 2, ceiling, hint ?? ceiling));
      if (isPush) { next.push = grown; next.pushStreak = 0; } else { next.pull = grown; next.pullStreak = 0; }
    } else if (isPush) next.pushStreak = streak;
    else next.pullStreak = streak;
    return next;
  }

  // 실패는 연속 성공을 끊습니다. 크기를 줄이는 것은 요청이 너무 크다는 신호뿐입니다.
  const shrinks = outcome.failure === 'tooLarge'
    || outcome.failure === 'serverError'
    || outcome.failure === 'timeout';
  if (isPush) {
    if (shrinks) next.push = Math.max(MIN_LIMIT, Math.floor(effectiveLimit(limits, 'push') / 2));
    next.pushStreak = 0;
  } else {
    if (shrinks) next.pull = Math.max(MIN_LIMIT, Math.floor(effectiveLimit(limits, 'pull') / 2));
    next.pullStreak = 0;
  }
  return next;
};

// ────────────── 동기화 결과 → 할 일 (2.6.3, 2.7) ──────────────

export interface SyncResultLike {
  success: boolean;
  error?: string;
  familyUnavailable?: boolean;
  familyNotFound?: boolean;
  continuing?: boolean;
  progressed?: boolean;
  uploadStalled?: boolean;
  pullTooSlow?: boolean;
  oversizedIds?: string[];
}

export interface AfterSyncContext {
  /** 가족 만들기나 합류 회차인지 */
  connecting: boolean;
  /** 20초 상한이 먼저 와서 대체 결과를 받았는지 */
  timedOut: boolean;
  /** 러너가 저장소에서 읽은, 저장된 키가 이 회차의 키와 같은지 */
  storedKeyMatches: boolean;
}

export type AfterSyncDecision =
  | { action: 'disconnect'; error: string }
  | { action: 'success'; continueSync: boolean; recovered: boolean; notice?: string }
  | { action: 'failure'; error: string };

export const decideAfterSync = (result: SyncResultLike, context: AfterSyncContext): AfterSyncDecision => {
  // 410은 앱이 스스로 연결을 끊는 유일한 근거입니다. 합류·만들기 중에는 키를 남기지 않고 실패로 돌려줍니다.
  if (result.familyUnavailable) {
    return context.connecting
      ? { action: 'failure', error: GONE_JOIN_MESSAGE }
      : { action: 'disconnect', error: DISCONNECTED_MESSAGE };
  }
  // 404는 서버 설정 오류에서도 나오므로 오류만 보여 주고 연결은 유지합니다.
  if (result.familyNotFound) {
    return { action: 'failure', error: context.connecting ? JOIN_NOT_FOUND_MESSAGE : NOT_FOUND_MESSAGE };
  }
  // 첫 저장으로 키가 이미 저장소에 있다면 상한이나 다른 요청의 실패와 상관없이 연결은 확정입니다.
  if (context.connecting && (!result.success || context.timedOut) && context.storedKeyMatches) {
    return { action: 'success', continueSync: true, recovered: true };
  }
  if (result.success) {
    return {
      action: 'success',
      continueSync: result.continuing === true && result.progressed === true,
      recovered: false,
      notice: result.oversizedIds && result.oversizedIds.length > 0 ? OVERSIZED_MESSAGE : undefined,
    };
  }
  const error = result.pullTooSlow
    ? PULL_TOO_SLOW_MESSAGE
    : result.uploadStalled
      ? UPLOAD_STALLED_MESSAGE
      : result.error || DEFAULT_ERROR_MESSAGE;
  return { action: 'failure', error };
};

// ────────────── 변경 토큰 폴링 오류 → 할 일 (2.7) ──────────────

export type AfterTokenErrorDecision = { action: 'syncNow' } | { action: 'reconnect' };

/** 410이면 폴링을 멈추고 평소 동기화를 한 번 요청하고, 그 밖에는 재연결 간격을 두고 다시 붙습니다. */
export const decideAfterTokenError = (error: unknown): AfterTokenErrorDecision =>
  (error as { status?: unknown } | null | undefined)?.status === 410
    ? { action: 'syncNow' }
    : { action: 'reconnect' };
