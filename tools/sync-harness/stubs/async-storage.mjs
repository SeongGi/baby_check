import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// 기기별로 분리된 파일에 저장해 두 프로세스가 서로 다른 휴대폰처럼 동작합니다.
const FILE = process.env.HARNESS_STORAGE_FILE;
const load = () => (FILE && existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {});
const save = (data) => { if (FILE) writeFileSync(FILE, JSON.stringify(data, null, 2)); };

let mem = load();

const AsyncStorage = {
  async getItem(key) { mem = load(); return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null; },
  async setItem(key, value) { mem = load(); mem[key] = value; save(mem); },
  async removeItem(key) { mem = load(); delete mem[key]; save(mem); },
  async multiSet(pairs) { mem = load(); pairs.forEach(([k, v]) => { mem[k] = v; }); save(mem); },
  async clear() { mem = {}; save(mem); },
};

export default AsyncStorage;
