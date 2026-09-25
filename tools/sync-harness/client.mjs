import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(DIR, 'loader.mjs');
const DEVICE = path.join(DIR, 'device.mjs');

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Device {
  constructor(name) {
    this.name = name;
    this.file = path.join(DIR, `storage-${name}.json`);
    if (existsSync(this.file)) rmSync(this.file);
    this.pending = new Map();
    this.seq = 0;
    this.buffer = '';
    this.exited = false;
    this.proc = spawn(process.execPath, ['--import', `data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register(${JSON.stringify(`file://${LOADER}`)}, pathToFileURL("./"));`, DEVICE], {
      env: { ...process.env, HARNESS_STORAGE_FILE: this.file, HARNESS_DEVICE_NAME: name },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdin.on('error', () => undefined);
    this.proc.on('exit', (code, signal) => {
      console.log(`  [${this.name}] process exited code=${code} signal=${signal}`);
      this.pending.forEach((resolve, id) => resolve({ id, ok: false, error: `device ${this.name} exited (${code}/${signal})` }));
      this.pending.clear();
    });
    this.proc.stderr.on('data', (chunk) => {
      chunk.toString().split('\n').filter(Boolean).forEach((l) => console.log(`  [${this.name} stderr] ${l}`));
    });
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        // Firebase SDK 가 stdout 에 남기는 로그는 무시하고 하네스 응답만 처리합니다.
        let message;
        try { message = JSON.parse(line); } catch { console.log(`  [${this.name} stdout] ${line}`); continue; }
        if (typeof message?.id !== 'number') { console.log(`  [${this.name} stdout] ${line}`); continue; }
        const resolver = this.pending.get(message.id);
        if (resolver) { this.pending.delete(message.id); resolver(message); }
      }
    });
  }

  send(cmd, payload = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}.${cmd} timed out after 60s`)), 60_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (!message.ok) reject(new Error(`${this.name}.${cmd}: ${message.error}`));
        else resolve(message.result);
      });
      if (this.proc.exitCode !== null || this.proc.killed) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${this.name} 프로세스가 이미 종료되었습니다`));
        return;
      }
      this.proc.stdin.write(JSON.stringify({ id, cmd, payload }) + '\n');
    });
  }
}

