// 기기 프로세스 쪽 가짜 Firebase SDK입니다(07 설계 5.1). loader.mjs가 `src/database/firestoreImport.ts`와
// `src/database/firebase.ts`에서 온 `firebase/firestore`, `firebase/auth`, `firebase/app` import만 이 파일로 보냅니다.
// 그래서 실제 firestoreImport.ts와 firebase.ts 코드가 그대로 돌고, 상태는 서버 프로세스(stubs/fake-firestore-state.mjs)가
// 갖고 HTTP(`/__fs/rpc`)로 공유합니다. 세 SDK의 이름을 한 파일에 모았으므로 이름이 겹치면 안 됩니다.
//
// 앱 코드가 쓰는 API만 내보냅니다. 캐시를 허용하는 getDoc/getDocs는 일부러 없습니다. 앱이 그것을 쓰게 바뀌면
// 불러오는 순간 실패해 눈에 띕니다(07 5.3 "캐시 허용 읽기" 변이). deleteDoc과 writeBatch는 불변 조건 2 점검이
// 기록할 수 있도록 있습니다(앱은 쓰지 않습니다).
//
// 익명 uid는 저장 파일 옆의 `<저장 파일>-fbauth.json`에 둬서 재시작해도 유지됩니다(진짜 앱의 로그인 저장과 같음).
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEVICE = process.env.HARNESS_DEVICE_NAME || 'device';
const SERVER = process.env.HARNESS_WORKER_URL;
const STORAGE_FILE = process.env.HARNESS_STORAGE_FILE;
const UID_FILE = STORAGE_FILE ? STORAGE_FILE.replace(/\.json$/, '') + '-fbauth.json' : null;

