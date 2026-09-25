import * as Crypto from 'expo-crypto';
import { signInAnonymously } from 'firebase/auth';
import {
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDocFromServer as getDoc,
  getDocsFromServer as getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { BabyLogEntry, BabyProfile } from '../types';
import {
  backupLocalData,
  FamilySyncLedger,
  readSyncLedger,
  saveSyncedDataWithoutLoss,
  writeSyncLedger,
} from './storage';
import { auth, db } from './firebase';
import { readLegacyCloud } from './legacySync';

const SYNC_INVITE_PREFIX = 'babycheck://family/';
const SHARED_PROFILE_KEYS = ['name', 'birthDate', 'birthWeight', 'targetFormula'] as const;
const LEGACY_READ_BUDGET_MS = 1_500;
// 규칙 평가와 배치 한도에 여유를 두기 위해 한 번에 보내는 쓰기 수를 줄였습니다.
const WRITE_CHUNK_SIZE = 100;
/**
 * 증분 읽기만 계속하면 어떤 이유로든 놓친 문서가 영영 안 들어옵니다. 이 간격마다
 * 한 번은 기록 전체를 대조해 증분 경로의 실수를 스스로 복구합니다.
 */
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const readyFamilyIds = new Set<string>();
type FamilyConnection = Awaited<ReturnType<typeof createFamilyConnection>>;
const familySetupPromises = new Map<string, Promise<FamilyConnection>>();

/**
 * React Native 에는 브라우저의 온라인/오프라인 이벤트가 없어서 Firestore 가
 * 네트워크가 돌아온 것을 스스로 알아채지 못합니다. 와이파이↔LTE 전환이나 절전
 * 이후에 실시간 수신이 조용히 멈추는 원인이라, 앱이 앞으로 나올 때 연결을
 * 한 번 끊었다 다시 붙여 백오프 타이머를 초기화합니다.
 */
export const refreshCloudConnection = async (): Promise<void> => {
  try {
    await disableNetwork(db);
    await enableNetwork(db);
  } catch (error) {
    console.warn('Firestore reconnect failed', error);
  }
};

export const createFamilySyncId = (): string => Crypto.randomUUID().replace(/-/g, '');

export const createFamilyInviteLink = (syncId: string): string =>
  `${SYNC_INVITE_PREFIX}${syncId.trim()}`;

export const parseFamilySyncId = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const fromLink = trimmed.match(/^babycheck:\/\/family\/([a-zA-Z0-9_-]+)$/i)?.[1];
  const key = fromLink || trimmed;
  return /^[a-zA-Z0-9_-]+$/.test(key) ? key : null;
};

const digest = (value: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);

const getFamilyCredentials = async (syncKey: string) => ({
  familyId: await digest(`babycheck:family:v2:${syncKey}`),
  inviteHash: await digest(`babycheck:invite:v2:${syncKey}`),
});

const ensureUser = async () => {
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  return (await signInAnonymously(auth)).user;
};

