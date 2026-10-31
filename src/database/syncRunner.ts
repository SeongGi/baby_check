// 동기화 러너: App이 하던 대기열, 합치기, 상한, 상한 뒤 판정, 이어 가기를 화면과
// 떼어 낸 모듈입니다. 하네스가 실제 코드를 그대로 실행하도록 `react`,
// `react-native`, `expo-*`를 불러오지 않습니다. 저장소와 동기화 함수는 인자로 받습니다.
import type { BabyLogEntry, BabyProfile } from '../types';
import { withSyncDeadline } from './syncDeadline';
import { decideAfterSync, DEFAULT_ERROR_MESSAGE, DISCONNECTED_MESSAGE } from './syncDecision';
import type { syncWithCloud as SyncWithCloudFn } from './sync';

export interface SyncRequest {
  syncKey: string;
  createBackup?: boolean;
  allowFamilyCreation?: boolean;
  connecting?: boolean;
  forceFullRead?: boolean;
}

export type SyncRunResult = Awaited<ReturnType<typeof SyncWithCloudFn>>;

/**
 * 모든 사건에 가족 키와 요청 번호를 싣습니다(07 2.3 "사건 식별"). 번호는 러너가 요청을 받을 때 1씩
 * 늘려 매기고, 이어 가기 회차는 부모 요청의 번호를 물려받으며, 합쳐진 평소 요청은 처음 받은 요청의 번호를 씁니다.
 * 다만 이어 가기 요청이 대기 중인 요청에 합쳐질 때는 대기 요청의 번호를 둘 중 큰 값으로 올립니다(부모가 먼저 실행됐으므로
 * 대기 요청은 항상 부모 뒤에 실행됩니다).
 */
export type SyncRunnerEvent = { syncKey: string; requestId: number } & (
  | { type: 'started' }
  | { type: 'succeeded'; result: SyncRunResult; continuation: boolean; notice?: string }
  | { type: 'failed'; error: string; result?: SyncRunResult }
  | { type: 'disconnected'; profile: BabyProfile; logs: BabyLogEntry[] }
  | { type: 'detached' }
  /** 관문이 이전 준비 중으로 막아 D1에 요청하지 않았습니다. */
  | { type: 'migrationPending' }
  /**
   * 회차 시작 전에 가족 키가 맞지 않아 D1에 요청하지 않고 끝냈습니다(`Sync is not connected`). `failed`처럼 오류로
   * 보이지 않아야 하므로 따로 둡니다. 이전 모듈이 7단계 요청의 끝을 알기 위해 구독합니다(화면은 무시합니다).
   */
  | { type: 'dropped' }
);

export type MigrationGateDecision = 'proceed' | 'paused';

export interface SyncRunnerDeps {
  syncWithCloud: typeof SyncWithCloudFn;
  getLogs(): Promise<BabyLogEntry[]>;
  getProfile(): Promise<BabyProfile>;
  saveProfile(profile: BabyProfile): Promise<boolean>;
  /** 앞서 시작한 저장이 모두 끝난 뒤의 프로필(2.6.3) */
  readProfileAfterPendingWrites(): Promise<BabyProfile>;
  /** 한 회차의 상한. App은 20초입니다. */
  timeoutMs: number;
  /** 화면 반영은 App이 합니다. 첫 구독자로 등록됩니다. */
  onEvent(event: SyncRunnerEvent): void;
  /**
   * 평소 요청을 실행하기 전에 부릅니다(07 2.3). 없으면 관문 없이 지금처럼 돕니다.
   * 연결 회차(`connecting: true`)는 거치지 않습니다. `'paused'`면 D1에 요청하지 않고
   * `{ success: false, migrationPending: true }`를 돌려줍니다. 저장소와 메모리만 읽고 곧바로 답해야 합니다.
   */
  migrationGate?(syncKey: string): Promise<MigrationGateDecision>;
}

export interface SyncRunner {
  /** `onAccepted`는 요청을 받는 즉시(대기열에 들어가기 전에) 요청 번호를 알려 줍니다. 합쳐진 요청은 처음 요청의 번호입니다. */
  request(request: SyncRequest, options?: { onAccepted?(requestId: number): void }): Promise<SyncRunResult>;
  subscribe(listener: (event: SyncRunnerEvent) => void): () => void;
  abortActive(): void;
}

