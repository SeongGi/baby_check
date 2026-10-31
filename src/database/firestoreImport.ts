// 1.7.9(Firestore) 가족의 기록을 읽어 오는 모듈입니다(07 2.3.1). 1.7.9 코드(`7d4753b` sync.ts)에서
// 회원 가입과 읽기 경로만 옮겨 왔고, Firestore 문서를 지우는 함수는 옮기지 않았습니다(불변 조건 2).
// 앱이 Firestore에 쓰는 것은 회원 문서 생성과 삭제 예약 취소(`pendingDeletionAt: null`) 두 가지뿐입니다.
//
// 이 모듈은 `react`, `react-native`, `expo-*`를 정적으로 불러오지 않습니다. 해시에 쓰는 expo-crypto와
// firebase.ts는 필요할 때 동적 import()로만 불러오므로, 이 모듈을 불러오는 것만으로는 Firebase 앱이 만들어지지 않습니다.
//
// 잠금과 상한은 각 함수가 스스로 걸지 않습니다. 호출하는 쪽(이전 모듈)이 아래처럼 감쌉니다.
//   withFirestoreLock(() => withFirestoreTimeout(() => readLegacyFamilyDoc(key)))
// 같은 Firestore 인스턴스와 익명 로그인을 이전, 합류, 전환기 읽기가 함께 쓰므로 잠금은 모듈에 하나이고,
// 상한에 걸려 인스턴스를 닫아도(terminate) 다른 작업의 호출을 끊지 않도록 한 번에 하나만 돕니다.
// 모든 읽기는 캐시가 아니라 서버에서 읽습니다(getDocFromServer, getDocsFromServer).
import {
  collection,
  doc,
  documentId,
  getDocFromServer,
  getDocsFromServer,
  limit as limitTo,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  Timestamp,
  where,
} from 'firebase/firestore';
import { signInAnonymously } from 'firebase/auth';
import type { BabyLogEntry, BabyProfile } from '../types';

const DEFAULT_TIMEOUT_MS = 15_000;
// terminate가 끝나기를 기다리는 시간. 이 시간이 지나도 상한 오류는 그대로 던집니다.
const RESET_WAIT_MS = 3_000;

export type FirestoreErrorKind = 'denied' | 'quota' | 'timeout' | 'error';

const loadFirebase = () => import('./firebase');

const digest = async (value: string): Promise<string> => {
  const Crypto = await import('expo-crypto');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
};

const importError = (code: FirestoreErrorKind, message: string, cause?: unknown): Error =>
  Object.assign(new Error(message), { code, cause });

/** Firestore 오류 코드나 이 모듈이 던진 분류 코드를 네 가지로 나눕니다. */
export const classifyFirestoreError = (error: unknown): FirestoreErrorKind => {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (code === 'permission-denied' || code === 'denied') return 'denied';
  if (code === 'resource-exhausted' || code === 'quota') return 'quota';
  if (code === 'timeout') return 'timeout';
  return 'error';
};

/**
 * 1.7.9와 같은 해시입니다. Firestore는 키를 대소문자 그대로 해시합니다(D1은 소문자 키 기준이라 따로 만듭니다).
 */
export const firestoreFamilyCredentials = async (
  key: string,
): Promise<{ familyId: string; inviteHash: string }> => ({
  familyId: await digest(`babycheck:family:v2:${key}`),
  inviteHash: await digest(`babycheck:invite:v2:${key}`),
});

// ────────────── 잠금과 상한 ──────────────

let lockTail: Promise<unknown> = Promise.resolve();

/** 모듈 수준 잠금. 한 번에 하나만 실행하고, 앞 작업이 실패해도 다음 작업은 돕니다. */
export const withFirestoreLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = lockTail.catch(() => undefined).then(fn);
  lockTail = run.then(() => undefined, () => undefined);
  return run;
};

/**
 * 호출 하나의 상한. 걸리면 Firestore 인스턴스를 닫고(다음 호출은 새로 만듭니다) `code: 'timeout'` 오류를 던집니다.
 * 늦게 끝난 원래 호출의 결과와 오류는 버립니다.
 */
export const withFirestoreTimeout = async <T>(fn: () => Promise<T>, ms = DEFAULT_TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = fn();
  void operation.catch(() => undefined);
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        try {
          const { resetFirestoreDb } = await loadFirebase();
          await Promise.race([
            resetFirestoreDb(),
            new Promise<void>(resolve => setTimeout(resolve, RESET_WAIT_MS)),
          ]);
        } catch (error) {
          console.warn('[firestoreImport] 상한 뒤 Firestore를 닫지 못했습니다.', error);
        }
        reject(importError('timeout', 'Firestore 응답 시간이 초과되었습니다.'));
      })();
    }, ms);
  });
  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// ────────────── 회원 가입 ──────────────