// ────────────── 전송 ──────────────
async function rpc(body) {
  if (!SERVER) throw new Error('가짜 Firestore: HARNESS_WORKER_URL 이 필요합니다');
  const response = await fetch(`${SERVER}/__fs/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: DEVICE, actor: 'app', ...body }),
  });
  const json = await response.json();
  if (json.hang) return new Promise(() => {}); // 끝나지 않는 호출
  if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code, name: 'FirebaseError' });
  return json;
}

// ────────────── 값 ──────────────
export class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  static now() { return Timestamp.fromMillis(Date.now()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
}
class ServerTimestamp {}
export const serverTimestamp = () => new ServerTimestamp();
const encode = (v) => {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (v instanceof ServerTimestamp) return { __serverTs: true };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, encode(x)]));
  }
  return v;
};
const decode = (v) => {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (typeof v.__ts === 'number') return Timestamp.fromMillis(v.__ts);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
};

// ────────────── firebase/app ──────────────
let appInstance = null;
export const getApps = () => (appInstance ? [appInstance] : []);
export const getApp = () => { if (!appInstance) throw new Error('No Firebase App has been created'); return appInstance; };
export const initializeApp = (options) => { appInstance = { name: '[DEFAULT]', options }; return appInstance; };

// ────────────── firebase/auth ──────────────
export const browserLocalPersistence = { type: 'LOCAL' };
export const indexedDBLocalPersistence = { type: 'INDEXEDDB' };
export const getReactNativePersistence = (storage) => ({ type: 'REACT_NATIVE', storage });

let memoryUid = null;
const readUid = () => {
  if (!UID_FILE) return memoryUid;
  try { return existsSync(UID_FILE) ? JSON.parse(readFileSync(UID_FILE, 'utf8')).uid : null; } catch { return null; }
};
const writeUid = (uid) => {
  memoryUid = uid;
  if (!UID_FILE) return;
  if (uid === null) rmSync(UID_FILE, { force: true });
  else writeFileSync(UID_FILE, JSON.stringify({ uid }));
};
let authInstance = null;
const makeAuth = (app) => {
  const uid = readUid();
  authInstance = { app, currentUser: uid ? { uid, isAnonymous: true } : null, async authStateReady() {} };
  return authInstance;
};
export const initializeAuth = (app) => authInstance ?? makeAuth(app);
export const getAuth = (app) => authInstance ?? makeAuth(app);
export const signInAnonymously = async (auth) => {
  const uid = auth.currentUser?.uid ?? `anon-${DEVICE}-${randomBytes(4).toString('hex')}`;
  await rpc({ op: 'auth', uid });
  writeUid(uid);
  auth.currentUser = { uid, isAnonymous: true };
  return { user: auth.currentUser };
};

// ────────────── firebase/firestore ──────────────
let instanceSeq = 0;
let currentDb = null;
const newDb = (app) => {
  currentDb = { type: 'firestore', app, _id: `${DEVICE}:${process.pid}:${(instanceSeq += 1)}` };
  return currentDb;
};
export const initializeFirestore = (app) => {
  // 진짜 SDK처럼, 닫히지 않은 인스턴스가 있는데 다시 만들면 오류입니다. terminate 뒤에는 다시 만들 수 있습니다.
  if (currentDb && !currentDb._terminated) throw new Error('Firestore has already been started and its settings can no longer be changed.');
  return newDb(app);
};
export const getFirestore = (app) => currentDb ?? newDb(app);
export const terminate = async (db) => {
  db._terminated = true;
  await rpc({ op: 'terminate', instance: db._id });
};

class DocRef { constructor(db, path) { this.type = 'document'; this.firestore = db; this.path = path; this.id = path.split('/').at(-1); } }
class CollRef { constructor(db, path) { this.type = 'collection'; this.firestore = db; this.path = path; this.id = path.split('/').at(-1); } }
const dbOf = (parent) => (parent.type === 'firestore' ? parent : parent.firestore);
const pathOf = (parent, segments) => [parent.type === 'firestore' ? '' : parent.path, ...segments].filter(Boolean).join('/');
export const doc = (parent, ...segments) => new DocRef(dbOf(parent), pathOf(parent, segments));
export const collection = (parent, ...segments) => new CollRef(dbOf(parent), pathOf(parent, segments));

const DOC_ID = { __documentId: true };
export const documentId = () => DOC_ID;
export const orderBy = (field) => ({ t: 'orderBy', field });
export const startAfter = (value) => ({ t: 'startAfter', value: typeof value === 'string' ? value : value?.id });
export const limit = (n) => ({ t: 'limit', n });
export const where = (field, cmp, value) => ({ t: 'where', field, cmp, value: encode(value) });
export const query = (source, ...constraints) => ({ type: 'query', firestore: source.firestore, path: source.path, constraints: [...(source.constraints || []), ...constraints] });

const snapshotOf = (id, data) => ({ id, exists: () => data !== null && data !== undefined, data: () => (data ? decode(data) : undefined) });
const base = (db) => ({ instance: db._id, uid: authInstance?.currentUser?.uid ?? null });

export const getDocFromServer = async (ref) => {
  const res = await rpc({ ...base(ref.firestore), op: 'get', path: ref.path });
  return snapshotOf(res.id, res.exists ? res.data : null);
};

export const getDocsFromServer = async (q) => {
  const constraints = q.constraints || [];
  const spec = { where: constraints.filter((c) => c.t === 'where'), orderBy: constraints.find((c) => c.t === 'orderBy')?.field === DOC_ID ? '__name__' : undefined };
  const after = constraints.find((c) => c.t === 'startAfter');
  if (after) spec.startAfter = after.value;
  const lim = constraints.find((c) => c.t === 'limit');
  if (lim) spec.limit = lim.n;
  const res = await rpc({ ...base(q.firestore), op: 'list', path: q.path, query: spec });
  const snaps = res.docs.map((d) => snapshotOf(d.id, d.data));
  return { docs: snaps, size: snaps.length, empty: snaps.length === 0, forEach: (fn) => snaps.forEach(fn) };
};

export const setDoc = async (ref, data, options) =>
  void (await rpc({ ...base(ref.firestore), op: 'set', path: ref.path, data: encode(data), merge: !!options?.merge }));

export const deleteDoc = async (ref) => void (await rpc({ ...base(ref.firestore), op: 'delete', path: ref.path }));

export const writeBatch = (db) => {
  const steps = [];
  return {
    set(ref, data, options) { steps.push(() => setDoc(ref, data, options)); return this; },
    delete(ref) { steps.push(() => deleteDoc(ref)); return this; },
    async commit() { for (const step of steps) await step(); },
  };
};

// ────────────── 하네스 전용 조작(앱 코드는 쓰지 않음) ──────────────
export const harnessAuth = {
  getUid: () => readUid(),
  /** 익명 uid를 바꿉니다(앱을 지웠다 다시 설치했거나 로그인 저장이 사라진 경우). null이면 다음 로그인이 새 uid를 만듭니다. */
  setUid(uid) {
    writeUid(uid ?? null);
    if (authInstance) authInstance.currentUser = uid ? { uid, isAnonymous: true } : null;
    return readUid();
  },
  currentDbId: () => currentDb?._id ?? null,
};
