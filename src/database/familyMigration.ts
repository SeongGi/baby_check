// 기존 사용자 이전 모듈(07 2.3~2.9): 1.7.9(Firestore) 가족을 1.8.0(Cloudflare D1)으로 옮깁니다.
// 러너(syncRunner.ts)처럼 `react`, `react-native`, `expo-*`를 불러오지 않습니다. 저장소, D1 요청, Firestore 읽기,
// 러너, 시계, 화면 콜백은 모두 인자(deps)로 받으므로 하네스가 실제 코드를 그대로 실행합니다.
//
// 불변 조건(07 0장)
// - 기록은 합치기만 합니다. 이 모듈은 기기 기록을 지우는 코드를 갖지 않습니다.
// - Firestore에는 회원 문서 생성과 삭제 예약 취소(`pendingDeletionAt: null`)만 씁니다. 그것도 firestoreImport.ts의
//   함수로만 하고, Firestore 문서를 지우는 코드는 이 파일에 없습니다.
// - 앱이 스스로 연결을 끊는 것은 D1의 410(러너 처리)과 사용자가 고른 "삭제에 따르기"뿐입니다.
// - `firestoreImport.ts`와 `firebase.ts`는 동적 import()로만 불러옵니다(혼자 쓰는 기기와 1.8.0 신규 가족은 불러오지 않음).
import type { SyncRequest, SyncRunResult, SyncRunnerEvent } from './syncRunner';
import type { MigrationState } from './storage';
import { JOIN_NOT_FOUND_MESSAGE, NOT_FOUND_MESSAGE } from './syncDecision';
import {
  decideFamilyAction,
  decideMigrationGate,
  decideTransition,
  DEFAULT_PAGE_SIZE,
  hasLegacyEvidence,
  isBlockedLong,
  isFirestoreReadDeferred,
  isMigrationComplete,
  isPartnerSeen,
  isTransitionReadDue,
  nextFailureSchedule,
  nextPageSize,
  shouldGiveUpFirestoreRead,
  shouldMarkD1Uploaded,
  shouldPromptPendingDeletion,
} from './migrationDecision';
import type { D1Status, FamilyAction, FirestoreState, MigrationGate } from './migrationDecision';

// ────────────── 의존성 ──────────────

type StorageModule = typeof import('./storage');
type CloudClientModule = typeof import('./cloudClient');
type FirestoreImportModule = typeof import('./firestoreImport');

export type MigratorStorage = Pick<
  StorageModule,
  | 'getLegacyKeyMarker'
  | 'getMigrationState'
  | 'updateMigrationState'
  | 'getTransitionState'
  | 'updateTransitionState'
  | 'ensurePreMigrationBackup'
  | 'markPreMigrationBackupSkipped'
  | 'mergeLegacyFirestoreData'
  | 'getProfile'
  | 'saveProfile'
  | 'readSyncLedger'
>;

export type MigratorCloud = Pick<
  CloudClientModule,
  'connectFamily' | 'deleteFamilyData' | 'getSyncToken' | 'scheduleFamilyDeletion'
>;

export type MigratorFirestore = Pick<
  FirestoreImportModule,
  | 'ensureFirestoreMembership'
  | 'readLegacyFamilyDoc'
  | 'readLegacyLogsPage'
  | 'readLegacyLogsUpdatedSince'
  | 'readLegacySharedProfile'
  | 'cancelLegacyDeletion'
  | 'withFirestoreLock'
  | 'withFirestoreTimeout'
  | 'classifyFirestoreError'
>;

export interface MigratorRunner {
  request(request: SyncRequest, options?: { onAccepted?(requestId: number): void }): Promise<SyncRunResult>;
  subscribe(listener: (event: SyncRunnerEvent) => void): () => void;
}

/** 1.7.9 삭제 예약 선택 화면(2.4.1, 2.4-6, 2.6.3, 2.4.1 끝의 합류용)의 답 */
export type LegacyDeletionChoice = 'cancelRequest' | 'followDeletion' | 'later' | 'cancelJoin';

export interface LegacyDeletionPrompt {
  /**
   * missing: D1에 가족이 없음(2.4.1), exists: D1에 가족이 있음(2.4-6), transition: 전환기(2.6.3),
   * joining: 합류 도중(키 미저장, 2.4.1 끝)
   */
  context: 'missing' | 'exists' | 'transition' | 'joining';
  /** 화면에 보일 예약 값(밀리초) */
  pendingDeletionAt: number;
  /** 보여 줄 선택지. 합류 중에는 `cancelRequest`와 `cancelJoin` 둘뿐입니다. */
  options: LegacyDeletionChoice[];
}

export interface MigratorNotice {
  level: 'info' | 'error';
  /** 하네스가 판정하기 쉬운 안정적인 이름 */
  code: string;
  message: string;
}

export interface FamilyMigratorDeps {
  storage: MigratorStorage;
  cloud: MigratorCloud;
  getClientId(): Promise<string>;
  /** 러너 만들기 전에 이전 모듈을 만들 수 있도록 함수로 받습니다(러너의 관문이 이 모듈을 부릅니다). */
  getRunner(): MigratorRunner;
  /** 없으면 `import('./firestoreImport')`입니다. 하네스는 가짜 Firestore 모듈을 돌려줍니다. */
  loadFirestore?: () => Promise<MigratorFirestore>;
  /** 백업 저장이 실패했을 때: 'continue'는 "백업 없이 계속", 'later'는 이전을 멈춘 채 둡니다. 앱을 다시 열 때 한 번 더 묻습니다. */
  askBackupFailure(): Promise<'continue' | 'later'>;
  askLegacyDeletionChoice(prompt: LegacyDeletionPrompt): Promise<LegacyDeletionChoice>;
  notify(notice: MigratorNotice): void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Firestore 부분의 전체 예산(기본 90초) */
  firestoreBudgetMs?: number;
  /** Firestore 호출 하나의 상한(기본 15초) */
  firestoreCallTimeoutMs?: number;
}

// ────────────── 결과와 사건 ──────────────

export type EnsureStatus =
  | 'complete'
  | 'not_connected'
  | 'superseded'
  | 'backup_pending'
  | 'deleted'
  | 'key_format'
  | 'd1_error'
  | 'uploading'
  | 'waiting'
  | 'firestore_failed'
  | 'firestore_denied'
  | 'firestore_absent'
  | 'pending_deletion'
  | 'server_anomaly'
  | 'deletion_followed';

export interface EnsureResult {
  status: EnsureStatus;
  message?: string;
}

export interface JoinResult {
  outcome: 'joined' | 'not_found' | 'deleted' | 'pending_deletion_choice' | 'cancelled' | 'failed';
  message?: string;
  /** 연결 회차의 결과. App은 success나 merged일 때 기록과 프로필을 화면에 반영합니다. */
  syncResult?: SyncRunResult;
  /** 근거가 있는 합류는 2.4가 시작됩니다. 기다려도 되고 기다리지 않아도 됩니다. */
  migration?: Promise<EnsureResult>;
}

export type TransitionTickStatus =
  | 'none'
  | 'ended'
  | 'paused'
  | 'throttled'
  | 'backoff'
  | 'unchanged'
  | 'merged'
  | 'failed'
  | 'superseded';

export interface TransitionTickResult {
  status: TransitionTickStatus;
  reason?: string;
  message?: string;
}

export type MigratorEvent =
  /** 기록이나 프로필을 기기에 합쳐 저장했습니다. App은 저장소에서 다시 읽어 화면에 반영합니다. */
  | { type: 'merged'; syncKey: string }
  /** `d1Status`가 바뀌었습니다. App은 `peekGate`로 다시 판정해 폴링을 시작합니다(`shouldStartPolling`). */
  | { type: 'gateChanged'; syncKey: string }
  /** 이전이 끝났습니다(`d1UploadedAt` 기록). */
  | { type: 'completed'; syncKey: string }
  /** "삭제에 따르기"로 이 기기의 연결을 해제했습니다. 기록은 남아 있습니다. */
  | { type: 'disconnected'; syncKey: string };

export interface MigratorSummary {
  gate: MigrationGate;
  complete: boolean;
  d1Status?: D1Status;
  mergeSource?: 'ok' | 'skipped';
  lastError?: string;
  state: MigrationState;
}