const openFamily = async (key: string) => {
  const firebase = await loadFirebase();
  const db = firebase.getFirestoreDb();
  const credentials = await firestoreFamilyCredentials(key);
  return { firebase, db, credentials, familyRef: doc(db, 'families', credentials.familyId) };
};

/**
 * 익명 로그인 뒤 `families/<familyId>/members/<uid>`를 서버에서 읽고, 없으면 1.7.9와 같은 필드로 회원 문서를
 * 한 번 만듭니다. 가족 문서는 만들지 않습니다(1.7.9의 allowFamilyCreation=false와 같습니다).
 * 거부, 할당량, 그 밖의 오류는 `code`가 분류된 오류로 던집니다.
 */
export const ensureFirestoreMembership = async (key: string): Promise<'member'> => {
  const { firebase, credentials, familyRef } = await openFamily(key);
  const auth = firebase.getFirebaseAuth();
  let uid: string;
  try {
    await auth.authStateReady();
    uid = (auth.currentUser ?? (await signInAnonymously(auth)).user).uid;
  } catch (error) {
    throw importError(classifyFirestoreError(error), '이전 서버 로그인에 실패했습니다.', error);
  }
  const memberRef = doc(familyRef, 'members', uid);

  try {
    const membership = await getDocFromServer(memberRef);
    if (membership.exists()) return 'member';
  } catch (error) {
    // 비회원의 읽기가 거부될 수 있습니다(1.7.9도 같은 경우 가입을 이어 갔습니다). 그 밖의 오류는 가입해도 실패하므로 멈춥니다.
    if (classifyFirestoreError(error) !== 'denied') {
      throw importError(classifyFirestoreError(error), '이전 서버의 회원 정보를 읽지 못했습니다.', error);
    }
  }

  try {
    await setDoc(memberRef, {
      inviteHash: credentials.inviteHash,
      joinedAt: serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    throw importError(classifyFirestoreError(error), '이전 서버에 회원으로 등록하지 못했습니다.', error);
  }
  return 'member';
};

// ────────────── 읽기 ──────────────

const timestampMillis = (value: unknown): number | null => {
  if (value instanceof Timestamp) return value.toMillis();
  const toMillis = (value as { toMillis?: unknown } | null | undefined)?.toMillis;
  return typeof toMillis === 'function' ? Number((value as Timestamp).toMillis()) : null;
};

export type LegacyFamilyDoc =
  | { exists: false }
  | { exists: true; pendingDeletionAt: number | null; lastChangedAt: number };

/** 가족 문서 하나. `pendingDeletionAt`이 Timestamp일 때만 밀리초이고, null이거나 필드가 없으면 null입니다. */
export const readLegacyFamilyDoc = async (key: string): Promise<LegacyFamilyDoc> => {
  const { familyRef } = await openFamily(key);
  const snapshot = await getDocFromServer(familyRef);
  if (!snapshot.exists()) return { exists: false };
  const data = snapshot.data() as { pendingDeletionAt?: unknown; lastChangedAt?: unknown };
  return {
    exists: true,
    pendingDeletionAt: timestampMillis(data.pendingDeletionAt),
    lastChangedAt: timestampMillis(data.lastChangedAt) ?? 0,
  };
};

export interface LegacyLogsResult {
  logs: BabyLogEntry[];
  deletedIds: string[];
  /** 형식이 어긋나 건너뛴 문서 수 */
  invalidCount: number;
  /** 이 결과에서 마지막으로 본 문서 id(페이지 읽기의 다음 시작점) */
  lastId?: string;
  done: boolean;
}

/**
 * 1.7.9 logs 문서: 기록은 `{ payload, deleted: false, updatedAt, updatedBy }`, 삭제 표식은
 * `{ deleted: true, deletedAt, updatedAt, updatedBy }`입니다. 삭제 표식은 기존 문서에 merge로 쓰이므로
 * payload가 남아 있어도 `deleted: true`가 먼저입니다. payload는 문서 id와 payload.id가 같고,
 * type이 문자열이고, timestamp가 유한한 수일 때만 기록으로 둡니다.
 */
const collectLogs = (
  snapshots: Array<{ id: string; data(): unknown }>,
): Pick<LegacyLogsResult, 'logs' | 'deletedIds' | 'invalidCount'> => {
  const logs: BabyLogEntry[] = [];
  const deletedIds: string[] = [];
  let invalidCount = 0;
  snapshots.forEach(snapshot => {
    const data = snapshot.data() as { deleted?: unknown; payload?: unknown } | undefined;
    if (data?.deleted === true) {
      deletedIds.push(snapshot.id);
      return;
    }
    const payload = data?.payload as Partial<BabyLogEntry> | undefined;
    if (payload && typeof payload === 'object'
      && payload.id === snapshot.id
      && typeof payload.type === 'string'
      && typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)) {
      logs.push(payload as BabyLogEntry);
    } else {
      invalidCount += 1;
    }
  });
  return { logs, deletedIds, invalidCount };
};

/** 문서 id 순서로 `limit`건씩 읽습니다. 받은 건수가 `limit`보다 적으면 끝입니다. */
export const readLegacyLogsPage = async (
  key: string,
  options: { after?: string; limit: number },
): Promise<LegacyLogsResult> => {
  const { familyRef } = await openFamily(key);
  const logsRef = collection(familyRef, 'logs');
  const source = options.after !== undefined
    ? query(logsRef, orderBy(documentId()), startAfter(options.after), limitTo(options.limit))
    : query(logsRef, orderBy(documentId()), limitTo(options.limit));
  const result = await getDocsFromServer(source);
  const snapshots = result.docs;
  return {
    ...collectLogs(snapshots),
    lastId: snapshots.length > 0 ? snapshots[snapshots.length - 1].id : undefined,
    done: snapshots.length < options.limit,
  };
};

/** 전환기용: `updatedAt >= sinceMillis`인 문서 전부(삭제 표식 포함). 경계 문서는 다시 받으므로 합치기가 중복을 처리합니다. */
export const readLegacyLogsUpdatedSince = async (key: string, sinceMillis: number): Promise<LegacyLogsResult> => {
  const { familyRef } = await openFamily(key);
  const result = await getDocsFromServer(
    query(collection(familyRef, 'logs'), where('updatedAt', '>=', Timestamp.fromMillis(sinceMillis))),
  );
  const snapshots = result.docs;
  return {
    ...collectLogs(snapshots),
    lastId: snapshots.length > 0 ? snapshots[snapshots.length - 1].id : undefined,
    done: true,
  };
};

export type LegacySharedProfile = Partial<
  Pick<BabyProfile, 'name' | 'birthDate' | 'birthWeight' | 'targetFormula' | 'sharedUpdatedAt' | 'updatedAt'>
>;

/**
 * `profile/shared`를 1.7.9가 쓰던 형식으로 읽습니다. 필드는 name, birthDate, birthWeight, targetFormula,
 * sharedUpdatedAt, updatedAt(예전 앱은 updatedAt만 씀)이고, 서버 시각 필드(serverUpdatedAt)와 updatedBy는 뺍니다.
 * 형식 검사와 최신 판정은 합치는 쪽(storage의 mergeLegacyFirestoreData)이 합니다. 문서가 없으면 null입니다.
 */
export const readLegacySharedProfile = async (key: string): Promise<LegacySharedProfile | null> => {
  const { familyRef } = await openFamily(key);
  const snapshot = await getDocFromServer(doc(familyRef, 'profile', 'shared'));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as Record<string, unknown>;
  const profile: Record<string, unknown> = {};
  (['name', 'birthDate', 'birthWeight', 'targetFormula', 'sharedUpdatedAt', 'updatedAt'] as const).forEach(field => {
    if (data[field] !== undefined) profile[field] = data[field];
  });
  return profile as LegacySharedProfile;
};

// ────────────── 쓰기(두 가지뿐) ──────────────

/**
 * 1.7.9 삭제 예약의 취소. 1.7.9의 cancelFamilyDeletion과 같이 가족 문서에 `pendingDeletionAt: null`만 merge로 씁니다.
 * 회원이어야 쓸 수 있으므로 호출하기 전에 ensureFirestoreMembership을 거쳐야 합니다
 * (1.7.9는 같은 함수 안에서 ensureFamilyMembership을 불렀습니다).
 */
export const cancelLegacyDeletion = async (key: string): Promise<void> => {
  const { familyRef } = await openFamily(key);
  await setDoc(familyRef, { pendingDeletionAt: null }, { merge: true });
};