/** 연속으로 이어 가는 회차의 상한입니다. 그 뒤에는 다음 저장이나 폴링이 이어 갑니다. */
export const MAX_CONTINUATIONS = 30;

const TIMEOUT_MESSAGE = '서버 응답을 기다리고 있어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.';

/**
 * 평소 동기화만 합칩니다. 백업, 가족 만들기, 합류, 전체 새로고침은 각각 의미가
 * 달라서 합치지 않습니다(2.8).
 */
export const isCoalescibleSync = (request: SyncRequest): boolean =>
  !request.createBackup && !request.allowFamilyCreation && !request.connecting && !request.forceFullRead;

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  // 자동 동기화, 당겨서 새로고침, 저장 직후 업로드가 겹치지 않도록 한 줄로 실행합니다.
  let queue: Promise<void> = Promise.resolve();
  let isRunning = false;
  // 대기 중인 동기화는 반드시 가족 키별로 따로 보관합니다. 하나로 합치면 가족을
  // 바꾼 직후의 요청이 이전 가족의 결과를 돌려받습니다.
  // `requestId`는 이어 가기 요청이 합쳐질 때 올라갈 수 있어서, 대기 요청의 회차도 같은 객체에서 번호를 읽습니다.
  const pendingByKey = new Map<string, { promise: Promise<SyncRunResult>; requestId: number }>();
  let activeAbort: { aborted: boolean } | null = null;
  let continuations = 0;
  let requestCounter = 0;

  // 생성 인자 onEvent가 첫 구독자입니다. 구독자 하나의 오류가 러너와 다른 구독자를 멈추지 않게 가둡니다.
  const listeners = new Set<(event: SyncRunnerEvent) => void>([deps.onEvent]);
  const emit = (event: SyncRunnerEvent): void => {
    Array.from(listeners).forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error('[syncRunner] 사건 구독자에서 오류가 났습니다.', error);
      }
    });
  };

  const enqueue = (
    req: SyncRequest,
    continuation: boolean,
    parentRequestId?: number,
    onAccepted?: (requestId: number) => void,
  ): Promise<SyncRunResult> => {
    // 번호는 요청을 받을 때마다 늘립니다. 이어 가기 회차는 부모 번호를 씁니다.
    const received = ++requestCounter;
    let requestId = continuation && parentRequestId !== undefined ? parentRequestId : received;
    const normalizedKey = req.syncKey.trim();
    const {
      createBackup = false,
      allowFamilyCreation = false,
      connecting = false,
      forceFullRead = false,
    } = req;

    const coalescible = isCoalescibleSync({ ...req, syncKey: normalizedKey });
    if (coalescible && isRunning) {
      const alreadyPending = pendingByKey.get(normalizedKey);
      if (alreadyPending) {
        // 합쳐진 평소 요청은 처음 받은 요청의 번호를 씁니다. 다만 이어 가기 요청이 합쳐질 때는 대기 요청의 번호를
        // 부모 번호(요청 번호)까지 올립니다. 올리지 않으면 7단계 요청(번호가 큼) 뒤의 이어 가기가 더 작은 번호의 대기
        // 요청에 합쳐져 그 사슬의 사건이 7단계 번호보다 작아지고 이전 모듈이 사건을 버립니다. 이어 가기가 아닌
        // 새 요청은 올리지 않습니다: 대기 요청은 그 사이에 들어온 7단계 요청보다 앞서 실행될 수 있어서, 올리면 아직
        // 올리지 않은 업로드를 끝낸 것으로 오인합니다.
        if (continuation && requestId > alreadyPending.requestId) alreadyPending.requestId = requestId;
        requestId = alreadyPending.requestId;
        onAccepted?.(requestId);
        return alreadyPending.promise;
      }
    }
    onAccepted?.(requestId);

    let resolveVisible!: (result: SyncRunResult) => void;
    let rejectVisible!: (error: unknown) => void;
    const visibleResult = new Promise<SyncRunResult>((resolve, reject) => {
      resolveVisible = resolve;
      rejectVisible = reject;
    });

    // 사건에 싣는 번호는 이 객체에서 읽습니다. 대기 중에 이어 가기 요청이 합쳐지면 번호가 올라갑니다.
    const ticket = { promise: visibleResult, requestId };
    if (coalescible && isRunning) {
      pendingByKey.set(normalizedKey, ticket);
    }

    const run = async (): Promise<void> => {
      isRunning = true;
      if (pendingByKey.get(normalizedKey)?.promise === visibleResult) {
        pendingByKey.delete(normalizedKey);
      }

      // 2. 회차 시작 전 키 확인
      const currentLogs = await deps.getLogs();
      const currentProfile = await deps.getProfile();
      if ((!connecting && currentProfile.syncKey !== normalizedKey)
        || (connecting && currentProfile.syncKey && currentProfile.syncKey !== normalizedKey)) {
        emit({ type: 'dropped', syncKey: normalizedKey, requestId: ticket.requestId });
        resolveVisible({
          logs: currentLogs,
          profile: currentProfile,
          success: false,
          merged: false,
          error: 'Sync is not connected',
        });
        isRunning = false;
        return;
      }

      // 이전 준비 중인 가족은 D1에 요청하지 않습니다. 연결 회차는 관문을 거치지 않습니다(07 2.3).
      if (deps.migrationGate && !connecting) {
        let gate: MigrationGateDecision = 'proceed';
        try {
          gate = await deps.migrationGate(normalizedKey);
        } catch (error) {
          // 관문은 저장소와 메모리만 읽습니다. 읽지 못해도 기록은 줄지 않으므로 평소처럼 진행합니다.
          console.warn('[syncRunner] 이전 관문을 읽지 못해 평소처럼 진행합니다.', error);
        }
        if (gate === 'paused') {
          emit({ type: 'migrationPending', syncKey: normalizedKey, requestId: ticket.requestId });
          resolveVisible({
            logs: currentLogs,
            profile: currentProfile,
            success: false,
            merged: false,
            migrationPending: true,
          });
          isRunning = false;
          return;
        }
      }

      emit({ type: 'started', syncKey: normalizedKey, requestId: ticket.requestId });
      const abortToken = { aborted: false };
      activeAbort = abortToken;
      // 서버 응답이 오지 않아도 화면이 멈추지 않도록 상한을 둡니다. 상한이 없으면
      // 새로고침 표시가 영영 돌고, 뒤에 줄 서 있는 다음 동기화까지 모두 막힙니다.
      const startedAt = Date.now();
      const operation = deps.syncWithCloud(
        normalizedKey,
        currentLogs,
        currentProfile,
        createBackup,
        abortToken,
        allowFamilyCreation,
        forceFullRead,
        startedAt,
      );
      let continueSync = false;
      try {
        // 3. 상한 걸기
        let timedOut = false;
        const result = await withSyncDeadline<SyncRunResult>(operation, abortToken, () => {
          timedOut = true;
          return {
            logs: currentLogs,
            profile: currentProfile,
            success: false,
            merged: false,
            error: TIMEOUT_MESSAGE,
          };
        }, deps.timeoutMs);

        // 연결 회차는 실패한 경우에도 저장소에 키가 실제로 남았는지로 판정합니다(2.6.3).
        // 평소 회차에는 읽기가 늘지 않습니다.
        let storedKeyMatches = false;
        if (connecting && (!result.success || timedOut) && !result.familyUnavailable && !result.familyNotFound) {
          const stored = await deps.readProfileAfterPendingWrites();
          storedKeyMatches = stored.syncKey === normalizedKey;
        }

        // 4. 서버를 기다리는 동안 추가한 기록을 화면에서도 보존합니다.
        const latestProfile = await deps.getProfile();
        const latestLogs = await deps.getLogs();
        result.logs = latestLogs;
        result.profile = latestProfile;

        // 사용자가 그 사이에 가족 연결을 해제했거나 다른 가족으로 바꾼 경우,
        // 이전 가족의 늦은 실패 결과가 에러 배너를 다시 띄우지 않도록 정리합니다.
        const isCurrentFamily = connecting
          ? (latestProfile.syncKey === normalizedKey || !latestProfile.syncKey)
          : (latestProfile.syncKey === normalizedKey);
        if (!isCurrentFamily) {
          // 연결 해제는 `detached`, 다른 가족으로 바뀐 경우는 `dropped`로 알립니다(둘 다 화면 표시가 필요 없는 끝맺음).
          emit({ type: latestProfile.syncKey ? 'dropped' : 'detached', syncKey: normalizedKey, requestId: ticket.requestId });
          resolveVisible({ ...result, success: false, merged: false, error: '가족 연결이 해제되었거나 변경되었습니다.' });
          return;
        }

        // 상한으로 중단된 연결 회차는 사용자가 연결을 해제한 것이 아니므로 아래 판정에서 실패로 처리합니다.
        if (abortToken.aborted && !timedOut && !latestProfile.syncKey) {
          emit({ type: 'detached', syncKey: normalizedKey, requestId: ticket.requestId });
          resolveVisible({ ...result, success: false, merged: false, error: '가족 연결이 해제되었습니다.' });
          return;
        }

        // 5. 결과 판정
        const decision = decideAfterSync(result, { connecting, timedOut, storedKeyMatches });

        if (decision.action === 'disconnect') {
          // 410: 다른 기기가 가족 서버 데이터를 영구 삭제했습니다. 이 기기도 로컬 연결을
          // 끊어 둡니다. 이 기기에 저장된 기록 자체는 지우지 않습니다.
          await deps.saveProfile({ ...latestProfile, syncKey: undefined });
          const disconnectedProfile = await deps.getProfile();
          emit({ type: 'disconnected', syncKey: normalizedKey, requestId: ticket.requestId, profile: disconnectedProfile, logs: latestLogs });
          resolveVisible({
            ...result,
            logs: latestLogs,
            profile: disconnectedProfile,
            success: false,
            merged: false,
            error: decision.error || DISCONNECTED_MESSAGE,
          });
          return;
        }

        if (decision.action === 'success') {
          const finalResult: SyncRunResult = decision.recovered
            // 첫 저장으로 키가 이미 저장소에 있으므로 연결은 확정이고, 남은 일은 이어 가기가 처리합니다.
            ? { ...result, success: true, error: undefined, continuing: true, progressed: true }
            : result;
          continueSync = decision.continueSync;
          emit({ type: 'succeeded', syncKey: normalizedKey, requestId: ticket.requestId, result: finalResult, continuation, notice: decision.notice });
          resolveVisible(finalResult);
        } else {
          // 연결 도중 410: 첫 저장으로 키가 남았더라도 삭제된 가족이므로 지웁니다. 기록은 지우지 않습니다.
          let failedProfile = latestProfile;
          if (connecting && result.familyUnavailable && latestProfile.syncKey === normalizedKey) {
            await deps.saveProfile({ ...latestProfile, syncKey: undefined });
            failedProfile = await deps.getProfile();
          }
          emit({ type: 'failed', syncKey: normalizedKey, requestId: ticket.requestId, error: decision.error || DEFAULT_ERROR_MESSAGE, result });
          resolveVisible({ ...result, profile: failedProfile, error: decision.error });
        }
        // 취소 토큰을 저장 큐와 transaction에서 검사하므로 늦은 응답을 버리고
        // 다음 시도를 허용합니다. 응답 없는 네트워크가 대기열을 잠그지 않습니다.
        void operation.catch(() => undefined);
      } catch (error) {
        const latest = await deps.getProfile().catch(() => null);
        if (abortToken.aborted && (!latest?.syncKey || latest.syncKey !== normalizedKey)) {
          emit({ type: 'detached', syncKey: normalizedKey, requestId: ticket.requestId });
        } else {
          emit({
            type: 'failed',
            syncKey: normalizedKey,
            requestId: ticket.requestId,
            error: error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE,
          });
        }
        rejectVisible(error);
      } finally {
        // 6. 이어 가기: 같은 키의 평소 동기화를 하나 더 요청합니다. 아직 실행 중으로 표시된
        // 상태에서 요청해야 합치기 대상(대기 중인 다음 회차)이 되어 대기열이 늘지 않습니다.
        // 진전이 없는 회차는 continueSync가 거짓이라 여기까지 오지 않습니다.
        if (continueSync && continuations < MAX_CONTINUATIONS) {
          continuations += 1;
          enqueue({ syncKey: normalizedKey }, true, ticket.requestId).catch(() => undefined);
        } else {
          continuations = 0;
        }
        isRunning = false;
        if (activeAbort === abortToken) activeAbort = null;
      }
    };
    const queued = queue.catch(() => undefined).then(run);
    queue = queued.then(() => undefined, () => undefined);
    return visibleResult;
  };

  return {
    request: (req, options) => enqueue(req, false, undefined, options?.onAccepted),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    abortActive() {
      if (activeAbort) activeAbort.aborted = true;
    },
  };
}