export interface FamilyMigrator {
  /** 2.4 이전 단계. 같은 키가 돌고 있으면 같은 Promise입니다. 7단계 요청을 러너에 넣는 데서 끝납니다. */
  ensure(syncKey: string): Promise<EnsureResult>;
  /** 합류와 가족 만들기의 전체 흐름(2.9). App과 설정 화면은 이 함수만 부릅니다. */
  joinFamily(key: string, options?: { allowFamilyCreation?: boolean; createBackup?: boolean }): Promise<JoinResult>;
  /** 합류 회차가 404로 끝났을 때의 1.7.9 가족 합류(2.9). `joinFamily`가 부르지만 하네스가 직접 부를 수도 있습니다. */
  legacyJoin(key: string, options?: { createBackup?: boolean }): Promise<JoinResult>;
  /** 전환기 읽기 한 번(2.6). 평소 동기화가 끝난 뒤 부릅니다. `force`는 5분 간격만 건너뜁니다(실패 간격은 지킵니다). */
  transitionTick(syncKey: string, options?: { force?: boolean }): Promise<TransitionTickResult>;
  /** 러너의 `migrationGate`에 꽂을 함수. `'paused'`이면 `ensure`를 기다리지 않고 부릅니다. */
  migrationGate(syncKey: string): Promise<MigrationGate>;
  /** `ensure`를 부르지 않고 관문 판정만 합니다(폴링 시작, 설정 화면의 삭제 상태 확인 판정용). */
  peekGate(syncKey: string): Promise<MigrationGate>;
  getD1Status(syncKey: string): D1Status | undefined;
  /** 설정 화면과 오류 표시용 요약 */
  getSummary(syncKey: string): Promise<MigratorSummary>;
  subscribe(listener: (event: MigratorEvent) => void): () => void;
  /** 타이머와 러너 구독을 정리합니다. */
  dispose(): void;
}

// ────────────── 문구 ──────────────

export const MIGRATION_MESSAGES = {
  backupFailed: '기기 저장 공간이 부족해 업데이트 전 백업을 만들지 못했습니다.',
  keyFormat: '가족 연결 키 형식을 새 서버가 받지 못합니다.',
  deniedNoEvidence: '가족 연결을 확인할 수 없습니다. 초대 링크를 다시 받아 주세요.',
  deniedLong: '가족 연결을 다시 확인해 주세요. 기록은 이 기기에 그대로 있습니다.',
  absent: '가족 정보를 찾지 못했습니다.',
  firestoreError: '이전 서버에서 기록을 가져오지 못했습니다. 잠시 뒤 다시 시도합니다.',
  gaveUp: '이전 서버의 기록을 가져오지 못했습니다.',
  transitionStarted: '새 버전부터 동기화 서버가 바뀌었습니다. 가족 모두 1.8.0으로 업데이트해야 서로의 새 기록이 보입니다.',
  deletionCancelledElsewhere: '다른 기기에서 삭제 요청을 취소했습니다.',
  deletionRecheckFailed: '이전 서버에서 삭제 요청을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  alreadyMigrated: '다른 기기가 이미 새 서버로 옮겼습니다.',
  deletionFollowed: '삭제 요청에 따라 이 기기의 가족 연결을 해제했습니다. 이 기기의 기록은 지우지 않았고, 이전 서버(Firebase)에 남은 예전 사본은 운영자가 따로 삭제합니다.',
  deletionScheduled: '가족 서버 데이터 삭제를 예약했습니다. 이전 서버(Firebase)에 남은 예전 사본은 운영자가 따로 삭제합니다.',
  deletionActionFailed: '삭제 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  cancelRequestFailed: '이전 서버의 삭제 요청을 취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  legacyJoinChecking: '이전 서버에서 가족 정보를 확인하는 중입니다.',
  legacyJoinFailed: '이전 서버에서 가족 정보를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  joinDeleted: '이 가족은 삭제되었습니다.',
  joinCancelled: '가족 합류를 취소했습니다.',
} as const;

const defaultLoadFirestore = (): Promise<MigratorFirestore> => import('./firestoreImport');

// ────────────── 내부 타입 ──────────────

type MigrationPatch = Parameters<MigratorStorage['updateMigrationState']>[1];

interface Run {
  key: string;
}

type PromptContext = LegacyDeletionPrompt['context'];

type PromptOutcome =
  | 'cancelled'      // 예약을 취소했음(Firestore에 null을 씀) → 2.4를 다시 실행
  | 'followed'       // 삭제에 따랐음
  | 'conflict'       // 409: 그 사이 D1 가족이 생김 → 2.4를 다시 실행
  | 'withdrawn'      // 상대가 취소했음 → 2.4를 다시 실행
  | 'later'
  | 'cancel_join'
  | 'invalid_choice'
  | 'failed';

interface FirestoreReadOutcome {
  state: 'ok' | 'denied' | 'absent' | 'pending_deletion' | 'error' | 'superseded';
  /** 한 페이지 이상 합쳐 저장했음 */
  progressed: boolean;
  /** logs 읽기를 시작한 뒤의 실패인가 */
  heavy: boolean;
  quota: boolean;
  /** logs 페이지 읽기가 상한(15초)에 걸림 */
  pageTimedOut: boolean;
  pendingDeletionAt?: number;
  invalidCount: number;
  errorMessage?: string;
}

type DocRecheck =
  | { kind: 'ok'; pendingDeletionAt: number | null; lastChangedAt: number }
  | { kind: 'denied' }
  | { kind: 'absent' }
  /** `quota`: 할당량 소진(`resource-exhausted`). 실패 간격이 태평양 시간 자정 뒤로 밀립니다. */
  | { kind: 'error'; quota?: boolean };

const MAX_RERUNS = 3;
const MAX_REPROMPTS = 3;

const errorStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createFamilyMigrator(deps: FamilyMigratorDeps): FamilyMigrator {
  const { storage, cloud } = deps;
  const clock = (): number => (deps.now ? deps.now() : Date.now());
  const budgetMs = deps.firestoreBudgetMs ?? 90_000;
  const callTimeoutMs = deps.firestoreCallTimeoutMs ?? 15_000;
  const startTimer = deps.setTimer ?? ((callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    // 앱이 떠 있는 동안만 의미가 있는 타이머라 프로세스를 붙잡지 않습니다(하네스의 Node).
    (handle as { unref?: () => void }).unref?.();
    return handle;
  });
  const stopTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // ── 메모리 상태 ──
  const d1StatusByKey = new Map<string, D1Status>();
  // 앱 코드에는 삭제 호출 문자열을 두지 않습니다(불변 조건 점검이 grep으로 찾습니다). 비울 때는 undefined를 적습니다.
  const uploadRequestIds: Record<string, number | undefined> = {};
  // 7단계 요청이 끝맺지 못했음(실패, 키 불일치로 버려짐 등)을 표시합니다. 번호는 남겨 두어 뒤의 평소 요청이 업로드를
  // 마치면 완료로 적고, 다음 ensure는 이 표시가 있을 때만 7단계를 다시 넣습니다(표시가 없으면 아직 진행 중이라 쌓지 않음).
  const uploadAbandoned: Record<string, true | undefined> = {};
  const pageSizes = new Map<string, number>();
  const retryTimers: Record<string, unknown> = {};
  const lastTransitionReadAt = new Map<string, number>();
  const deferredPrompts = new Set<string>();
  const ticksInFlight: Record<string, Promise<TransitionTickResult> | undefined> = {};
  // 전환기 읽기에서 회원 확인을 마친 키입니다. 프로세스 메모리에만 두므로 앱을 다시 켜면 한 번 더 확인합니다.
  const transitionMembershipConfirmed: Record<string, true | undefined> = {};
  const legacyJoinsInFlight: Record<string, Promise<JoinResult> | undefined> = {};
  let listeners: Array<(event: MigratorEvent) => void> = [];
  let backupDeclinedThisSession = false;
  let active: { run: Run; promise: Promise<EnsureResult> } | null = null;
  let firestorePromise: Promise<MigratorFirestore> | null = null;
  let runnerUnsubscribe: (() => void) | null = null;
  let subscribedRunner: MigratorRunner | null = null;

  const emit = (event: MigratorEvent): void => {
    listeners.slice().forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error('[familyMigration] 사건 구독자에서 오류가 났습니다.', error);
      }
    });
  };

  const notify = (level: MigratorNotice['level'], code: string, message: string): void => {
    try {
      deps.notify({ level, code, message });
    } catch (error) {
      console.error('[familyMigration] 안내 콜백에서 오류가 났습니다.', error);
    }
  };

  const normalizeKey = (syncKey: string): string => syncKey.trim();
  const isCurrent = (run: Run): boolean => active?.run === run;

  const setD1Status = (key: string, status: D1Status): void => {
    if (d1StatusByKey.get(key) === status) return;
    d1StatusByKey.set(key, status);
    emit({ type: 'gateChanged', syncKey: key });
  };

  const loadFirestore = (): Promise<MigratorFirestore> => {
    if (!firestorePromise) {
      firestorePromise = (deps.loadFirestore ?? defaultLoadFirestore)().catch(error => {
        firestorePromise = null;
        throw error;
      });
    }
    return firestorePromise;
  };

  // ── 러너 사건 구독: d1UploadedAt 판정(2.3) ──

  const markUploaded = async (key: string, eventRequestId: number, uploadId: number): Promise<void> => {
    try {
      const ledger = await storage.readSyncLedger(key);
      // 사건을 받은 뒤 장부를 읽는 사이에 7단계 번호가 바뀌었으면(병합 뒤 다시 올림 등) 이 사건은 옛 업로드의 것입니다.
      if (uploadRequestIds[key] !== uploadId) return;
      if (!shouldMarkD1Uploaded({
        eventRequestId,
        uploadRequestId: uploadId,
        continuing: false,
        ledgerHasFull: ledger ? !!ledger.full : undefined,
      })) return;
      const state = await storage.getMigrationState(key);
      if (uploadRequestIds[key] !== uploadId) return;
      uploadRequestIds[key] = undefined;
      uploadAbandoned[key] = undefined;
      if (typeof state.d1UploadedAt === 'number') return;
      const next = await storage.updateMigrationState(key, { d1UploadedAt: clock() });
      if (isMigrationComplete(next)) emit({ type: 'completed', syncKey: key });
      emit({ type: 'gateChanged', syncKey: key });
    } catch (error) {
      console.warn('[familyMigration] d1UploadedAt을 적지 못했습니다. 다음 사건에서 다시 판정합니다.', error);
    }
  };

  const onRunnerEvent = (event: SyncRunnerEvent): void => {
    const uploadId = uploadRequestIds[event.syncKey];
    if (uploadId === undefined || event.requestId < uploadId) return;
    if (event.type === 'succeeded') {
      // 이어 가기 회차가 남았으면(continuing) 마지막 회차까지 기다립니다.
      if (event.result.continuing) return;
      void markUploaded(event.syncKey, event.requestId, uploadId);
    } else if (
      event.type === 'failed' || event.type === 'dropped' || event.type === 'migrationPending'
      || event.type === 'detached' || event.type === 'disconnected'
    ) {
      // 7단계 사슬이 끝맺지 못했습니다. 번호는 지우지 않습니다: D1이 exists인 키는 관문이 ensure를 부르지 않으므로,
      // 뒤의 평소 요청이 업로드를 마치면(장부에 full 없음) 그 성공 사건이 완료를 적게 해야 합니다(2.3). 전체 모드의 진행은
      // 장부에 남아 이어집니다. 다음 ensure는 이 표시를 보고 7단계를 다시 넣습니다.
      uploadAbandoned[event.syncKey] = true;
    }
  };

  const getRunner = (): MigratorRunner => {
    const runner = deps.getRunner();
    if (subscribedRunner !== runner) {
      runnerUnsubscribe?.();
      runnerUnsubscribe = runner.subscribe(onRunnerEvent);
      subscribedRunner = runner;
    }
    return runner;
  };

  // ── 관문 ──

  const hasEvidenceFor = async (key: string, state: MigrationState): Promise<boolean> => {
    const marker = await storage.getLegacyKeyMarker();
    return hasLegacyEvidence({ syncKey: key, markerKeys: marker?.keys, legacyJoinedAt: state.legacyJoinedAt });
  };

  const peekGate = async (syncKeyRaw: string): Promise<MigrationGate> => {
    const key = normalizeKey(syncKeyRaw);
    const state = await storage.getMigrationState(key);
    return decideMigrationGate({
      complete: isMigrationComplete(state),
      d1Status: d1StatusByKey.get(key),
      hasEvidence: await hasEvidenceFor(key, state),
    });
  };

  const migrationGate = async (syncKeyRaw: string): Promise<MigrationGate> => {
    const gate = await peekGate(syncKeyRaw);
    if (gate === 'paused') {
      // 멈춤에서 빠져나오는 계기(2차 검토 M3). 기다리지 않습니다(관문은 러너 대기열 안에서 돕니다, 4판).
      void ensure(syncKeyRaw).catch(error => {
        console.warn('[familyMigration] 관문에서 시작한 이전이 실패했습니다.', error);
      });
    }
    return gate;
  };

  // ── Firestore 읽기 공통 ──

  interface FsSession {
    fs: MigratorFirestore;
    deadline: number;
  }

  /** 잠금 안에서 실행합니다. 전체 예산은 잠금을 얻은 때부터 셉니다. */
  const inFirestore = async <T>(work: (session: FsSession) => Promise<T>): Promise<T> => {
    const fs = await loadFirestore();
    return fs.withFirestoreLock(() => work({ fs, deadline: clock() + budgetMs }));
  };

  /** 호출 하나에 15초(남은 예산이 더 짧으면 그만큼) 상한을 둡니다. 상한에 걸리면 firestoreImport가 인스턴스를 닫습니다. */
  const callFs = <T>(session: FsSession, fn: () => Promise<T>): Promise<T> => {
    const remaining = session.deadline - clock();
    if (remaining <= 0) {
      return Promise.reject(Object.assign(new Error('이전 서버 읽기 예산을 모두 썼습니다.'), { code: 'budget' }));
    }
    return session.fs.withFirestoreTimeout(fn, Math.min(callTimeoutMs, remaining));
  };

  const applyReadError = (
    fs: MigratorFirestore,
    outcome: FirestoreReadOutcome,
    error: unknown,
    duringLogs: boolean,
  ): void => {
    const kind = fs.classifyFirestoreError(error);
    if (kind === 'denied') outcome.state = 'denied';
    else {
      outcome.state = 'error';
      if (kind === 'quota') outcome.quota = true;
      if (kind === 'timeout' && duringLogs) outcome.pageTimedOut = true;
    }
    outcome.errorMessage = errorText(error);
  };

  /** 회원 확인과 가족 문서 하나(재확인용). 거부, 문서 없음, 오류는 종류만 돌려줍니다. 잠금 밖에서 부릅니다. */
  const recheckFamilyDoc = async (key: string): Promise<DocRecheck> => {
    try {
      return await inFirestore(async session => {
        try {
          await callFs(session, () => session.fs.ensureFirestoreMembership(key));
          const family = await callFs(session, () => session.fs.readLegacyFamilyDoc(key));
          if (!family.exists) return { kind: 'absent' } as DocRecheck;
          return { kind: 'ok', pendingDeletionAt: family.pendingDeletionAt, lastChangedAt: family.lastChangedAt } as DocRecheck;
        } catch (error) {
          const kind = session.fs.classifyFirestoreError(error);
          return (kind === 'denied' ? { kind: 'denied' } : { kind: 'error', quota: kind === 'quota' }) as DocRecheck;
        }
      });
    } catch (error) {
      console.warn('[familyMigration] 가족 문서를 다시 읽지 못했습니다.', error);
      return { kind: 'error' };
    }
  };

  /** 회원 확인 뒤 Firestore에 `pendingDeletionAt: null`을 씁니다(불변 조건 2의 두 쓰기 중 하나). */
  const cancelLegacyRequest = async (key: string): Promise<boolean> => {
    try {
      await inFirestore(async session => {
        await callFs(session, () => session.fs.ensureFirestoreMembership(key));
        await callFs(session, () => session.fs.cancelLegacyDeletion(key));
      });
      return true;
    } catch (error) {
      console.warn('[familyMigration] 삭제 요청을 취소하지 못했습니다.', error);
      notify('error', 'cancelRequestFailed', MIGRATION_MESSAGES.cancelRequestFailed);
      return false;
    }
  };

  // ── 2.4-4: Firestore 읽기 ──

  const readFirestoreFamily = async (run: Run, key: string, state: MigrationState): Promise<FirestoreReadOutcome> => {
    const outcome: FirestoreReadOutcome = {
      state: 'error', progressed: false, heavy: false, quota: false, pageTimedOut: false, invalidCount: 0,
    };
    let fsRef: MigratorFirestore | null = null;
    try {
      return await inFirestore(async session => {
        const { fs } = session;
        fsRef = fs;
        let stage: 'family' | 'logs' = 'family';
        try {
          // 1. 익명 로그인, 회원 확인과 가입
          await callFs(session, () => fs.ensureFirestoreMembership(key));
          if (!isCurrent(run)) { outcome.state = 'superseded'; return outcome; }

          // 2. 가족 문서
          const family = await callFs(session, () => fs.readLegacyFamilyDoc(key));
          if (!family.exists) { outcome.state = 'absent'; return outcome; }
          // 처음 읽는 시도라면 lastChangedAt(없으면 0)을 baselineChangedAt에 적습니다. 예약 중이어도 적어 둡니다.
          if (typeof state.baselineChangedAt !== 'number') {
            await storage.updateMigrationState(key, { baselineChangedAt: family.lastChangedAt });
          }
          if (family.pendingDeletionAt !== null) {
            outcome.state = 'pending_deletion';
            outcome.pendingDeletionAt = family.pendingDeletionAt;
            return outcome;
          }
          // null이거나 필드가 없으면 이미 물어본 예약 값을 지웁니다(2.2).
          if (state.promptedPendingDeletionAt !== undefined) {
            await storage.updateMigrationState(key, { promptedPendingDeletionAt: undefined });
          }

          // 3. logs를 문서 id 순서로 페이지마다 읽고, 받은 페이지를 곧바로 합쳐 저장한 뒤 위치를 적습니다.
          stage = 'logs';
          outcome.heavy = true;
          let after = state.firestoreReadAfter;
          for (;;) {
            const limit = pageSizes.get(key) ?? DEFAULT_PAGE_SIZE;
            const page = await callFs(session, () => fs.readLegacyLogsPage(key, { after, limit }));
            if (!isCurrent(run)) { outcome.state = 'superseded'; return outcome; }
            // 키가 바뀌었으면 합치지 않고, 위치도 올리지 않습니다(시나리오 9).
            const merged = await storage.mergeLegacyFirestoreData(key, { logs: page.logs, deletedIds: page.deletedIds });
            if (!merged) { outcome.state = 'superseded'; return outcome; }
            outcome.invalidCount += page.invalidCount;
            if (page.lastId !== undefined) {
              await storage.updateMigrationState(key, { firestoreReadAfter: page.lastId });
              after = page.lastId;
              outcome.progressed = true;
              emit({ type: 'merged', syncKey: key });
            }
            if (page.done) break;
          }

          // 4. 프로필(프로필 LWW 규칙은 합치는 쪽이 적용합니다)
          const sharedProfile = await callFs(session, () => fs.readLegacySharedProfile(key));
          if (sharedProfile) {
            const merged = await storage.mergeLegacyFirestoreData(key, { logs: [], deletedIds: [], profile: sharedProfile });
            if (!merged) { outcome.state = 'superseded'; return outcome; }
            emit({ type: 'merged', syncKey: key });
          }
          outcome.state = 'ok';
          return outcome;
        } catch (error) {
          applyReadError(fs, outcome, error, stage === 'logs');
          return outcome;
        }
      });
    } catch (error) {
      // 잠금이나 모듈 불러오기 자체의 실패
      if (fsRef) applyReadError(fsRef, outcome, error, false);
      else { outcome.state = 'error'; outcome.errorMessage = errorText(error); }
      return outcome;
    }
  };

  // ── 실패 기록 (2.3 실패 간격, 2.5) ──

  const scheduleRetry = (key: string, at: number | undefined): void => {
    const existing = retryTimers[key];
    if (existing !== undefined) {
      stopTimer(existing);
      retryTimers[key] = undefined;
    }
    if (at === undefined) return;
    const delay = Math.max(0, at - clock());
    retryTimers[key] = startTimer(() => {
      retryTimers[key] = undefined;
      void ensure(key).catch(error => console.warn('[familyMigration] 예약된 이전 재시도가 실패했습니다.', error));
    }, delay);
  };

  const recordFirestoreFailure = async (
    key: string,
    state: MigrationState,
    outcome: FirestoreReadOutcome,
    d1: D1Status | undefined,
    evidence: boolean,
  ): Promise<{ gaveUp: boolean; message?: string }> => {
    const now = clock();
    const blocked = outcome.state === 'denied' || outcome.state === 'absent' || outcome.state === 'pending_deletion';
    const blockedSince = blocked ? (state.blockedSince ?? now) : state.blockedSince;
    const schedule = nextFailureSchedule({
      now,
      previousFailureCount: state.failureCount,
      weight: outcome.heavy ? 'heavy' : 'light',
      progressed: outcome.progressed,
      quotaExhausted: outcome.quota,
    });
    if (outcome.pageTimedOut) pageSizes.set(key, nextPageSize(pageSizes.get(key) ?? DEFAULT_PAGE_SIZE));

    let message: string | undefined;
    if (outcome.state === 'denied') {
      // 근거가 있으면 uid 변경이나 예전 문서 형식 때문일 수 있어 firestore_error로 낮춥니다(2.5). 그래도 7일이 넘으면 안내를 바꿉니다.
      if (isBlockedLong({ now, blockedSince })) message = MIGRATION_MESSAGES.deniedLong;
      else message = evidence ? MIGRATION_MESSAGES.firestoreError : MIGRATION_MESSAGES.deniedNoEvidence;
    } else if (outcome.state === 'absent') message = MIGRATION_MESSAGES.absent;
    else if (outcome.state === 'error') message = MIGRATION_MESSAGES.firestoreError;
    // pending_deletion은 선택 화면이 안내합니다.

    const patch: MigrationPatch = {
      failureCount: schedule.failureCount,
      nextFirestoreAttemptAt: schedule.nextFirestoreAttemptAt,
      blockedSince,
      lastError: message,
    };
    // 재시도 종료(2.5): D1이 exists인 가족에서 14일 넘게 이어지면 읽기를 멈춥니다. missing은 멈추지 않습니다.
    const gaveUp = blocked && shouldGiveUpFirestoreRead({ d1Status: d1, now, blockedSince });
    if (gaveUp) {
      Object.assign(patch, {
        mergeSource: 'skipped',
        mergedAt: now,
        failureCount: undefined,
        nextFirestoreAttemptAt: undefined,
        lastError: undefined,
      });
    }
    await storage.updateMigrationState(key, patch);
    if (gaveUp) {
      scheduleRetry(key, undefined);
      notify('info', 'firestoreGaveUp', MIGRATION_MESSAGES.gaveUp);
    } else {
      scheduleRetry(key, schedule.nextFirestoreAttemptAt);
      // 같은 문구를 반복해서 띄우지 않도록 바뀐 경우에만 알립니다.
      if (message && message !== state.lastError) notify('error', `firestore_${outcome.state}`, message);
    }
    return { gaveUp, message };
  };

  // ── 1.7.9 삭제 예약 선택 (2.4.1, 2.4-6, 2.6.3) ──

  const optionsFor = (context: PromptContext): LegacyDeletionChoice[] =>
    context === 'joining' ? ['cancelRequest', 'cancelJoin'] : ['cancelRequest', 'followDeletion', 'later'];

  const disconnectDevice = async (key: string): Promise<void> => {
    const profile = await storage.getProfile();
    if ((profile.syncKey || '').trim() === key) {
      await storage.saveProfile({ ...profile, syncKey: undefined });
    }
    emit({ type: 'disconnected', syncKey: key });
  };

  const recordPrompted = async (key: string, value: number, withNotice: boolean): Promise<void> => {
    await storage.updateMigrationState(key, {
      promptedPendingDeletionAt: value,
      ...(withNotice ? { legacyDeletionNoticeAt: clock() } : {}),
    });
  };

  /**
   * 예약 선택 화면을 보이고 답을 처리합니다. 사용자의 답을 기다리므로 Firestore 잠금 밖에서 부릅니다.
   * "삭제에 따르기"는 보내기 직전에 가족 문서를 서버에서 다시 읽어 확인합니다(4판 M1): 읽기 실패, 취소됨,
   * 화면 값과 다름이면 보내지 않습니다.
   */
  const promptPendingDeletion = async (
    key: string,
    initialValue: number,
    context: Exclude<PromptContext, 'joining'>,
  ): Promise<PromptOutcome> => {
    let value = initialValue;
    for (let round = 0; round < MAX_REPROMPTS; round += 1) {
      let choice: LegacyDeletionChoice;
      try {
        choice = await deps.askLegacyDeletionChoice({ context, pendingDeletionAt: value, options: optionsFor(context) });
      } catch (error) {
        console.warn('[familyMigration] 삭제 예약 선택 화면에서 오류가 났습니다.', error);
        choice = 'later';
      }

      if (choice === 'later') {
        // 2.4.1의 "나중에"는 적지 않아 앱을 다시 열 때 다시 묻습니다. 전환기와 exists 안내는 보인 값을 적습니다(2.6.3).
        if (context === 'missing') deferredPrompts.add(`${key}|${value}`);
        else await recordPrompted(key, value, context === 'exists');
        return 'later';
      }
      if (choice === 'cancelRequest') {
        if (!(await cancelLegacyRequest(key))) return 'failed';
        await recordPrompted(key, value, context === 'exists');
        return 'cancelled';
      }
      if (choice !== 'followDeletion') return 'invalid_choice';

      // 보내기 전 재확인
      const recheck = await recheckFamilyDoc(key);
      if (recheck.kind !== 'ok') {
        notify('error', 'deletionRecheckFailed', MIGRATION_MESSAGES.deletionRecheckFailed);
        return 'failed';
      }
      if (recheck.pendingDeletionAt === null) {
        notify('info', 'deletionCancelledElsewhere', MIGRATION_MESSAGES.deletionCancelledElsewhere);
        return 'withdrawn';
      }
      if (recheck.pendingDeletionAt !== value) {
        // 값이 바뀌었으면 보내지 않고 새 값으로 선택 화면을 다시 보여 줍니다.
        value = recheck.pendingDeletionAt;
        continue;
      }

      const clientId = await deps.getClientId();
      if (context === 'missing') {
        // 2.4.1: D1에 가족이 없을 때만 서버가 삭제 기록을 남깁니다(legacyDeletion).
        try {
          await cloud.deleteFamilyData(key, clientId, { legacyDeletion: true });
        } catch (error) {
          const status = errorStatus(error);
          if (status === 410) {
            // 이미 삭제 기록이 있음: 원하던 결과이므로 연결을 해제합니다.
          } else if (status === 409) {
            // 그 사이 다른 기기가 D1 가족을 만들었음: 연결을 해제하지 않고 2.4를 다시 실행합니다. 같은 화면이 반복되지 않게 적어 둡니다.
            notify('info', 'alreadyMigrated', MIGRATION_MESSAGES.alreadyMigrated);
            await recordPrompted(key, value, true);
            return 'conflict';
          } else {
            notify('error', 'deletionActionFailed', MIGRATION_MESSAGES.deletionActionFailed);
            return 'failed';
          }
        }
        await recordPrompted(key, value, false);
        await disconnectDevice(key);
        notify('info', 'deletionFollowed', MIGRATION_MESSAGES.deletionFollowed);
        return 'followed';
      }

      // exists와 전환기: 1.8.0의 영구 삭제 절차(D1 예약과 냉각 뒤 삭제)를 이 기기에서 시작합니다(2.6.3).
      try {
        await cloud.scheduleFamilyDeletion(key, clientId);
      } catch (error) {
        if (errorStatus(error) !== 410) {
          notify('error', 'deletionActionFailed', MIGRATION_MESSAGES.deletionActionFailed);
          return 'failed';
        }
      }
      await recordPrompted(key, value, context === 'exists');
      notify('info', 'deletionScheduled', MIGRATION_MESSAGES.deletionScheduled);
      return 'followed';
    }
    // 값이 계속 바뀌면 보내지 않고 멈춥니다. 다음 시도에서 새 값으로 다시 묻습니다.
    return 'failed';
  };

  // ── 2.4 이전 단계 ──

  const requestUpload = (run: Run, key: string, state: MigrationState, mergedNow: boolean): 'requested' | 'skipped' | 'pending' | 'superseded' => {
    setD1Status(key, 'exists');
    // 병합 전 업로드로 d1UploadedAt이 이미 있고 이번 시도에서 새로 병합하지 않았으면 건너뜁니다(2.2).
    if (typeof state.d1UploadedAt === 'number' && !mergedNow) return 'skipped';
    if (!isCurrent(run)) return 'superseded';
    // 이미 넣은 7단계가 끝나기 전에 ensure가 다시 불려도 요청을 쌓지 않습니다. 새로 병합했거나, 넣은 요청이
    // 끝맺지 못했으면(uploadAbandoned) 다시 올립니다.
    if (uploadRequestIds[key] !== undefined && !mergedNow && !uploadAbandoned[key]) return 'pending';
    uploadRequestIds[key] = undefined;
    uploadAbandoned[key] = undefined;
    const runner = getRunner();
    // `onAccepted`는 요청을 받는 즉시 번호를 알려 줍니다. 결과는 기다리지 않습니다(관문 교착 방지, 4판).
    runner.request({ syncKey: key, forceFullRead: true }, {
      onAccepted: id => { uploadRequestIds[key] = id; },
    }).catch(() => undefined);
    return 'requested';
  };

  /** D1 가족 확인(2.4-2)과 이어받기(2.4-6 missing + ok)가 함께 쓰는 D1 호출 */
  const connectD1 = async (
    key: string,
    allowCreate: boolean,
  ): Promise<{ kind: D1Status } | { kind: 'stop'; result: EnsureResult }> => {
    try {
      await cloud.connectFamily(key, await deps.getClientId(), allowCreate);
      setD1Status(key, 'exists');
      return { kind: 'exists' };
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) {
        setD1Status(key, 'missing');
        return { kind: 'missing' };
      }
      if (status === 410) {
        setD1Status(key, 'deleted');
        // 러너에 평소 요청 하나를 넣어 410 회차가 연결을 끊게 합니다(2.3 "deleted일 때의 410 회차").
        getRunner().request({ syncKey: key }).catch(() => undefined);
        return { kind: 'stop', result: { status: 'deleted' } };
      }
      if (status === 401) {
        await storage.updateMigrationState(key, { lastError: MIGRATION_MESSAGES.keyFormat });
        notify('error', 'keyFormat', MIGRATION_MESSAGES.keyFormat);
        return { kind: 'stop', result: { status: 'key_format', message: MIGRATION_MESSAGES.keyFormat } };
      }
      // 네트워크 오류와 5xx는 Firestore 실패 간격을 적용하지 않고 끝냅니다. 다음 계기(관문, 앱 복귀)가 다시 시도합니다.
      return { kind: 'stop', result: { status: 'd1_error', message: errorText(error) } };
    }
  };

  const ensureBackup = async (): Promise<boolean> => {
    const result = await storage.ensurePreMigrationBackup();
    if (result !== 'failed') return true;
    // 저장이 실패했습니다(용량 부족 포함). 이번 실행 동안 한 번만 묻습니다(저장할 때마다 다시 묻지 않음).
    if (backupDeclinedThisSession) return false;
    let answer: 'continue' | 'later' = 'later';
    try {
      answer = await deps.askBackupFailure();
    } catch (error) {
      console.warn('[familyMigration] 백업 실패 선택 화면에서 오류가 났습니다.', error);
    }
    if (answer === 'continue') {
      await storage.markPreMigrationBackupSkipped();
      return true;
    }
    backupDeclinedThisSession = true;
    return false;
  };

  const startTransitionIfAbsent = async (key: string, state: MigrationState): Promise<void> => {
    const transition = await storage.getTransitionState(key);
    if (typeof transition.seenFamilyChangedAt === 'number') return;
    await storage.updateTransitionState(key, { seenFamilyChangedAt: state.baselineChangedAt ?? 0 });
  };

  const runEnsure = async (run: Run, rerun: number, ignoreBackoff: boolean): Promise<EnsureResult> => {
    const key = run.key;
    let state = await storage.getMigrationState(key);
    if (isMigrationComplete(state)) return { status: 'complete' };

    // 혼자 쓰기와 다른 가족: 저장된 키가 이 키가 아니면 아무것도 하지 않습니다(불변 조건 5).
    const profile = await storage.getProfile();
    if ((profile.syncKey || '').trim() !== key) return { status: 'not_connected' };
    if (!isCurrent(run)) return { status: 'superseded' };
    // 앱을 켠 뒤에도 실패 간격이 남아 있으면 그 시각에 다시 부르는 타이머를 둡니다.
    if (typeof state.nextFirestoreAttemptAt === 'number' && state.nextFirestoreAttemptAt > clock() && retryTimers[key] === undefined) {
      scheduleRetry(key, state.nextFirestoreAttemptAt);
    }

    // 1. 이전 직전 백업
    if (!(await ensureBackup())) return { status: 'backup_pending', message: MIGRATION_MESSAGES.backupFailed };
    if (!isCurrent(run)) return { status: 'superseded' };

    // 2. D1 가족 확인(allowCreate=false)
    const d1Result = await connectD1(key, false);
    if (d1Result.kind === 'stop') return d1Result.result;
    const d1: D1Status = d1Result.kind;
    if (d1 === 'deleted') return { status: 'deleted' };
    if (!isCurrent(run)) return { status: 'superseded' };

    // 3~5. Firestore를 읽을지 판단하고 읽기
    const evidence = await hasEvidenceFor(key, state);
    let firestoreState: FirestoreState;
    let outcome: FirestoreReadOutcome | undefined;
    let mergedNow = false;
    if (state.mergeSource === 'ok') {
      // 병합을 마친 키도 D1이 missing이면 가족 문서를 다시 읽습니다(결정표 recheck_then_adopt). 그 읽기도 실패 간격을 지킵니다.
      // 간격 안이면 읽지 않고 not_due와 같은 대기 결과로 끝냅니다(exists이면 어차피 7번이라 결과가 같습니다).
      firestoreState = isFirestoreReadDeferred({ now: clock(), nextFirestoreAttemptAt: state.nextFirestoreAttemptAt, ignoreBackoff })
        ? 'not_due'
        : 'merged_before_ok';
    } else if (state.mergeSource === 'skipped') firestoreState = 'merged_before_skipped';
    else if (d1 === 'exists' && !evidence) {
      // 근거가 없는 exists는 읽지 않습니다. 상대가 이미 옮긴 1.8.0 가족입니다.
      state = await storage.updateMigrationState(key, { mergeSource: 'skipped', mergedAt: clock() });
      firestoreState = 'unread';
    } else if (isFirestoreReadDeferred({ now: clock(), nextFirestoreAttemptAt: state.nextFirestoreAttemptAt, ignoreBackoff })) {
      firestoreState = 'not_due';
    } else {
      outcome = await readFirestoreFamily(run, key, state);
      if (outcome.state === 'superseded' || !isCurrent(run)) return { status: 'superseded' };
      if (outcome.state === 'ok') {
        firestoreState = 'merged_now';
        mergedNow = true;
        const firstMerge = state.mergeSource === undefined;
        // 병합 전에 넣은 7단계(U1)의 번호를 먼저 무효로 합니다. 아래에서 d1UploadedAt을 지운 뒤 병합 뒤 업로드(U2)를 넣기까지
        // U1의 성공 사건이 오면 d1UploadedAt이 다시 적혀 U2 완료가 무시됩니다. 동기로 비우므로 이미 도는 markUploaded도
        // (번호가 바뀌었으니) 적지 않습니다.
        uploadRequestIds[key] = undefined;
        uploadAbandoned[key] = undefined;
        // 5. 병합 완료. d1UploadedAt이 있으면 지워 병합한 기록을 올리는 7단계를 한 번 더 합니다(2.2).
        state = await storage.updateMigrationState(key, {
          mergeSource: 'ok',
          mergedAt: clock(),
          d1UploadedAt: undefined,
          failureCount: undefined,
          nextFirestoreAttemptAt: undefined,
          blockedSince: undefined,
          lastError: outcome.invalidCount > 0
            ? `형식이 어긋난 기록 ${outcome.invalidCount}건을 건너뛰었습니다.`
            : undefined,
        });
        scheduleRetry(key, undefined);
        await startTransitionIfAbsent(key, state);
        if (firstMerge) notify('info', 'transitionStarted', MIGRATION_MESSAGES.transitionStarted);
      } else {
        firestoreState = outcome.state;
        const failure = await recordFirestoreFailure(key, state, outcome, d1, evidence);
        state = await storage.getMigrationState(key);
        if (failure.gaveUp) firestoreState = 'merged_before_skipped';
      }
    }

    // 6. D1 가족 결정(결정표)
    return decideAndAct(run, { key, state, d1, firestoreState, outcome, mergedNow, evidence, rerun });
  };

  interface DecideInput {
    key: string;
    state: MigrationState;
    d1: D1Status;
    firestoreState: FirestoreState;
    outcome?: FirestoreReadOutcome;
    mergedNow: boolean;
    evidence: boolean;
    rerun: number;
  }

  const rerunEnsure = (run: Run, rerun: number): Promise<EnsureResult> =>
    rerun >= MAX_RERUNS ? Promise.resolve({ status: 'waiting' }) : runEnsure(run, rerun + 1, true);

  const decideAndAct = async (run: Run, input: DecideInput): Promise<EnsureResult> => {
    const { key, evidence } = input;
    let { state, firestoreState, outcome } = input;
    let action: FamilyAction = decideFamilyAction({ d1: input.d1, firestore: firestoreState });

    // 병합 완료(ok) + missing: 가족 문서를 하나 다시 읽어 이어받을지 결정합니다.
    if (action === 'recheck_then_adopt') {
      const recheck = await recheckFamilyDoc(key);
      if (!isCurrent(run)) return { status: 'superseded' };
      if (recheck.kind === 'ok') {
        if (recheck.pendingDeletionAt === null) {
          action = 'adopt';
          // 예약이 없어졌으면 이미 물어본 예약 값을 지웁니다(2.2). 다음 예약은 새 예약으로 다시 묻습니다.
          if (state.promptedPendingDeletionAt !== undefined) {
            state = await storage.updateMigrationState(key, { promptedPendingDeletionAt: undefined });
          }
        } else {
          firestoreState = 'pending_deletion';
          outcome = {
            state: 'pending_deletion', progressed: false, heavy: false, quota: false,
            pageTimedOut: false, invalidCount: 0, pendingDeletionAt: recheck.pendingDeletionAt,
          };
        }
      } else {
        firestoreState = recheck.kind;
        outcome = {
          state: recheck.kind, progressed: false, heavy: false, quota: recheck.kind === 'error' && recheck.quota === true,
          pageTimedOut: false, invalidCount: 0,
        };
      }
      if (action !== 'adopt') {
        await recordFirestoreFailure(key, state, outcome!, input.d1, evidence);
        state = await storage.getMigrationState(key);
        action = decideFamilyAction({ d1: input.d1, firestore: firestoreState });
      }
    }

    switch (action) {
      case 'stop_deleted':
        return { status: 'deleted' };

      case 'server_anomaly':
        // 이 키는 D1에 있던 가족인데 지금 없습니다. 서버 이상(404 보존)으로 보고 오류만 보입니다. 이어받지 않습니다.
        await storage.updateMigrationState(key, { lastError: NOT_FOUND_MESSAGE });
        notify('error', 'serverAnomaly', NOT_FOUND_MESSAGE);
        return { status: 'server_anomaly', message: NOT_FOUND_MESSAGE };

      case 'denied':
        return { status: 'firestore_denied', message: state.lastError };

      case 'absent':
        return { status: 'firestore_absent', message: MIGRATION_MESSAGES.absent };

      case 'fail':
        return { status: firestoreState === 'not_due' ? 'waiting' : 'firestore_failed', message: state.lastError };

      case 'choose_pending_deletion': {
        // missing + pending_deletion: 2.4.1 선택 화면. 이미 물어본 값이거나 이번 실행에서 "나중에"를 골랐으면 다시 묻지 않습니다.
        const value = outcome?.pendingDeletionAt;
        if (value === undefined
          || !shouldPromptPendingDeletion({ pendingDeletionAt: value, promptedPendingDeletionAt: state.promptedPendingDeletionAt })
          || deferredPrompts.has(`${key}|${value}`)) {
          return { status: 'pending_deletion' };
        }
        const promptResult = await promptPendingDeletion(key, value, 'missing');
        if (!isCurrent(run)) return { status: 'superseded' };
        if (promptResult === 'cancelled' || promptResult === 'conflict' || promptResult === 'withdrawn') {
          return rerunEnsure(run, input.rerun);
        }
        if (promptResult === 'followed') return { status: 'deletion_followed' };
        return { status: 'pending_deletion' };
      }

      case 'adopt': {
        // missing + ok: connectFamily(allowCreate=true)로 이어받고 7번
        const adopted = await connectD1(key, true);
        if (adopted.kind === 'stop') return adopted.result;
        if (adopted.kind !== 'exists') return { status: 'd1_error' };
        if (!isCurrent(run)) return { status: 'superseded' };
        return finishUpload(run, key, state, input.mergedNow);
      }

      case 'upload':
      case 'upload_with_prompt': {
        const uploadStatus = finishUpload(run, key, state, input.mergedNow);
        if (action === 'upload_with_prompt') {
          // exists + pending_deletion: 평소 동기화는 계속하되, 예약 값이 이미 물어본 값과 다르면 선택 화면을 한 번 보입니다.
          const value = outcome?.pendingDeletionAt;
          if (value !== undefined
            && shouldPromptPendingDeletion({ pendingDeletionAt: value, promptedPendingDeletionAt: state.promptedPendingDeletionAt })) {
            const promptResult = await promptPendingDeletion(key, value, 'exists');
            if (!isCurrent(run)) return { status: 'superseded' };
            if (promptResult === 'cancelled' || promptResult === 'conflict' || promptResult === 'withdrawn') {
              return rerunEnsure(run, input.rerun);
            }
            if (promptResult === 'followed') return { status: 'pending_deletion' };
          }
        }
        return uploadStatus;
      }

      default:
        return { status: 'waiting' };
    }
  };

  const finishUpload = (run: Run, key: string, state: MigrationState, mergedNow: boolean): EnsureResult => {
    const result = requestUpload(run, key, state, mergedNow);
    if (result === 'superseded') return { status: 'superseded' };
    if (result === 'skipped') return { status: 'waiting' };
    return { status: 'uploading' };
  };

  function ensure(syncKeyRaw: string): Promise<EnsureResult> {
    const key = normalizeKey(syncKeyRaw);
    // 같은 키의 이전이 돌고 있으면 같은 Promise를 돌려줍니다. 다른 키로 바뀌면 앞 작업은 결과를 저장하지 않습니다.
    if (active && active.run.key === key) return active.promise;
    const run: Run = { key };
    const promise: Promise<EnsureResult> = runEnsure(run, 0, false).finally(() => {
      if (active?.run === run) active = null;
    });
    active = { run, promise };
    return promise;
  }

  // ── 2.9 합류 ──

  const afterConnectSuccess = async (
    key: string,
    allowFamilyCreation: boolean,
  ): Promise<{ migration?: Promise<EnsureResult> }> => {
    setD1Status(key, 'exists');
    const state = await storage.getMigrationState(key);
    // 새 가족 만들기는 Firestore에 있을 수 없으므로 완료로 적습니다. 근거가 없는 합류도 1.8.0 가족 합류입니다.
    if (allowFamilyCreation || !(await hasEvidenceFor(key, state))) {
      const now = clock();
      await storage.updateMigrationState(key, {
        mergeSource: state.mergeSource ?? 'skipped',
        mergedAt: state.mergedAt ?? now,
        d1UploadedAt: state.d1UploadedAt ?? now,
      });
      emit({ type: 'completed', syncKey: key });
      return {};
    }
    // 근거가 있으면(1.7.9 시절 연결, 또는 legacyJoin을 시작한 적이 있음) 완료로 적지 않고 2.4를 시작합니다.
    return { migration: ensure(key) };
  };

  const connectingRound = (key: string, allowFamilyCreation: boolean, createBackup: boolean): Promise<SyncRunResult> =>
    getRunner().request({ syncKey: key, createBackup, allowFamilyCreation, connecting: true });

  const joinFamily = async (
    keyRaw: string,
    options: { allowFamilyCreation?: boolean; createBackup?: boolean } = {},
  ): Promise<JoinResult> => {
    const key = normalizeKey(keyRaw);
    const allowFamilyCreation = options.allowFamilyCreation ?? false;
    const createBackup = options.createBackup ?? true;
    // 1. 러너에 연결 회차를 넣습니다(관문을 거치지 않음).
    const result = await connectingRound(key, allowFamilyCreation, createBackup);
    // 2. 성공하면 d1Status를 exists로 적고 근거 분기를 합니다.
    if (result.success) {
      const after = await afterConnectSuccess(key, allowFamilyCreation);
      return { outcome: 'joined', syncResult: result, migration: after.migration };
    }
    // 3. familyNotFound이면 legacyJoin
    if (result.familyNotFound && !allowFamilyCreation) {
      return legacyJoin(key, { createBackup });
    }
    // 4. 그 밖의 실패는 연결 회차의 결과를 그대로 돌려줍니다.
    if (result.familyUnavailable) {
      return { outcome: 'deleted', message: result.error, syncResult: result };
    }
    return { outcome: 'failed', message: result.error, syncResult: result };
  };

  const runLegacyJoin = async (key: string, createBackup: boolean): Promise<JoinResult> => {
    notify('info', 'legacyJoinChecking', MIGRATION_MESSAGES.legacyJoinChecking);

    // 1. Firestore 회원 확인과 가입, 가족 문서 읽기만 합니다(2.4-4의 1~2). 기록은 읽지 않습니다.
    const doc = await recheckFamilyDoc(key);
    if (doc.kind === 'denied' || doc.kind === 'absent') {
      // 거부(가족 문서가 없는 경우 포함)면 JOIN_NOT_FOUND로 끝냅니다. 그 가족의 기록은 기기에 섞이지 않습니다.
      return { outcome: 'not_found', message: JOIN_NOT_FOUND_MESSAGE };
    }
    if (doc.kind === 'error') {
      return { outcome: 'failed', message: MIGRATION_MESSAGES.legacyJoinFailed };
    }
    if (doc.pendingDeletionAt !== null) {
      // 합류 중에는 선택지가 둘뿐입니다. 이 기기는 아직 회원이 아니므로 "삭제에 따르기"는 없습니다(4판, 경미 5).
      let choice: LegacyDeletionChoice;
      try {
        choice = await deps.askLegacyDeletionChoice({
          context: 'joining', pendingDeletionAt: doc.pendingDeletionAt, options: optionsFor('joining'),
        });
      } catch (error) {
        console.warn('[familyMigration] 합류 중 삭제 예약 선택 화면에서 오류가 났습니다.', error);
        choice = 'cancelJoin';
      }
      if (choice === 'cancelJoin') return { outcome: 'cancelled', message: MIGRATION_MESSAGES.joinCancelled };
      if (choice !== 'cancelRequest') return { outcome: 'pending_deletion_choice' };
      // 취소 쓰기는 회원만 할 수 있으므로 1단계에서 회원 문서를 만든 뒤에 씁니다.
      if (!(await cancelLegacyRequest(key))) {
        return { outcome: 'failed', message: MIGRATION_MESSAGES.cancelRequestFailed };
      }
    }

    // 2. D1 가족을 만들기 전에 legacyJoinedAt과 baselineChangedAt을 적습니다. 이전 baseline이 있으면 더 작은 값을 둡니다
    //    (이미 읽은 페이지를 놓치지 않으려면 오래된 값이 안전합니다).
    const before = await storage.getMigrationState(key);
    await storage.updateMigrationState(key, {
      legacyJoinedAt: before.legacyJoinedAt ?? clock(),
      baselineChangedAt: typeof before.baselineChangedAt === 'number'
        ? Math.min(before.baselineChangedAt, doc.lastChangedAt)
        : doc.lastChangedAt,
    });

    // 3. connectFamily(allowCreate=true)로 D1 가족을 만듭니다. 410이면 키를 저장하지 않고 끝냅니다.
    try {
      await cloud.connectFamily(key, await deps.getClientId(), true);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 410) {
        setD1Status(key, 'deleted');
        return { outcome: 'deleted', message: MIGRATION_MESSAGES.joinDeleted };
      }
      return { outcome: 'failed', message: status === 401 ? MIGRATION_MESSAGES.keyFormat : errorText(error) };
    }
    setD1Status(key, 'exists');

    // 4. 러너에 연결 회차를 다시 넣습니다. 성공하면 근거(legacyJoinedAt)가 있으므로 2.4가 시작됩니다.
    const result = await connectingRound(key, false, createBackup);
    if (result.success) {
      const after = await afterConnectSuccess(key, false);
      return { outcome: 'joined', syncResult: result, migration: after.migration };
    }
    if (result.familyUnavailable) return { outcome: 'deleted', message: MIGRATION_MESSAGES.joinDeleted, syncResult: result };
    return { outcome: 'failed', message: result.error, syncResult: result };
  };

  const legacyJoin = (keyRaw: string, options: { createBackup?: boolean } = {}): Promise<JoinResult> => {
    const key = normalizeKey(keyRaw);
    const existing = legacyJoinsInFlight[key];
    if (existing) return existing;
    const promise = runLegacyJoin(key, options.createBackup ?? true).finally(() => {
      legacyJoinsInFlight[key] = undefined;
    });
    legacyJoinsInFlight[key] = promise;
    return promise;
  };

  // ── 2.6 전환기 ──

  const runTransitionTick = async (key: string, force: boolean): Promise<TransitionTickResult> => {
    let state = await storage.getMigrationState(key);
    // 전환기는 mergeSource가 'ok'인 기기에만 있습니다. 시작은 mergedAt입니다.
    if (state.mergeSource !== 'ok' || typeof state.mergedAt !== 'number') return { status: 'none' };
    const profile = await storage.getProfile();
    if ((profile.syncKey || '').trim() !== key) return { status: 'none' };

    let transition = await storage.getTransitionState(key);
    let decision = decideTransition({ now: clock(), mergedAt: state.mergedAt, partnerSeenAt: transition.partnerSeenAt });
    if (decision.ended) return { status: 'ended', reason: decision.reason };

    // 이전이 아직 안 끝나 관문이 멈춘 키는 읽지 않습니다.
    if (await peekGate(key) === 'paused') return { status: 'paused' };
    // 실패 간격은 당겨서 새로고침도 지킵니다.
    if (typeof state.nextFirestoreAttemptAt === 'number' && state.nextFirestoreAttemptAt > clock()) {
      return { status: 'backoff' };
    }
    if (!force && !isTransitionReadDue({
      now: clock(), lastReadAt: lastTransitionReadAt.get(key), intervalMs: decision.intervalMs,
    })) {
      return { status: 'throttled' };
    }
    lastTransitionReadAt.set(key, clock());

    // 전환기가 있는 기기만 otherMembers를 요청합니다(2.7-2). 상대를 처음 보면 24시간 여유가 시작됩니다.
    if (typeof transition.partnerSeenAt !== 'number') {
      try {
        const token = await cloud.getSyncToken(key, await deps.getClientId(), { members: true });
        if (isPartnerSeen(token.otherMembers)) {
          transition = await storage.updateTransitionState(key, { partnerSeenAt: clock() });
          decision = decideTransition({ now: clock(), mergedAt: state.mergedAt, partnerSeenAt: transition.partnerSeenAt });
        }
      } catch (error) {
        // D1 쪽 오류는 Firestore 실패 간격과 상관없습니다. 다음 읽기에서 다시 묻습니다.
        console.warn('[familyMigration] 전환기의 회원 수 확인에 실패했습니다.', error);
      }
    }
    if (typeof transition.seenFamilyChangedAt !== 'number') {
      transition = await storage.updateTransitionState(key, { seenFamilyChangedAt: state.baselineChangedAt ?? 0 });
    }
    const seen = transition.seenFamilyChangedAt ?? 0;

    interface TickRead {
      status: 'unchanged' | 'merged' | 'superseded' | 'failed';
      pendingDeletionAt?: number | null;
      outcome?: FirestoreReadOutcome;
    }
    const failure = (error: unknown, fs: MigratorFirestore | null): TickRead => {
      const outcome: FirestoreReadOutcome = {
        state: 'error', progressed: false, heavy: false, quota: false, pageTimedOut: false, invalidCount: 0,
      };
      if (fs) applyReadError(fs, outcome, error, false);
      else outcome.errorMessage = errorText(error);
      return { status: 'failed', outcome };
    };
    let fsRef: MigratorFirestore | null = null;
    let read: TickRead;
    try {
      read = await inFirestore<TickRead>(async session => {
        const { fs } = session;
        fsRef = fs;
        try {
          // 회원 확인은 이 프로세스에서 한 번 성공하면 기억해 두고, 전환기 읽기마다 다시 읽지 않습니다(4.1 표의 2회).
          // 가족 문서 읽기가 거부되면(회원 문서가 사라졌거나 uid가 바뀐 경우) 기억을 지우고 회원 확인부터 다시 합니다.
          const confirmMembership = async (): Promise<void> => {
            // 회원 확인이 거부되면 재가입을 한 번 시도하고, 그래도 거부되면 실패로 봅니다.
            try {
              await callFs(session, () => fs.ensureFirestoreMembership(key));
            } catch (error) {
              if (fs.classifyFirestoreError(error) !== 'denied') throw error;
              await callFs(session, () => fs.ensureFirestoreMembership(key));
            }
            transitionMembershipConfirmed[key] = true;
          };
          const fromMemory = transitionMembershipConfirmed[key] === true;
          if (!fromMemory) await confirmMembership();
          let family: Awaited<ReturnType<MigratorFirestore['readLegacyFamilyDoc']>>;
          try {
            family = await callFs(session, () => fs.readLegacyFamilyDoc(key));
          } catch (error) {
            if (!fromMemory || fs.classifyFirestoreError(error) !== 'denied') throw error;
            transitionMembershipConfirmed[key] = undefined;
            await confirmMembership();
            family = await callFs(session, () => fs.readLegacyFamilyDoc(key));
          }
          if (!family.exists) {
            return { status: 'failed', outcome: { state: 'absent', progressed: false, heavy: false, quota: false, pageTimedOut: false, invalidCount: 0 } };
          }
          if (family.pendingDeletionAt === null && state.promptedPendingDeletionAt !== undefined) {
            await storage.updateMigrationState(key, { promptedPendingDeletionAt: undefined });
          }
          let merged = false;
          if (family.lastChangedAt > seen) {
            // lastChangedAt이 새로울 때만 logs(updatedAt >= seen)와 profile/shared를 읽습니다.
            const logs = await callFs(session, () => fs.readLegacyLogsUpdatedSince(key, seen));
            const sharedProfile = await callFs(session, () => fs.readLegacySharedProfile(key));
            const ok = await storage.mergeLegacyFirestoreData(key, {
              logs: logs.logs, deletedIds: logs.deletedIds, profile: sharedProfile ?? undefined,
            });
            if (!ok) return { status: 'superseded' };
            // 합친 결과를 저장한 뒤에만 커서를 올립니다.
            await storage.updateTransitionState(key, { seenFamilyChangedAt: family.lastChangedAt });
            merged = true;
            emit({ type: 'merged', syncKey: key });
          }
          return { status: merged ? 'merged' : 'unchanged', pendingDeletionAt: family.pendingDeletionAt };
        } catch (error) {
          return failure(error, fs);
        }
      });
    } catch (error) {
      read = failure(error, fsRef);
    }

    if (read.status === 'superseded') return { status: 'superseded' };
    if (read.status === 'failed') {
      const outcome = read.outcome!;
      state = await storage.getMigrationState(key);
      // 전환기 실패는 가벼운 실패 간격을 적용합니다. 14일 종료는 이전 단계(D1 exists)의 규칙이라 여기서는 적용하지 않습니다.
      const schedule = nextFailureSchedule({
        now: clock(), previousFailureCount: state.failureCount, weight: 'light', quotaExhausted: outcome.quota,
      });
      await storage.updateMigrationState(key, {
        failureCount: schedule.failureCount,
        nextFirestoreAttemptAt: schedule.nextFirestoreAttemptAt,
      });
      return { status: 'failed', reason: outcome.state, message: outcome.errorMessage };
    }

    if (typeof state.failureCount === 'number' || typeof state.nextFirestoreAttemptAt === 'number') {
      await storage.updateMigrationState(key, { failureCount: undefined, nextFirestoreAttemptAt: undefined, blockedSince: undefined });
    }

    // 1.7.9 상대의 삭제 예약(2.6.3). 값이 이미 물어본 값과 다르면 선택 화면을 한 번 보입니다.
    if (typeof read.pendingDeletionAt === 'number') {
      state = await storage.getMigrationState(key);
      if (shouldPromptPendingDeletion({
        pendingDeletionAt: read.pendingDeletionAt, promptedPendingDeletionAt: state.promptedPendingDeletionAt,
      })) {
        await promptPendingDeletion(key, read.pendingDeletionAt, 'transition');
      }
    }
    return { status: read.status };
  };

  const transitionTick = (syncKeyRaw: string, options: { force?: boolean } = {}): Promise<TransitionTickResult> => {
    const key = normalizeKey(syncKeyRaw);
    const existing = ticksInFlight[key];
    if (existing) return existing;
    const promise = runTransitionTick(key, options.force === true).finally(() => {
      ticksInFlight[key] = undefined;
    });
    ticksInFlight[key] = promise;
    return promise;
  };

  // ── 화면 요약 ──

  const getSummary = async (syncKeyRaw: string): Promise<MigratorSummary> => {
    const key = normalizeKey(syncKeyRaw);
    const state = await storage.getMigrationState(key);
    const complete = isMigrationComplete(state);
    return {
      gate: decideMigrationGate({
        complete,
        d1Status: d1StatusByKey.get(key),
        hasEvidence: await hasEvidenceFor(key, state),
      }),
      complete,
      d1Status: d1StatusByKey.get(key),
      mergeSource: state.mergeSource,
      lastError: state.lastError,
      state,
    };
  };

  return {
    ensure,
    joinFamily,
    legacyJoin,
    transitionTick,
    migrationGate,
    peekGate,
    getD1Status: syncKey => d1StatusByKey.get(normalizeKey(syncKey)),
    getSummary,
    subscribe(listener) {
      listeners.push(listener);
      return () => { listeners = listeners.filter(candidate => candidate !== listener); };
    },
    dispose() {
      Object.keys(retryTimers).forEach(key => {
        const handle = retryTimers[key];
        if (handle !== undefined) stopTimer(handle);
        retryTimers[key] = undefined;
      });
      runnerUnsubscribe?.();
      runnerUnsubscribe = null;
      subscribedRunner = null;
      listeners = [];
    },
  };
}