const createFamilyConnection = async (syncKey: string, allowFamilyCreation: boolean) => {
  const user = await ensureUser();
  const credentials = await getFamilyCredentials(syncKey);
  const familyRef = doc(db, 'families', credentials.familyId);
  const memberRef = doc(familyRef, 'members', user.uid);
  const membershipKey = `${credentials.familyId}:${user.uid}`;

  if (readyFamilyIds.has(membershipKey)) {
    return { ...credentials, familyRef, user };
  }

  try {
    const membership = await getDoc(memberRef);
    if (membership.exists()) {
      readyFamilyIds.add(membershipKey);
      return { ...credentials, familyRef, user };
    }
  } catch {
    // A non-member cannot read membership documents; continue with invite claim.
  }

  if (allowFamilyCreation) {
    // 새 가족 만들기에서만 가족 문서를 생성합니다. 초대 가입 경로가 잘못된
    // 문자열로 별도 가족을 만드는 사고를 막기 위해 두 경로를 분리합니다.
    try {
      await setDoc(familyRef, {
        inviteHash: credentials.inviteHash,
        schemaVersion: 3,
        createdAt: serverTimestamp(),
      });
    } catch {
      // 이미 존재하면 아래 membership create가 초대 해시를 검증합니다.
    }
  }

  try {
    await setDoc(memberRef, {
      inviteHash: credentials.inviteHash,
      joinedAt: serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'permission-denied') {
      // 초대 키가 애초에 잘못됐거나, 이미 연결돼 있던 가족이 다른 기기에서
      // 영구 삭제됐거나 — 서버 쪽에서는 두 경우를 구분할 수 없습니다. 호출한
      // 쪽(App.tsx)이 "이 기기가 이미 이 키로 연결돼 있었는지"를 알고 있으므로,
      // family-unavailable 코드로 표시해 그쪽에서 구분하게 합니다.
      throw Object.assign(
        new Error('가족 연결 키가 서버의 초대 정보와 일치하지 않거나, 가족 데이터가 삭제되었습니다. 초대 링크를 다시 받아 주세요.'),
        { code: 'family-unavailable' },
      );
    }
    throw error;
  }

  readyFamilyIds.add(membershipKey);

  return { ...credentials, familyRef, user };
};

const ensureFamilyMembership = async (
  syncKey: string,
  allowFamilyCreation = true,
): Promise<FamilyConnection> => {
  const setupKey = `${allowFamilyCreation ? 'create' : 'join'}:${syncKey}`;
  const existing = familySetupPromises.get(setupKey);
  if (existing) return existing;
  const setup = createFamilyConnection(syncKey, allowFamilyCreation);
  familySetupPromises.set(setupKey, setup);
  try {
    return await setup;
  } finally {
    familySetupPromises.delete(setupKey);
  }
};

/**
 * Firestore 는 문서 필드를 이름순으로 돌려주므로, 앱에서 만든 객체와 키 순서가
 * 달라집니다. 순서를 맞춰 비교하지 않으면 내용이 같은데도 매번 다르다고 판단해
 * 같은 기록을 끝없이 다시 올리게 됩니다.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((sorted, key) => {
            const field = (item as Record<string, unknown>)[key];
            if (field !== undefined) sorted[key] = field;
            return sorted;
          }, {})
      : item,
  );

/**
 * 시간이 초과되어 호출한 쪽이 이미 손을 뗀 동기화를 표시합니다. 버려진 동기화가
 * 뒤늦게 깨어나 예전 스냅샷으로 기기 저장소를 덮어쓰면, 그 사이에 적은 기록이
 * 사라지고 지운 기록이 되살아납니다.
 */
export interface SyncAbortToken { aborted: boolean }

/** 공유 프로필의 최신 여부는 공유 항목이 바뀐 시각으로만 판단합니다. */
const sharedStamp = (profile: Partial<BabyProfile> | null | undefined): number =>
  (typeof profile?.sharedUpdatedAt === 'number' ? profile.sharedUpdatedAt : undefined)
  ?? (typeof profile?.updatedAt === 'number' ? profile.updatedAt : 0);

/** 가족이 공유하는 항목만 뽑아 비교용으로 씁니다. */
const sharedFieldsOf = (profile: Partial<BabyProfile>) => ({
  name: profile.name,
  birthDate: profile.birthDate,
  birthWeight: profile.birthWeight,
  targetFormula: profile.targetFormula,
});

const cleanSharedProfile = (profile: BabyProfile) => ({
  name: profile.name,
  birthDate: profile.birthDate,
  birthWeight: profile.birthWeight,
  targetFormula: profile.targetFormula,
  sharedUpdatedAt: sharedStamp(profile),
  // 예전 버전 앱은 이 값만 봅니다. 그 앱은 기록을 지우기만 해도 자기 시각을
  // 올리므로, 여기에 우리의 느린 시각을 그대로 쓰면 새 버전이 항상 집니다.
  updatedAt: Date.now(),
});

const mergeLogs = (localLogs: BabyLogEntry[], remoteLogs: BabyLogEntry[], deletedIds: Set<string>) => {
  const byId = new Map<string, BabyLogEntry>();
  [...localLogs, ...remoteLogs].forEach(log => {
    if (!log || deletedIds.has(log.id)) return;
    const current = byId.get(log.id);
    const candidateUpdated = log.updatedAt || log.timestamp;
    const currentUpdated = current?.updatedAt || current?.timestamp || 0;
    const candidateTieBreaker = canonical(log);
    const currentTieBreaker = current ? canonical(current) : '';
    if (!current || candidateUpdated > currentUpdated ||
      (candidateUpdated === currentUpdated && candidateTieBreaker > currentTieBreaker)) {
      byId.set(log.id, log);
    }
  });
  return Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
};

type PlannedLogWrite =
  | { kind: 'upsert'; log: BabyLogEntry }
  | { kind: 'delete'; id: string };

/**
 * 읽은 뒤 쓰기까지 다른 기기가 끼어들어도 오래된 payload가 최신 값을 덮지 않도록
 * 실제 쓰기 시점의 문서를 transaction 안에서 다시 비교합니다.
 */
interface CommitOutcome {
  /** 서버에 실제로 반영한 기록 id. */
  settled: Set<string>;
  /** 서버가 이미 우리보다 최신이라 올리지 못한 기록 id. */
  superseded: Set<string>;
  /** 서버에 삭제 표시가 확정된 기록 id. */
  tombstoned: Set<string>;
  written: number;
}

const commitLogChangesSafely = async (
  logsPath: ReturnType<typeof collection>,
  familyRef: FamilyConnection['familyRef'],
  planned: PlannedLogWrite[],
  userId: string,
  abortToken?: SyncAbortToken,
): Promise<CommitOutcome> => {
  const outcome: CommitOutcome = {
    settled: new Set(),
    superseded: new Set(),
    tombstoned: new Set(),
    written: 0,
  };
  for (let offset = 0; offset < planned.length; offset += WRITE_CHUNK_SIZE) {
    if (abortToken?.aborted) break;
    const chunk = planned.slice(offset, offset + WRITE_CHUNK_SIZE);
    // transaction 은 충돌하면 콜백을 통째로 재실행합니다. 이전 시도의 판정이
    // 남아 있으면 실제로는 밀린 기록을 "올렸다"고 장부에 적게 되므로, 판정은
    // 시도마다 비우고 커밋이 끝난 뒤에만 결과에 합칩니다.
    let attempt = { settled: [] as string[], superseded: [] as string[], tombstoned: [] as string[] };
    outcome.written += await runTransaction(db, async transaction => {
      attempt = { settled: [], superseded: [], tombstoned: [] };
      const refs = chunk.map(item => doc(logsPath, item.kind === 'delete' ? item.id : item.log.id));
      const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
      if (abortToken?.aborted) return 0;
      let chunkWritten = 0;
      chunk.forEach((item, index) => {
        const snapshot = snapshots[index];
        const current = snapshot.data() as Record<string, unknown> | undefined;
        if (item.kind === 'delete') {
          attempt.tombstoned.push(item.id);
          if (current?.deleted === true) return;
          transaction.set(refs[index], {
            deleted: true,
            deletedAt: serverTimestamp(),
            // 증분 읽기는 updatedAt 만 봅니다. 삭제 표시에도 같은 필드를 남기지
            // 않으면 상대 기기가 "지웠다"는 사실을 영영 받지 못합니다.
            updatedAt: serverTimestamp(),
            updatedBy: userId,
          }, { merge: true });
          chunkWritten += 1;
          return;
        }
        if (current?.deleted === true) {
          attempt.tombstoned.push(item.log.id);
          return;
        }
        const remotePayload = current?.payload as BabyLogEntry | undefined;
        const localUpdated = item.log.updatedAt || item.log.timestamp || 0;
        const remoteUpdated = remotePayload?.updatedAt || remotePayload?.timestamp || 0;
        const identical = !!remotePayload && canonical(item.log) === canonical(remotePayload);
        const localWins = !remotePayload
          || localUpdated > remoteUpdated
          || (localUpdated === remoteUpdated && canonical(item.log) > canonical(remotePayload));
        if (identical) {
          // 서버에 이미 같은 내용이 있습니다. 올릴 것은 없지만 "올라가 있다"는
          // 사실은 확정이므로 장부에 적어 다음 회차에서 다시 보내지 않습니다.
          attempt.settled.push(item.log.id);
          return;
        }
        if (!localWins) {
          attempt.superseded.push(item.log.id);
          return;
        }
        transaction.set(refs[index], {
          payload: item.log,
          deleted: false,
          updatedAt: serverTimestamp(),
          updatedBy: userId,
        });
        attempt.settled.push(item.log.id);
        chunkWritten += 1;
      });
      if (chunkWritten > 0) {
        transaction.set(familyRef, {
          schemaVersion: 3,
          lastChangedAt: serverTimestamp(),
          lastChangedBy: userId,
        }, { merge: true });
      }
      return chunkWritten;
    });
    attempt.settled.forEach(id => outcome.settled.add(id));
    attempt.superseded.forEach(id => outcome.superseded.add(id));
    attempt.tombstoned.forEach(id => outcome.tombstoned.add(id));
  }
  return outcome;
};

const readLegacyWithinBudget = async (syncKey: string) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readLegacyCloud(syncKey),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), LEGACY_READ_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

