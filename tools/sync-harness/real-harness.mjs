// 실제 서버 모드의 프로세스 관리 도우미(06 설계 2.10). 시나리오(real-scenarios.mjs)와 회귀가 함께 씁니다.
//
//   const harness = await startRealHarness({ devices: ['A', 'B'] });
//   const { server, devices: { A, B } } = harness;
//   await server.adapter.reset();                       // server-adapter.mjs의 어댑터
//   await A.send('addLog', { log });                     // 기기 명령(device-real.mjs)
//   A.kill(); await A.restart();                         // SIGKILL 뒤 같은 저장 파일로 다시 띄움
//   await selfCheckDevices(harness); await selfCheckMembers(harness, key);
//   await harness.stop();                                // 모든 자식 프로세스 정리
//
// 자식 프로세스는 부모가 끝나는 모든 경로(정상 종료, 예외, 시그널)에서 SIGKILL로 정리하고, 부모가
// SIGKILL로 죽어도 자식이 stdin 종료를 보고 스스로 끝납니다. 자식을 띄울 때 process.argv[1]을 쓰지 않고
// 이 모듈의 위치로 경로를 구합니다.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealAdapter } from './server-adapter.mjs';

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HARNESS_DIR, 'loader.mjs');
const SERVER_SCRIPT = path.join(HARNESS_DIR, 'real-server.mjs');
const DEVICE_SCRIPT = path.join(HARNESS_DIR, 'device.mjs');

export const loaderArgs = () => [
  '--disable-warning=ExperimentalWarning',
  '--import',
  `data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register(${JSON.stringify(`file://${LOADER}`)}, pathToFileURL("./"));`,
];

// ────────────── 자식 프로세스 정리 ──────────────
const children = new Set();
let cleanupInstalled = false;

export function killAllChildren() {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* 이미 끝남 */ }
  }
  children.clear();
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', killAllChildren);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { killAllChildren(); process.exit(130); });
  }
  process.on('uncaughtException', (error) => {
    console.error('[harness] uncaughtException', error);
    killAllChildren();
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    console.error('[harness] unhandledRejection', error);
    killAllChildren();
    process.exit(1);
  });
}

function spawnChild(script, env, label) {
  installCleanup();
  const child = spawn(process.execPath, [...loaderArgs(), script], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdin.on('error', () => undefined);
  child.on('exit', () => children.delete(child));
  child.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => console.log(`  [${label} stderr] ${line}`));
  });
  return child;
}

// 줄 단위로 stdout을 쪼개 줍니다.
function onLines(stream, handler) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) handler(line);
    }
  });
}

