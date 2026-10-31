import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// 기기별로 분리된 파일에 저장해 두 프로세스가 서로 다른 휴대폰처럼 동작합니다.
const FILE = process.env.HARNESS_STORAGE_FILE;
const load = () => (FILE && existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {});
const save = (data) => { if (FILE) writeFileSync(FILE, JSON.stringify(data, null, 2)); };

let mem = load();

// ────────────── 저장 고장 주입(06 설계 2.10) ──────────────
// 저장 도중 앱이 종료되거나 저장이 늦어지는 상황을 흉내 냅니다. 세는 쓰기는 setItem, multiSet,
// removeItem 가운데 감시 키를 하나라도 담은 호출뿐입니다. 기본 감시 키는 기록 키와 새 장부 키라서
// 백업, 프로필만 바꾸는 쓰기, clientId 저장은 "첫 쓰기"에 들어가지 않습니다.
//   mode 'throw': nth번째 쓰기를 파일에 반영한 뒤 예외를 던집니다. 그 뒤의 쓰기는 정상입니다.
//   mode 'exit' : nth번째 쓰기를 반영한 직후 프로세스에 SIGKILL을 보냅니다(앱 강제 종료).
//   mode 'delay': nth번째 쓰기를 파일에 반영하기 전에 멈추고 releaseWrite()가 올 때까지 기다립니다.
//   mode 'reject': nth번째부터 `times`번(기본 1, 'always'는 끝까지) 쓰기를 파일에 반영하지 않고 예외를 던집니다(용량 부족 흉내).
// keys의 항목이 '*'로 끝나면 접두어 일치입니다(예: '@baby_cf_migration_v1:*').
export const DEFAULT_WATCHED_KEYS = ['@baby_logs', '@baby_sync_ledger_cf_v1'];
let fault = null;

export const storageFaults = {
  arm({ mode, nth = 1, keys = DEFAULT_WATCHED_KEYS, times = 1 }) {
    if (!['throw', 'exit', 'delay', 'reject'].includes(mode)) throw new Error(`알 수 없는 저장 고장 mode: ${mode}`);
    fault = {
      mode, nth, count: 0, state: 'armed', open: null, rejected: 0,
      times: times === 'always' ? Infinity : Number(times),
      watches: (key) => keys.some((k) => (k.endsWith('*') ? key.startsWith(k.slice(0, -1)) : k === key)),
    };
    return storageFaults.status();
  },
  disarm() {
    if (fault?.open) fault.open();
    fault = null;
  },
  /** 지연 중인 쓰기를 풀어 줍니다. 지연 중인 쓰기가 없으면 false입니다. */
  releaseWrite() {
    if (!fault?.open) return false;
    fault.open();
    return true;
  },
  status() {
    return fault ? { mode: fault.mode, nth: fault.nth, counted: fault.count, state: fault.state } : { state: 'idle' };
  },
};

// 감시 대상 쓰기면 세고, nth번째이면 mode에 맞게 반응할 준비를 합니다. 반환값은 쓰기 뒤에 할 일입니다.
async function beforeWrite(keys) {
  if (!fault || fault.state !== 'armed' || !keys.some((key) => fault.watches(key))) return null;
  fault.count += 1;
  if (fault.mode === 'reject') {
    if (fault.count < fault.nth) return null;
    fault.rejected += 1;
    if (fault.rejected >= fault.times) fault.state = 'fired';
    throw new Error('harness: 저장 고장 주입(쓰기 거부, 용량 부족 흉내)');
  }
  if (fault.count !== fault.nth) return null;
  const current = fault;
  if (current.mode === 'delay') {
    current.state = 'delayed';
    await new Promise((resolve) => { current.open = resolve; });
    current.state = 'fired';
    current.open = null;
    return null;
  }
  current.state = 'fired';
  return current.mode;
}

function afterWrite(action) {
  if (action === 'throw') throw new Error('harness: 저장 고장 주입(쓰기 뒤 예외)');
  if (action === 'exit') process.kill(process.pid, 'SIGKILL');
}

// 읽기 집계(07 5.2 시나리오 34: 백업 값 같은 큰 값을 다시 읽지 않는지). AsyncStorage를 거친 읽기만 세고,
// 하네스의 rawStorage 읽기는 세지 않습니다.
export const storageStats = {
  reads: {},
  order: [],
  writes: {},
  clear() { this.reads = {}; this.order = []; this.writes = {}; },
};
const noteRead = (key) => {
  storageStats.reads[key] = (storageStats.reads[key] || 0) + 1;
  if (storageStats.order.length < 5000) storageStats.order.push(key);
};
const noteWrite = (keys) => keys.forEach((key) => { storageStats.writes[key] = (storageStats.writes[key] || 0) + 1; });

const AsyncStorage = {
  async getItem(key) { noteRead(key); mem = load(); return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null; },
  async setItem(key, value) {
    const action = await beforeWrite([key]);
    noteWrite([key]);
    mem = load(); mem[key] = value; save(mem);
    afterWrite(action);
  },
  async removeItem(key) {
    const action = await beforeWrite([key]);
    noteWrite([key]);
    mem = load(); delete mem[key]; save(mem);
    afterWrite(action);
  },
  async multiSet(pairs) {
    const action = await beforeWrite(pairs.map(([k]) => k));
    noteWrite(pairs.map(([k]) => k));
    mem = load(); pairs.forEach(([k, v]) => { mem[k] = v; }); save(mem);
    afterWrite(action);
  },
  async clear() { mem = {}; save(mem); },
};

// 고장 주입을 거치지 않는 저장소입니다. 시험이 저장소를 직접 읽고 쓰는 조작에 씁니다.
export const rawStorage = {
  async getItem(key) { const data = load(); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
  async setItem(key, value) { const data = load(); data[key] = value; save(data); mem = data; },
  async removeItem(key) { const data = load(); delete data[key]; save(data); mem = data; },
  async getAll() { return load(); },
};

export default AsyncStorage;