/**
 * 기록 전체를 내려받지 않고 "가족에 바뀐 게 있는지"만 문서 1개 읽기로 확인합니다.
 * 주기적 확인이 무료 등급의 하루 읽기 한도를 태우지 않게 하는 장치입니다.
 */
export const readFamilyChangeToken = async (syncKey: string): Promise<string | null> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetchToken = async (): Promise<string | null> => {
      // 90초마다 도는 변경 확인은 순수한 읽기여야 합니다. 여기서 가족 생성을
      // 허용하면 오타나 깨진 키로도 빈 가족 문서가 계속 만들어집니다.
      const { familyRef } = await ensureFamilyMembership(normalizedKey, false);
      const snapshot = await getDoc(familyRef);
      const data = snapshot.data() as { lastChangedAt?: { toMillis?: () => number }; lastChangedBy?: string } | undefined;
      const changedAt = typeof data?.lastChangedAt?.toMillis === 'function' ? data.lastChangedAt.toMillis() : 0;
      return `${changedAt}:${data?.lastChangedBy || ''}`;
    };
    return await Promise.race([
      fetchToken(),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), 8_000);
      }),
    ]);
  } catch (error) {
    console.warn('Family change check failed', error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** 원인을 알아볼 수 있게 Firestore 오류 코드를 우리말로 바꿔 줍니다. */
const describeSyncError = (error: unknown): string => {
  const code = (error as { code?: string })?.code;
  if (code === 'resource-exhausted') {
    return '오늘 사용할 수 있는 서버 저장 횟수를 모두 썼습니다. 기록은 휴대폰에 안전하게 있으며, 한도가 초기화되면 자동으로 올라갑니다.';
  }
  if (code === 'permission-denied') {
    return '서버가 이 기기의 접근을 거부했습니다. 가족 연결을 다시 확인해 주세요.';
  }
  if (code === 'unavailable') {
    return '서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.';
  }
  return error instanceof Error ? error.message : String(error);
};

export const syncWithCloud = async (
  syncKey: string,
  localLogs: BabyLogEntry[],
  localProfile: BabyProfile,
  createBackup = true,
  abortToken?: SyncAbortToken,
  allowFamilyCreation = true,
  /** 당겨서 새로고침처럼 사용자가 명시적으로 요청한 경우 증분을 건너뛰고 전체를 대조합니다. */
  forceFullRead = false,
): Promise<{
  logs: BabyLogEntry[]; profile: BabyProfile; success: boolean; merged: boolean; error?: string;
  /** 가족이 존재하지 않습니다(초대 키 오류 또는 다른 기기의 영구 삭제). 호출한
   * 쪽이 "이미 이 키로 연결돼 있었는지" 문맥을 갖고 있을 때만 후자로 해석해야 합니다. */
  familyUnavailable?: boolean;
}> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { logs: localLogs, profile: localProfile, success: false, merged: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }

  // 병합 결과를 기기에 먼저 저장하므로, 업로드가 실패하더라도 화면에는 저장소와
  // 같은 값을 돌려줘야 합니다. 그렇지 않으면 보이는 기록과 저장된 기록이 어긋납니다.
  let persisted: { logs: BabyLogEntry[]; profile: BabyProfile } | null = null;

  try {
    if (createBackup) await backupLocalData();
    const { familyRef, user } = await ensureFamilyMembership(normalizedKey, allowFamilyCreation);
    const logsRef = collection(familyRef, 'logs');
    const profileRef = doc(familyRef, 'profile', 'shared');

    // 기록이 수백·수천 개가 되면 동기화 한 번이 그만큼의 읽기를 씁니다. 기록을
    // 하나 남길 때마다 전체를 다시 읽으면 무료 등급의 하루 읽기 한도가 며칠도 못
    // 가고, 한도가 끝나는 순간 두 사람 모두 동기화가 멈춥니다. 지난번 이후 서버에서
    // 바뀐 문서만 받아옵니다.
    const ledger = await readSyncLedger(normalizedKey);
    const canUseDelta = !forceFullRead
      && !!ledger
      && ledger.cursorMillis > 0
      && Date.now() - ledger.lastFullReadAt < FULL_RECONCILE_INTERVAL_MS;
    // 같은 밀리초에 쓰인 문서를 놓치지 않도록 경계는 포함해서 읽습니다. 이미 가진
    // 문서 몇 개를 다시 읽는 비용이, 남의 기록을 영영 못 받는 것보다 쌉니다.
    const logsSource = canUseDelta && ledger
      ? query(logsRef, where('updatedAt', '>=', Timestamp.fromMillis(ledger.cursorMillis)))
      : logsRef;
    const [remoteLogSnapshot, remoteProfileSnapshot, legacyData] = await Promise.all([
      getDocs(logsSource),
      getDoc(profileRef),
      // 구 버전 서버는 마이그레이션 보조 수단입니다. 응답이 늦어도 현재
      // Firebase 동기화와 화면 완료를 막지 않도록 짧은 시간만 기다립니다.
      // 새 초대 링크는 Firebase 전용입니다. 초대 비밀값을 구 서버로 보내지 않습니다.
      /^[a-f0-9]{32}$/i.test(normalizedKey) ? Promise.resolve(null) : readLegacyWithinBudget(normalizedKey),
    ]);

    const remoteLogs: BabyLogEntry[] = [];
    const remoteById = new Map<string, Record<string, unknown>>();
    const deletedIds = new Set(localProfile.deletedLogIds || []);
    // 다음 증분 읽기의 시작점입니다. 기기 시계가 아니라 서버가 찍은 시각만 씁니다.
    let observedCursorMillis = canUseDelta && ledger ? ledger.cursorMillis : 0;
    remoteLogSnapshot.forEach(snapshot => {
      const data = snapshot.data() as Record<string, unknown>;
      remoteById.set(snapshot.id, data);
      const stamp = data.updatedAt as { toMillis?: () => number } | number | undefined;
      const stampMillis = typeof stamp === 'number'
        ? stamp
        : typeof stamp?.toMillis === 'function' ? stamp.toMillis() : 0;
      if (stampMillis > observedCursorMillis) observedCursorMillis = stampMillis;
      if (data.deleted === true) {
        deletedIds.add(snapshot.id);
      } else if (data.payload && typeof data.payload === 'object') {
        remoteLogs.push(data.payload as BabyLogEntry);
      }
    });

    if (legacyData?.profile?.deletedLogIds) {
      legacyData.profile.deletedLogIds.forEach(id => deletedIds.add(id));
    }
    let mergedLogs = mergeLogs(
      localLogs,
      [...remoteLogs, ...(legacyData?.logs || [])],
      deletedIds,
    );
    let mergedProfile: BabyProfile = {
      ...localProfile,
      deletedLogIds: Array.from(deletedIds),
      syncKey: normalizedKey,
    };

    const remoteShared = remoteProfileSnapshot.exists()
      ? remoteProfileSnapshot.data() as Partial<BabyProfile>
      : null;
    const remoteSharedKey = remoteShared ? canonical(sharedFieldsOf(remoteShared)) : null;
    // 두 기기가 같은 밀리초에 프로필을 고치면 시각만으로는 승자를 정할 수 없어
    // 양쪽 다 상대를 채택하지 않고 영영 갈라집니다. 내용으로 승자를 확정합니다.
    const remoteWins = remoteShared !== null && (
      sharedStamp(remoteShared) > sharedStamp(localProfile)
      || (sharedStamp(remoteShared) === sharedStamp(localProfile)
        && (remoteSharedKey as string) > canonical(sharedFieldsOf(localProfile)))
    );
    if (remoteWins && remoteShared) {
      SHARED_PROFILE_KEYS.forEach(key => {
        const value = remoteShared[key];
        if (value !== undefined) (mergedProfile as any)[key] = value;
      });
      mergedProfile.sharedUpdatedAt = sharedStamp(remoteShared);
    }
    // 구 버전 저장소는 Firebase 에 공유 프로필이 아직 없을 때만 씁니다. 두 곳이
    // 서로를 덮어쓰며 이름·생일이 오락가락하는 것을 막기 위해서입니다.
    if (!remoteShared && legacyData?.profile
      && sharedStamp(legacyData.profile) > sharedStamp(mergedProfile)) {
      SHARED_PROFILE_KEYS.forEach(key => {
        const value = legacyData.profile?.[key];
        if (value !== undefined) (mergedProfile as any)[key] = value;
      });
      mergedProfile.sharedUpdatedAt = sharedStamp(legacyData.profile);
    }

    // 호출한 쪽이 이미 포기했다면 여기서 멈춥니다. 지금 저장하면 그 사이에
    // 생긴 최신 기록을 예전 스냅샷으로 덮어쓰게 됩니다.
    if (abortToken?.aborted) {
      return { logs: localLogs, profile: localProfile, success: false, merged: false, error: '동기화가 시간 초과로 중단되었습니다.' };
    }

    // 네트워크를 기다리는 동안 사용자가 새 기록을 남겼을 수 있습니다. 저장 직전에
    // 현재 로컬 값을 다시 병합하고, 로컬 기록 쓰기와 같은 큐에서 원자적으로 반영합니다.
    const safelySaved = await saveSyncedDataWithoutLoss(
      mergedLogs,
      mergedProfile,
      localProfile.syncKey || null,
      abortToken,
    );
    if (!safelySaved.success) {
      throw new Error('기기에 병합 결과를 저장하지 못했습니다.');
    }
    mergedLogs = safelySaved.logs;
    mergedProfile = safelySaved.profile;
    persisted = { logs: mergedLogs, profile: mergedProfile };
    const changedLocally = canonical(mergedLogs) !== canonical(localLogs)
      || canonical(mergedProfile) !== canonical(localProfile);

    const uploadedLedger = canUseDelta && ledger ? ledger.uploaded : {};
    const tombstonedLedger = new Set(canUseDelta && ledger ? ledger.tombstoned : []);

    const writes: PlannedLogWrite[] = [];
    mergedLogs.forEach(log => {
      const remote = remoteById.get(log.id);
      const localUpdated = log.updatedAt || log.timestamp;
      const remotePayload = remote?.payload as BabyLogEntry | undefined;
      const remoteUpdated = remotePayload?.updatedAt || remotePayload?.timestamp || 0;
      // 이미 삭제 표시된 문서는 되살리지 않습니다. 되살리는 쓰기는 보안 규칙이
      // 거부하고, 거부되면 배치 전체가 실패해 그 회차 업로드가 통째로 날아갑니다.
      if (remote?.deleted === true) return;
      if (remote) {
        if (localUpdated > remoteUpdated
          || (localUpdated === remoteUpdated && canonical(log) !== canonical(remotePayload))) {
          writes.push({ kind: 'upsert', log });
        }
        return;
      }
      // 여기부터는 이번 읽기에 안 보인 기록입니다. 전체를 읽었다면 서버에 정말
      // 없다는 뜻이지만, 증분만 읽었다면 "안 바뀌었을 뿐"일 수 있습니다. 그것을
      // 구분하지 않으면 동기화마다 기록 전체를 다시 올려 쓰기 한도를 태웁니다.
      if (!canUseDelta || uploadedLedger[log.id] !== localUpdated) {
        writes.push({ kind: 'upsert', log });
      }
    });
    (mergedProfile.deletedLogIds || []).forEach(id => {
      if (remoteById.get(id)?.deleted === true) return;
      // 증분 읽기에서는 예전에 올린 삭제 표시가 응답에 없는 것이 정상입니다.
      if (canUseDelta && !remoteById.has(id) && tombstonedLedger.has(id)) return;
      writes.push({ kind: 'delete', id });
    });
    if (abortToken?.aborted) {
      return { logs: mergedLogs, profile: mergedProfile, success: false, merged: changedLocally, error: '동기화가 시간 초과로 중단되었습니다.' };
    }
    const commitOutcome = await commitLogChangesSafely(logsRef, familyRef, writes, user.uid, abortToken);

    if (!abortToken?.aborted) {
      const mergedById = new Map(mergedLogs.map(log => [log.id, log] as const));
      // 전체를 읽었다면 서버 상태를 온전히 알고 있으므로 장부를 새로 씁니다.
      // 증분이었다면 이번에 확인한 것만 기존 장부에 더합니다.
      const nextUploaded: Record<string, number> = canUseDelta ? { ...uploadedLedger } : {};
      remoteById.forEach((data, id) => {
        if (data.deleted === true) return;
        const payload = data.payload as BabyLogEntry | undefined;
        const local = mergedById.get(id);
        if (!payload || !local) return;
        if (canonical(payload) === canonical(local)) nextUploaded[id] = local.updatedAt || local.timestamp;
      });
      commitOutcome.settled.forEach(id => {
        const local = mergedById.get(id);
        if (local) nextUploaded[id] = local.updatedAt || local.timestamp;
      });
      // 서버가 우리보다 최신이라 못 올린 기록은 "올렸다"고 적으면 안 됩니다.
      commitOutcome.superseded.forEach(id => { delete nextUploaded[id]; });

      const nextTombstoned = new Set(tombstonedLedger);
      commitOutcome.tombstoned.forEach(id => nextTombstoned.add(id));
      remoteById.forEach((data, id) => { if (data.deleted === true) nextTombstoned.add(id); });

      await writeSyncLedger({
        familyKey: normalizedKey,
        cursorMillis: observedCursorMillis,
        // 서버가 더 최신인 기록이 남아 있으면 다음 회차에 전체를 대조해 받아옵니다.
        lastFullReadAt: commitOutcome.superseded.size > 0
          ? 0
          : canUseDelta && ledger ? ledger.lastFullReadAt : Date.now(),
        uploaded: nextUploaded,
        tombstoned: Array.from(nextTombstoned),
      } satisfies FamilySyncLedger, mergedById.keys());
    }

    const localShared = cleanSharedProfile(mergedProfile);
    // 내용이 이미 같으면 올리지 않습니다. 불필요한 쓰기는 상대 기기를 깨우고
    // 무료 등급의 하루 쓰기 한도를 갉아먹습니다.
    const hasRealProfile = sharedStamp(mergedProfile) > 0;
    if ((!remoteShared && hasRealProfile)
      || (remoteShared && canonical(sharedFieldsOf(mergedProfile)) !== remoteSharedKey)) {
      await runTransaction(db, async transaction => {
        const latestSnapshot = await transaction.get(profileRef);
        const latest = latestSnapshot.exists()
          ? latestSnapshot.data() as Partial<BabyProfile>
          : null;
        const latestKey = latest ? canonical(sharedFieldsOf(latest)) : '';
        const localKey = canonical(sharedFieldsOf(mergedProfile));
        const localWins = !latest
          || sharedStamp(mergedProfile) > sharedStamp(latest)
          || (sharedStamp(mergedProfile) === sharedStamp(latest) && localKey > latestKey);
        if (!localWins || abortToken?.aborted) return false;
        transaction.set(profileRef, {
          ...localShared,
          serverUpdatedAt: serverTimestamp(),
          updatedBy: user.uid,
        });
        transaction.set(familyRef, {
          schemaVersion: 3,
          lastChangedAt: serverTimestamp(),
          lastChangedBy: user.uid,
        }, { merge: true });
        return true;
      });
    }

    if (abortToken?.aborted) throw new Error('동기화가 중단되었습니다. 다시 시도해 주세요.');

    return { logs: mergedLogs, profile: mergedProfile, success: true, merged: changedLocally };
  } catch (error) {
    console.error('Firebase sync failed', error);
    return {
      logs: persisted?.logs || localLogs,
      profile: persisted?.profile || localProfile,
      success: false,
      merged: persisted !== null,
      error: describeSyncError(error),
      familyUnavailable: (error as { code?: string })?.code === 'family-unavailable',
    };
  }
};

/** 삭제를 예약한 뒤 실제로 지울 수 있게 되기까지의 냉각 기간. firestore.rules의
 * duration.value(50, 'm') 보다 여유 있게 잡아, 시계가 조금 어긋나도 규칙에서
 * 거부되지 않게 합니다. */
const FAMILY_DELETION_GRACE_MS = 60 * 60 * 1000;

export interface FamilyDeletionStatus {
  /** 삭제가 예약돼 있는지. */
  scheduled: boolean;
  /** 예약돼 있다면, 실제 삭제가 가능해지는 시각(ms). */
  readyAt?: number;
  /** 예약 시각이 지나 지금 바로 삭제를 실행할 수 있는지. */
  canDeleteNow: boolean;
  error?: string;
}

/** 가족 서버 데이터 영구 삭제 예약 상태를 확인합니다. */
export const getFamilyDeletionStatus = async (syncKey: string): Promise<FamilyDeletionStatus> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { scheduled: false, canDeleteNow: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  try {
    const { familyRef } = await ensureFamilyMembership(normalizedKey, false);
    const snapshot = await getDoc(familyRef);
    const data = snapshot.data() as { pendingDeletionAt?: { toMillis?: () => number } } | undefined;
    const readyAt = typeof data?.pendingDeletionAt?.toMillis === 'function'
      ? data.pendingDeletionAt.toMillis()
      : undefined;
    if (!readyAt) return { scheduled: false, canDeleteNow: false };
    return { scheduled: true, readyAt, canDeleteNow: Date.now() >= readyAt };
  } catch (error) {
    return { scheduled: false, canDeleteNow: false, error: describeSyncError(error) };
  }
};

/**
 * 가족 서버 데이터 영구 삭제를 예약합니다. 바로 지우지 않고, 냉각 기간이
 * 지난 뒤에야 deleteFamilyCloudData 가 실제로 지울 수 있게 됩니다.
 * 그 전까지는 cancelFamilyDeletion 으로 취소할 수 있습니다.
 */
export const scheduleFamilyDeletion = async (
  syncKey: string,
): Promise<{ success: boolean; readyAt?: number; error?: string }> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { success: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  try {
    const { familyRef } = await ensureFamilyMembership(normalizedKey, false);
    const readyAt = Date.now() + FAMILY_DELETION_GRACE_MS;
    await setDoc(familyRef, { pendingDeletionAt: Timestamp.fromMillis(readyAt) }, { merge: true });
    return { success: true, readyAt };
  } catch (error) {
    return { success: false, error: describeSyncError(error) };
  }
};

/** 예약된 가족 서버 데이터 영구 삭제를 취소합니다. */
export const cancelFamilyDeletion = async (
  syncKey: string,
): Promise<{ success: boolean; error?: string }> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { success: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  try {
    const { familyRef } = await ensureFamilyMembership(normalizedKey, false);
    await setDoc(familyRef, { pendingDeletionAt: null }, { merge: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: describeSyncError(error) };
  }
};

/**
 * 가족의 서버 데이터(기록·회원·공유 프로필·가족 문서)를 영구히 지웁니다.
 * 냉각 기간이 지나 firestore.rules 가 실제 delete를 허용하는 경우에만
 * 성공합니다(scheduleFamilyDeletion 을 먼저 호출해야 함). 되돌릴 수 없고,
 * 같은 가족 키를 쓰는 상대방의 기록도 함께 지워지므로 반드시 사용자의
 * 명시적인 확인을 거친 뒤에만 호출해야 합니다. 이 기기의 로컬 기록에는
 * 손대지 않습니다.
 */
export const deleteFamilyCloudData = async (
  syncKey: string,
): Promise<{ success: boolean; error?: string; partiallyDeleted?: boolean }> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) {
    return { success: false, error: '가족 연결 키가 올바르지 않습니다.' };
  }
  let deletedChunks = 0;
  let totalChunks = 0;
  try {
    // 존재하지 않는 가족을 새로 만들면서 지우는 사고를 막기 위해 생성은 허용하지 않습니다.
    const { familyRef, user } = await ensureFamilyMembership(normalizedKey, false);
    const logsRef = collection(familyRef, 'logs');
    const membersRef = collection(familyRef, 'members');
    const profileRef = doc(familyRef, 'profile', 'shared');

    const logIds: string[] = [];
    (await getDocs(logsRef)).forEach(snapshot => logIds.push(snapshot.id));
    const memberIds: string[] = [];
    (await getDocs(membersRef)).forEach(snapshot => memberIds.push(snapshot.id));

    // 삭제는 여러 배치로 나뉘어 순차 커밋되므로 도중에(예: 기록이 많아 여러
    // 청크로 나뉠 때) 절대 원자적이지 않습니다. 로그를 먼저 지우고 회원 문서를
    // 나중에 지우면, 그 사이 짧은 시간 동안 다른 기기는 여전히 isMember라서
    // "안 올라간 것으로 보이는" 이미 지워진 기록을 평소 동기화로 다시
    // 올려버릴 수 있습니다(영구 삭제가 조용히 무효화됨). 그래서 내 회원 문서를
    // 제외한 다른 회원의 문서부터 가장 먼저 지워 다른 기기의 접근을 즉시
    // 끊고, 그다음 기록·프로필을 지우고, 마지막으로 내 회원 문서와 가족
    // 문서를 지웁니다(내 회원 문서를 먼저 지우면 이후 로그 삭제 자체가
    // firestore.rules의 isMember 검사에서 거부됩니다).
    const otherMemberIds = memberIds.filter(id => id !== user.uid);
    const orderedRefsToDelete = [
      ...otherMemberIds.map(id => doc(membersRef, id)),
      ...logIds.map(id => doc(logsRef, id)),
      profileRef,
      ...(memberIds.includes(user.uid) ? [doc(membersRef, user.uid)] : []),
      familyRef,
    ];

    totalChunks = Math.max(1, Math.ceil(orderedRefsToDelete.length / WRITE_CHUNK_SIZE));
    for (let offset = 0; offset < orderedRefsToDelete.length; offset += WRITE_CHUNK_SIZE) {
      const batch = writeBatch(db);
      orderedRefsToDelete.slice(offset, offset + WRITE_CHUNK_SIZE).forEach(ref => batch.delete(ref));
      await batch.commit();
      deletedChunks += 1;
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: describeSyncError(error),
      // 일부 배치는 이미 커밋된 뒤 실패했다면, 삭제가 부분적으로 이미
      // 일어났다는 사실을 숨기지 않고 호출한 쪽에 알립니다.
      partiallyDeleted: deletedChunks > 0 && deletedChunks < totalChunks,
    };
  }
};

export const subscribeToCloudChanges = async (
  syncKey: string,
  onChange: () => void,
  onError: (error: Error) => void,
): Promise<() => void> => {
  const normalizedKey = parseFamilySyncId(syncKey);
  if (!normalizedKey) throw new Error('가족 연결 키가 올바르지 않습니다.');
  // 이미 연결된 가족을 대상으로 하는 구독이므로, 다른 배경 동기화 경로와 마찬가지로
  // allowFamilyCreation은 false여야 합니다. 기본값(true)을 그대로 두면, 다른 기기가
  // 가족 서버 데이터를 영구 삭제한 뒤 이 기기가 재구독할 때 가족을 조용히
  // 되살리고 로컬 기록을 재업로드하게 됩니다.
  const { familyRef, user } = await ensureFamilyMembership(normalizedKey, false);
  let initialSnapshot = true;
  return onSnapshot(familyRef, snapshot => {
    if (initialSnapshot) {
      initialSnapshot = false;
      return;
    }
    // 내가 방금 올린 변경이 되돌아온 것이라면 다시 동기화할 필요가 없습니다.
    if (snapshot.data()?.lastChangedBy === user.uid) return;
    onChange();
  }, error => onError(error));
};