// ────────────── 서버 ──────────────
export class RealServer {
  static async start({ maxPushItems, maxPageRows } = {}) {
    const env = {};
    if (maxPushItems !== undefined) env.HARNESS_MAX_PUSH_ITEMS = String(maxPushItems);
    if (maxPageRows !== undefined) env.HARNESS_MAX_PAGE_ROWS = String(maxPageRows);
    const proc = spawnChild(SERVER_SCRIPT, env, 'server');
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('서버가 10초 안에 포트를 알리지 않았습니다')), 10_000);
      proc.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`서버가 시작 전에 끝났습니다 (${code}/${signal})`)); });
      onLines(proc.stdout, (line) => {
        try {
          const message = JSON.parse(line);
          if (message.harness === 'real-server') { clearTimeout(timer); resolve(message.port); }
        } catch { console.log(`  [server stdout] ${line}`); }
      });
    });
    return new RealServer(proc, port);
  }

  constructor(proc, port) {
    this.proc = proc;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.adapter = createRealAdapter((name, body) => this.control(name, body));
  }

  async control(name, body = {}) {
    const response = await fetch(`${this.url}/__harness/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(`제어 ${name} 실패: ${data.error || response.status}`);
    return data;
  }

  async stop() {
    if (this.proc.exitCode === null) {
      const exited = new Promise((resolve) => this.proc.once('exit', resolve));
      this.proc.kill('SIGTERM');
      const timer = setTimeout(() => this.proc.kill('SIGKILL'), 2_000);
      await exited;
      clearTimeout(timer);
    }
  }
}

// ────────────── 기기 ──────────────
export class RealDevice {
  /**
   * @param {{ name: string, serverUrl: string, storageFile?: string, fresh?: boolean, env?: Record<string,string> }} options
   */
  constructor({ name, serverUrl, storageFile, fresh = true, env = {} }) {
    this.name = name;
    this.serverUrl = serverUrl;
    this.storageFile = storageFile || path.join(HARNESS_DIR, `storage-real-${name}.json`);
    this.env = env;
    this.pending = new Map();
    this.seq = 0;
    this.proc = null;
    if (fresh && existsSync(this.storageFile)) rmSync(this.storageFile);
  }

  get alive() { return Boolean(this.proc) && this.proc.exitCode === null && this.proc.signalCode === null; }

  async start() {
    if (this.alive) throw new Error(`${this.name} 기기가 이미 떠 있습니다`);
    const proc = spawnChild(DEVICE_SCRIPT, {
      ...this.env,
      HARNESS_REAL_WORKER: '1',
      HARNESS_WORKER_URL: this.serverUrl,
      HARNESS_STORAGE_FILE: this.storageFile,
      HARNESS_DEVICE_NAME: this.name,
    }, `device ${this.name}`);
    this.proc = proc;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 기기가 20초 안에 준비되지 않았습니다`)), 20_000);
      proc.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`${this.name} 기기가 준비 전에 끝났습니다 (${code}/${signal})`));
      });
      this.onReady = () => { clearTimeout(timer); resolve(); };
    });
    proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.pending.forEach((settle, id) => settle({ id, ok: false, error: `device ${this.name} exited (${code}/${signal})` }));
      this.pending.clear();
    });
    onLines(proc.stdout, (line) => {
      let message;
      try { message = JSON.parse(line); } catch { console.log(`  [${this.name} stdout] ${line}`); return; }
      if (message?.harness === 'device' && message.ready) { this.onReady?.(); return; }
      if (typeof message?.id !== 'number') { console.log(`  [${this.name} stdout] ${line}`); return; }
      const settle = this.pending.get(message.id);
      if (settle) { this.pending.delete(message.id); settle(message); }
    });
    await ready;
    return this;
  }

  /** 명령을 보내고 결과를 기다립니다. 명령은 기기 안에서 동시에 처리되므로 기다리지 않고 여러 개를 보낼 수 있습니다. */
  send(cmd, payload = {}, { timeoutMs = 60_000 } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error(`${this.name} 기기 프로세스가 떠 있지 않습니다 (${cmd})`)); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}.${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.ok) resolve(message.result);
        else reject(new Error(`${this.name}.${cmd}: ${message.error}`));
      });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, payload })}\n`);
    });
  }

  /** SIGKILL로 즉시 끝냅니다(앱 강제 종료). 끝난 것을 확인한 뒤 돌아옵니다. */
  async kill() {
    if (!this.alive) return;
    const exited = new Promise((resolve) => this.proc.once('exit', resolve));
    this.proc.kill('SIGKILL');
    await exited;
  }

  /** 같은 저장 파일로 다시 띄웁니다. 아직 떠 있으면 먼저 SIGKILL합니다. */
  async restart() {
    await this.kill();
    return this.start();
  }

  async quit() {
    if (!this.alive) return;
    const exited = new Promise((resolve) => this.proc.once('exit', resolve));
    await this.send('quit').catch(() => undefined);
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 2_000);
    await exited;
    clearTimeout(timer);
  }
}

// ────────────── 묶음 시작과 자기 검사 ──────────────
/**
 * 서버 하나와 기기 여러 대를 띄웁니다. stop()은 모두 정리합니다.
 * @param {{ devices?: string[], maxPushItems?: number, maxPageRows?: number }} options
 */
export async function startRealHarness({ devices: names = ['A', 'B'], maxPushItems, maxPageRows } = {}) {
  const server = await RealServer.start({ maxPushItems, maxPageRows });
  const devices = {};
  try {
    for (const name of names) {
      devices[name] = await new RealDevice({ name, serverUrl: server.url }).start();
    }
  } catch (error) {
    killAllChildren();
    throw error;
  }
  return {
    server,
    devices,
    async stop() {
      await Promise.all(Object.values(devices).map((d) => d.quit().catch(() => undefined)));
      await server.stop();
      killAllChildren();
    },
  };
}

/** 기기들의 clientId와 저장 파일이 서로 모두 다른지 확인합니다. 하나라도 같으면 예외를 던집니다. */
export async function selfCheckDevices(harness) {
  const infos = [];
  for (const [name, device] of Object.entries(harness.devices)) {
    const info = await device.send('getSyncClientId');
    infos.push({ name, ...info });
  }
  const ids = new Set(infos.map((i) => i.clientId));
  const files = new Set(infos.map((i) => i.storageFile));
  if (ids.size !== infos.length) throw new Error(`자기 검사 실패: 기기 clientId가 겹칩니다 ${JSON.stringify(infos)}`);
  if (files.size !== infos.length) throw new Error(`자기 검사 실패: 기기 저장 파일이 겹칩니다 ${JSON.stringify(infos)}`);
  return infos;
}

/** 첫 연결 뒤 서버의 members에 서로 다른 client_id가 expected개 이상 있는지 확인합니다. */
export async function selfCheckMembers(harness, key, expected = Object.keys(harness.devices).length) {
  const family = await harness.server.adapter.family(key);
  const ids = new Set(family.members.map((m) => m.clientId));
  if (ids.size < expected) {
    throw new Error(`자기 검사 실패: members의 서로 다른 client_id가 ${ids.size}개입니다 (기대 ${expected}개 이상)`);
  }
  return [...ids];
}
