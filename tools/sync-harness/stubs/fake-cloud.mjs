// Deterministic failure injection; never contacts Firebase.
export const db = {};
export const auth = { currentUser: { uid: 'test-user' }, async authStateReady() {} };
export const signInAnonymously = async () => ({ user: auth.currentUser });
export const state = { docs: new Map(), commits: [], reads: [], beforeRead: null, beforeTransaction: null, beforeCommit: null, offline: false };
export const doc = (parent, ...parts) => ({ path: [parent.path, ...parts].filter(Boolean).join('/') });
export const collection = doc;
// 서버 시각을 흉내 냅니다. 같은 밀리초에 여러 쓰기가 몰려도 증분 커서가
// 앞으로만 가도록 단조 증가시킵니다.
let clock = 0;
export const serverTimestamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
export const Timestamp = { fromMillis: millis => millis };
export const where = (field, op, value) => ({ field, op, value });
export const query = (ref, ...constraints) => ({ path: ref.path, constraints });
const satisfies = (data, { field, op, value }) => {
  const actual = data?.[field];
  if (actual === undefined) return false;
  if (op === '>=') return actual >= value;
  if (op === '>') return actual > value;
  throw new Error(`fake-cloud: 지원하지 않는 연산자 ${op}`);
};
const snapshot = ref => ({ id: ref.path.split('/').at(-1), exists: () => state.docs.has(ref.path), data: () => state.docs.get(ref.path) });
const online = () => { if (state.offline) throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
export const getDocFromServer = async ref => { online(); return snapshot(ref); };
export const getDocsFromServer = async ref => {
  online();
  if (state.beforeRead) await state.beforeRead();
  const constraints = ref.constraints || [];
  const docs = [...state.docs.keys()]
    .filter(key => key.startsWith(`${ref.path}/`))
    .filter(key => constraints.every(c => satisfies(state.docs.get(key), c)))
    .map(path => snapshot({ path }));
  // 이 회차가 실제로 몇 개 문서를 읽었는지. 증분 동기화의 핵심 효과라 세어 둡니다.
  state.reads.push({ path: ref.path, constraints, count: docs.length });
  return { forEach: fn => docs.forEach(fn) };
};
export const setDoc = async (ref, value, options) => {
  online();
  state.docs.set(ref.path, { ...(options?.merge ? state.docs.get(ref.path) : {}), ...value });
};
export const runTransaction = async (_db, fn) => {
  online();
  // 읽기와 커밋 사이에 다른 기기가 끼어드는 상황을 재현하는 자리입니다.
  if (state.beforeTransaction) await state.beforeTransaction();
  const writes = [];
  const result = await fn({ get: async ref => snapshot(ref), set: (ref, value, options) => writes.push({ ref, value, options }) });
  if (state.beforeCommit) await state.beforeCommit(writes);
  for (const { ref, value, options } of writes) await setDoc(ref, value, options);
  if (writes.length) state.commits.push(writes);
  return result;
};
export const writeBatch = () => {
  const ops = [];
  return {
    delete: ref => ops.push(ref),
    async commit() {
      online();
      ops.forEach(ref => state.docs.delete(ref.path));
    },
  };
};
export const onSnapshot = () => () => {};
export const disableNetwork = async () => {};
export const enableNetwork = async () => {};
