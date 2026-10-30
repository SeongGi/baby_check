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

export type SyncRunnerEvent =
  | { type: 'started' }
  | { type: 'succeeded'; result: SyncRunResult; continuation: boolean; notice?: string }
  | { type: 'failed'; error: string; result?: SyncRunResult }
  | { type: 'disconnected'; profile: BabyProfile; logs: BabyLogEntry[] }
  | { type: 'detached' };

export interface SyncRunnerDeps {
  syncWithCloud: typeof SyncWithCloudFn;
  getLogs(): Promise<BabyLogEntry[]>;
  getProfile(): Promise<BabyProfile>;
  saveProfile(profile: BabyProfile): Promise<boolean>;
  /** 앞서 시작한 저장이 모두 끝난 뒤의 프로필(2.6.3) */
  readProfileAfterPendingWrites(): Promise<BabyProfile>;
  /** 한 회차의 상한. App은 20초입니다. */
  timeoutMs: number;
  /** 화면 반영은 App이 합니다. */
  onEvent(event: SyncRunnerEvent): void;
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

export function createSyncRunner(deps: SyncRunnerDeps): {
  request(request: SyncRequest): Promise<SyncRunResult>;
  abortActive(): void;
} {
  // 자동 동기화, 당겨서 새로고침, 저장 직후 업로드가 겹치지 않도록 한 줄로 실행합니다.
  let queue: Promise<void> = Promise.resolve();
  let isRunning = false;
  // 대기 중인 동기화는 반드시 가족 키별로 따로 보관합니다. 하나로 합치면 가족을
  // 바꾼 직후의 요청이 이전 가족의 결과를 돌려받습니다.
  const pendingByKey = new Map<string, Promise<SyncRunResult>>();
  let activeAbort: { aborted: boolean } | null = null;
  let continuations = 0;

  const enqueue = (req: SyncRequest, continuation: boolean): Promise<SyncRunResult> => {
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
      if (alreadyPending) return alreadyPending;
    }

    let resolveVisible!: (result: SyncRunResult) => void;
    let rejectVisible!: (error: unknown) => void;
    const visibleResult = new Promise<SyncRunResult>((resolve, reject) => {
      resolveVisible = resolve;
      rejectVisible = reject;
    });

    if (coalescible && isRunning) {
      pendingByKey.set(normalizedKey, visibleResult);
    }

    const run = async (): Promise<void> => {
      isRunning = true;
      if (pendingByKey.get(normalizedKey) === visibleResult) {
        pendingByKey.delete(normalizedKey);
      }

      // 2. 회차 시작 전 키 확인
      const currentLogs = await deps.getLogs();
      const currentProfile = await deps.getProfile();
      if ((!connecting && currentProfile.syncKey !== normalizedKey)
        || (connecting && currentProfile.syncKey && currentProfile.syncKey !== normalizedKey)) {
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
      deps.onEvent({ type: 'started' });
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
          if (!latestProfile.syncKey) deps.onEvent({ type: 'detached' });
          resolveVisible({ ...result, success: false, merged: false, error: '가족 연결이 해제되었거나 변경되었습니다.' });
          return;
        }

        // 상한으로 중단된 연결 회차는 사용자가 연결을 해제한 것이 아니므로 아래 판정에서 실패로 처리합니다.
        if (abortToken.aborted && !timedOut && !latestProfile.syncKey) {
          deps.onEvent({ type: 'detached' });
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
          deps.onEvent({ type: 'disconnected', profile: disconnectedProfile, logs: latestLogs });
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
          deps.onEvent({ type: 'succeeded', result: finalResult, continuation, notice: decision.notice });
          resolveVisible(finalResult);
        } else {
          // 연결 도중 410: 첫 저장으로 키가 남았더라도 삭제된 가족이므로 지웁니다. 기록은 지우지 않습니다.
          let failedProfile = latestProfile;
          if (connecting && result.familyUnavailable && latestProfile.syncKey === normalizedKey) {
            await deps.saveProfile({ ...latestProfile, syncKey: undefined });
            failedProfile = await deps.getProfile();
          }
          deps.onEvent({ type: 'failed', error: decision.error || DEFAULT_ERROR_MESSAGE, result });
          resolveVisible({ ...result, profile: failedProfile, error: decision.error });
        }
        // 취소 토큰을 저장 큐와 transaction에서 검사하므로 늦은 응답을 버리고
        // 다음 시도를 허용합니다. 응답 없는 네트워크가 대기열을 잠그지 않습니다.
        void operation.catch(() => undefined);
      } catch (error) {
        const latest = await deps.getProfile().catch(() => null);
        if (abortToken.aborted && (!latest?.syncKey || latest.syncKey !== normalizedKey)) {
          deps.onEvent({ type: 'detached' });
        } else {
          deps.onEvent({
            type: 'failed',
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
          enqueue({ syncKey: normalizedKey }, true).catch(() => undefined);
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
    request: req => enqueue(req, false),
    abortActive() {
      if (activeAbort) activeAbort.aborted = true;
    },
  };
}
