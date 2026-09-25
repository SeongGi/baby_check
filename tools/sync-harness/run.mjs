// 두 대의 휴대폰을 실제로 띄워 동기화 시나리오를 순서대로 검증합니다.
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(DIR, 'loader.mjs');
const DEVICE = path.join(DIR, 'device.mjs');
const SYNC_KEY = process.env.HARNESS_SYNC_KEY || `harness${randomUUID().replace(/-/g, '')}`;

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

class Device {
  constructor(name) {
    this.name = name;
    this.file = path.join(DIR, `storage-${name}.json`);
    if (existsSync(this.file)) rmSync(this.file);
    this.pending = new Map();
    this.seq = 0;
    this.buffer = '';
    this.proc = spawn(process.execPath, ['--import', `data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register(${JSON.stringify(`file://${LOADER}`)}, pathToFileURL("./"));`, DEVICE], {
      env: { ...process.env, HARNESS_STORAGE_FILE: this.file, HARNESS_DEVICE_NAME: name },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
      this.proc.stdin.write(JSON.stringify({ id, cmd, payload }) + '\n');
    });
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`\n=== ${msg} ===`);

const A = new Device('A');
const B = new Device('B');

try {
  console.log(`sync key: ${SYNC_KEY}`);

  log('S1. A가 가족을 만들고 첫 기록을 올린다');
  await A.send('setProfile', { patch: { syncKey: SYNC_KEY, name: '아기A', targetFormula: 900, birthDate: '2026-01-02' } });
  const logA1 = await A.send('addLog', { log: { type: 'formula', amount: 120, timestamp: Date.now() } });
  const syncA1 = await A.send('sync');
  check('A 최초 동기화 성공', syncA1.success === true, syncA1.error || `logs=${syncA1.logCount}`);
  const uidA = await A.send('uid');
  check('A 익명 로그인 성공', Boolean(uidA.uid), `uid=${uidA.uid}`);

  log('S2. B(새 폰)가 같은 키로 합류한다 — 기본 프로필이 가족 프로필을 덮어쓰면 안 된다');
  await B.send('setProfile', { patch: { syncKey: SYNC_KEY } });
  const syncB1 = await B.send('sync');
  check('B 합류 동기화 성공', syncB1.success === true, syncB1.error);
  check('B가 A의 기록을 받았다', syncB1.logIds?.includes(logA1.saved.id), `ids=${JSON.stringify(syncB1.logIds)}`);
  check('B의 기본 프로필이 가족 프로필을 덮어쓰지 않았다',
    syncB1.profile?.name === '아기A' && syncB1.profile?.targetFormula === 900,
    `B가 본 프로필=${JSON.stringify(syncB1.profile)}`);

  log('S3. A가 다시 동기화 — B의 기본 프로필이 A의 프로필을 지우지 않았는지');
  const syncA2 = await A.send('sync');
  check('A 프로필 유지', syncA2.profile?.name === '아기A' && syncA2.profile?.targetFormula === 900,
    JSON.stringify(syncA2.profile));

  log('S4. B가 기록 추가 → A가 받는다');
  const logB1 = await B.send('addLog', { log: { type: 'urine', wetness: 'medium', color: 'normal', timestamp: Date.now() } });
  await B.send('sync');
  const syncA3 = await A.send('sync');
  check('A가 B의 기록을 받았다', syncA3.logIds?.includes(logB1.saved.id), `ids=${JSON.stringify(syncA3.logIds)}`);

  log('S5. 변경 없이 두 번 더 동기화 — 무한 변경 루프가 없어야 한다');
  const idle1 = await A.send('sync');
  const idle2 = await A.send('sync');
  check('A 유휴 동기화가 merged=false 로 안정화', idle1.merged === false && idle2.merged === false,
    `merged=${idle1.merged},${idle2.merged}`);
  const idleB1 = await B.send('sync');
  const idleB2 = await B.send('sync');
  check('B 유휴 동기화가 merged=false 로 안정화', idleB1.merged === false && idleB2.merged === false,
    `merged=${idleB1.merged},${idleB2.merged}`);

  log('S5b. 변경 없는 동기화가 원격 쓰기를 만들지 않아야 한다 (무한 쓰기 루프 검출)');
  await B.send('listen');
  await wait(2500);
  await A.send('sync');
  await A.send('sync');
  await A.send('sync');
  await wait(5000);
  const idleNotify = await B.send('notifications');
  check('유휴 동기화가 원격 쓰기를 일으키지 않는다', idleNotify.notifications === 0,
    `유휴 3회 동안 원격 변경 알림 ${idleNotify.notifications}건 발생 (0이어야 정상)`);
  await B.send('stopListening');

  log('S6. 실시간 알림 — B가 듣는 중에 A가 기록을 올리면 알림이 와야 한다');
  await B.send('listen');
  await wait(2000);
  await A.send('addLog', { log: { type: 'formula', amount: 60, timestamp: Date.now() } });
  await A.send('sync');
  await wait(6000);
  const notified = await B.send('notifications');
  check('B가 실시간 알림을 받았다', notified.notifications > 0, `count=${notified.notifications}`);
  await B.send('stopListening');

  log('S7. A가 기록을 삭제 → B에서도 사라지고 되살아나지 않아야 한다');
  await A.send('deleteLog', { id: logA1.saved.id });
  const syncA4 = await A.send('sync');
  check('A 삭제 후 동기화 성공', syncA4.success === true, syncA4.error);
  const syncB2 = await B.send('sync');
  check('B에서도 삭제 반영', !syncB2.logIds?.includes(logA1.saved.id), `ids=${JSON.stringify(syncB2.logIds)}`);
  const syncB3 = await B.send('sync');
  const syncA5 = await A.send('sync');
  check('재동기화해도 삭제된 기록이 되살아나지 않는다',
    !syncB3.logIds?.includes(logA1.saved.id) && !syncA5.logIds?.includes(logA1.saved.id),
    `B=${JSON.stringify(syncB3.logIds)} A=${JSON.stringify(syncA5.logIds)}`);

  log('S8. 프로필 변경 전파 — A가 목표 수유량을 바꾸면 B에 반영');
  await A.send('setProfile', { patch: { targetFormula: 1000 } });
  await A.send('sync');
  const syncB4 = await B.send('sync');
  check('B가 A의 프로필 변경을 받았다', syncB4.profile?.targetFormula === 1000, JSON.stringify(syncB4.profile));

  log('S9. 로컬 전용 설정 변경이 상대 프로필을 되돌리지 않아야 한다');
  await B.send('setProfile', { patch: { feedingReminderEnabled: true } });
  await B.send('sync');
  const syncA6 = await A.send('sync');
  check('A의 목표 수유량이 유지된다', syncA6.profile?.targetFormula === 1000, JSON.stringify(syncA6.profile));

  log('S10. 대량 기록 배치 — 규칙/배치 한도 확인');
  for (let i = 0; i < 30; i += 1) {
    await A.send('addLog', { log: { type: 'formula', amount: 100 + i, timestamp: Date.now() - i * 60_000 } });
  }
  const bulk = await A.send('sync');
  check('30건 일괄 업로드 성공', bulk.success === true, bulk.error);
  const bulkB = await B.send('sync');
  check('B가 30건을 모두 받았다', bulkB.logCount >= 32, `B logCount=${bulkB.logCount}`);

  log('S11. B의 로컬 전용 변경이 A의 최신 프로필 수신을 막지 않아야 한다');
  await B.send('setProfile', { patch: { feedingReminderEnabled: false, feedingIntervalMinutes: 210 } });
  await B.send('sync');
  await A.send('setProfile', { patch: { name: '수정된이름', birthWeight: '3.5' } });
  await A.send('sync');
  const s11 = await B.send('sync');
  check('B가 A의 이름/출생체중 변경을 받았다',
    s11.profile?.name === '수정된이름', JSON.stringify(s11.profile));
  const s11b = await A.send('sync');
  check('A의 변경이 B에 의해 되돌려지지 않았다',
    s11b.profile?.name === '수정된이름', JSON.stringify(s11b.profile));

  log('S12. 같은 기록을 양쪽에서 수정 — 나중 수정이 이기고 서로 핑퐁하지 않아야 한다');
  const bDump = await B.send('dump');
  const target = bDump.logs.find((l) => l.type === 'formula');
  await A.send('updateLog', { log: { ...target, amount: 111, type: 'formula', timestamp: Date.now() - 1000 } });
  await A.send('sync');
  await wait(1200);
  await B.send('sync');
  await B.send('updateLog', { log: { ...target, amount: 222, type: 'formula', timestamp: Date.now() - 1000 } });
  await B.send('sync');
  const s12a = await A.send('sync');
  const s12aLog = (await A.send('dump')).logs.find((l) => l.id === target.id);
  check('나중 수정(222)이 양쪽에 반영', s12aLog?.amount === 222, `A가 가진 값=${s12aLog?.amount}`);

  log('S13. 최종 수렴 — 두 기기의 기록 집합이 완전히 같아야 한다');
  await A.send('sync');
  await B.send('sync');
  const finalA = await A.send('dump');
  const finalB = await B.send('dump');
  const setA = [...finalA.logIds].sort().join(',');
  const setB = [...finalB.logIds].sort().join(',');
  check('A와 B의 기록이 동일', setA === setB, `A=${finalA.logCount}건 B=${finalB.logCount}건`);
  check('A와 B의 공유 프로필이 동일',
    finalA.profile.name === finalB.profile.name &&
    finalA.profile.targetFormula === finalB.profile.targetFormula &&
    finalA.profile.birthDate === finalB.profile.birthDate,
    `A=${JSON.stringify(finalA.profile)} B=${JSON.stringify(finalB.profile)}`);

  log('S14. 안정 상태에서 반복 동기화해도 아무 변화가 없어야 한다');
  await B.send('listen');
  await wait(2500);
  for (let i = 0; i < 3; i += 1) { await A.send('sync'); await B.send('sync'); }
  await wait(5000);
  const quiet = await B.send('notifications');
  check('안정 상태에서 원격 쓰기 0건', quiet.notifications === 0, `알림 ${quiet.notifications}건`);
  await B.send('stopListening');
} catch (error) {
  check('하네스 실행', false, error.message);
} finally {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n================ 결과: ${results.length - failed.length}/${results.length} 통과 ================`);
  failed.forEach((f) => console.log(`FAILED: ${f.name} — ${f.detail}`));
  await A.send('quit').catch(() => undefined);
  await B.send('quit').catch(() => undefined);
  await wait(300);
  process.exit(failed.length ? 1 : 0);
}
