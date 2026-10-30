// 실제 서버 모드의 기기 명령입니다(06 설계 2.10). device.mjs가 HARNESS_REAL_WORKER=1일 때 불러옵니다.
// 명령은 {cmd, payload}를 받아 JSON으로 직렬화 가능한 값을 돌려주는 async 함수이고, 동시에 처리됩니다.
//
// 명령 요약(payload -> 결과):
//   ping, quit, getSyncClientId -> {clientId, storageFile}
//   setTiming {requestTimeoutMs?, pullBudgetMs?, cycleBudgetMs?} / getTiming
//   addLog {log} -> {saved} | updateLog {log} -> {ok} | deleteLog {id} -> {ok}
//   saveLogs {logs} | seedLogs {count, idPrefix?, timestamp?, amount?, notes?} -> {count} | seedTombstones {count, idPrefix?}
//   getLogs {} -> {logs} | peekLogs {} -> {logs} (저장 큐를 기다리지 않음) | logSet {} -> {count, pairs:[[id, canonical JSON]]} (id 순)
//   setProfile {patch} -> {profile} | getProfile {} -> {profile}
//   readStorage {keys?} -> {items} | readLedger {} -> {ledger} | writeStorage {key, value|json} -> {ok}
//   forgetUploaded {ids?} -> {removed} 장부의 uploaded에서 id(없으면 전부)를 지움
//   advanceClock {ms} -> {now, offsetMs} 기기 시계(Date.now)를 진행 | getClock
//   syncWithCloud {syncKey?, createBackup?, allowFamilyCreation?, forceFullRead?, tokenId?, abortAfterMs?, withIds?} -> 결과 요약
//   abort {tokenId} -> {aborted} 진행 중인 syncWithCloud의 중단 토큰을 켬
//   runnerRequest {request, timeoutMs?} -> 결과 요약 | runnerEvents {clear?} -> {events} | runnerReset {timeoutMs?} | runnerAbort
//   injectStorageFault {mode:'throw'|'exit'|'delay', nth?, keys?} | releaseWrite -> {released} | storageFaultStatus | clearStorageFault
//   readChangeToken {syncKey?} -> {token} | rawToken {syncKey?} -> {ok, changeToken, status} | scheduleDeletion / cancelDeletion / deleteFamily / deletionStatus {syncKey?}
//   newFamilyKey -> {key}
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const LEDGER_KEY = '@baby_sync_ledger_cf_v1';

// 기기 프로세스는 시작할 때 요청 상한, 시간 예산, 러너 상한을 실제의 10분의 1로 줄입니다.
// 비율이 같아서 "8초 전에 시작한 요청은 18초 안에 끝난다" 같은 관계도 그대로입니다.
const SCALED_TIMING = { requestTimeoutMs: 1_000, pullBudgetMs: 600, cycleBudgetMs: 800 };
const SCALED_RUNNER_TIMEOUT_MS = 2_000;

export async function createRealCommands({ name }) {
  const storage = await import(`${SRC}/database/storage.ts`);
  const sync = await import(`${SRC}/database/sync.ts`);
  const cloudClient = await import(`${SRC}/database/cloudClient.ts`);
  const { setCustomWorkerUrl } = await import(`${SRC}/database/cloudConfig.ts`);
  const { createSyncRunner } = await import(`${SRC}/database/syncRunner.ts`);
  const { rawStorage, storageFaults } = await import('./stubs/async-storage.mjs');

  const workerUrl = process.env.HARNESS_WORKER_URL;
  if (!workerUrl) throw new Error('HARNESS_WORKER_URL 이 필요합니다');
  setCustomWorkerUrl(workerUrl);
  cloudClient.setSyncTimingForTests(SCALED_TIMING);

  // 기기 시계: Date.now만 바꿔치기합니다(6시간 전체 대조 같은 기기 시각 시나리오).
  const realNow = Date.now.bind(Date);
  let clockOffsetMs = 0;
  Date.now = () => realNow() + clockOffsetMs;

  const abortTokens = new Map();
  let runnerTimeoutMs = SCALED_RUNNER_TIMEOUT_MS;
  let runnerEvents = [];
  let eventSeq = 0;

  const summarizeProfile = (profile) => profile && ({
    name: profile.name,
    birthDate: profile.birthDate,
    birthWeight: profile.birthWeight,
    targetFormula: profile.targetFormula,
    sharedUpdatedAt: profile.sharedUpdatedAt,
    syncKey: profile.syncKey ?? null,
    deletedLogIds: profile.deletedLogIds,
  });

  const summarizeResult = (result, { withIds = false } = {}) => result && ({
    success: result.success,
    merged: result.merged,
    error: result.error,
    continuing: result.continuing,
    progressed: result.progressed,
    familyUnavailable: result.familyUnavailable,
    familyNotFound: result.familyNotFound,
    uploadStalled: result.uploadStalled,
    oversizedIds: result.oversizedIds,
    pullTooSlow: result.pullTooSlow,
    logCount: result.logs?.length,
    ...(withIds ? { logIds: result.logs?.map((l) => l.id) } : {}),
    profile: summarizeProfile(result.profile),
  });

  const summarizeEvent = (event) => {
    const base = { seq: (eventSeq += 1), at: realNow(), type: event.type };
    switch (event.type) {
      case 'succeeded':
        return { ...base, continuation: event.continuation, notice: event.notice, result: summarizeResult(event.result) };
      case 'failed':
        return { ...base, error: event.error, result: summarizeResult(event.result) };
      case 'disconnected':
        return { ...base, profile: summarizeProfile(event.profile), logCount: event.logs?.length };
      default:
        return base;
    }
  };

  const makeRunner = () => createSyncRunner({
    syncWithCloud: sync.syncWithCloud,
    getLogs: storage.getLogs,
    getProfile: storage.getProfile,
    saveProfile: storage.saveProfile,
    readProfileAfterPendingWrites: storage.readProfileAfterPendingWrites,
    // 러너가 회차마다 읽는 값이라서, 명령에서 정한 상한이 다음 회차부터 적용됩니다.
    get timeoutMs() { return runnerTimeoutMs; },
    onEvent: (event) => runnerEvents.push(summarizeEvent(event)),
  });
  let runner = makeRunner();

  const currentKey = async (payload) => payload.syncKey ?? (await storage.getProfile()).syncKey;

  return {
    async ping() { return { pong: true, name }; },

    async quit() {
      setTimeout(() => process.exit(0), 50);
      return { bye: true };
    },

    async getSyncClientId() {
      return { clientId: await sync.getSyncClientId(), storageFile: process.env.HARNESS_STORAGE_FILE };
    },

    async setTiming(payload) {
      cloudClient.setSyncTimingForTests(payload);
      return cloudClient.getSyncTiming();
    },
    async getTiming() { return cloudClient.getSyncTiming(); },

    // ── 기록과 아기 정보 ──
    async addLog({ log }) { return { saved: await storage.addLog(log) }; },
    async updateLog({ log }) { return { ok: await storage.updateLog(log) }; },
    async deleteLog({ id }) { return { ok: await storage.deleteLog(id) }; },
    async saveLogs({ logs }) { await storage.saveLogs(logs); return { count: logs.length }; },
    async seedLogs({ count, idPrefix = 'seed', timestamp = 1_000_000, amount = 90, notes, type = 'formula' }) {
      const logs = Array.from({ length: count }, (_, i) => ({
        id: `${idPrefix}-${i}`, type, amount, timestamp: timestamp + i, updatedAt: timestamp + i,
        ...(notes ? { notes } : {}),
      }));
      await storage.saveLogs([...await storage.getLogs(), ...logs]);
      return { count };
    },
    async seedTombstones({ count, idPrefix = 'gone' }) {
      const profile = await storage.getProfile();
      const ids = Array.from({ length: count }, (_, i) => `${idPrefix}-${i}`);
      await storage.saveProfile({ ...profile, deletedLogIds: [...(profile.deletedLogIds || []), ...ids] });
      return { count };
    },
    async getLogs() { return { logs: await storage.getLogs() }; },
    // 저장 큐를 기다리지 않고 저장 파일의 기록을 바로 읽습니다. 저장 고장 주입(delay)으로 쓰기가 멈춰 있는 동안
    // getLogs는 저장 큐가 비기를 기다리므로, 멈춘 동안의 파일 내용은 이 명령으로 봅니다.
    async peekLogs() {
      const raw = await rawStorage.getItem('@baby_logs');
      return { logs: raw ? JSON.parse(raw) : [] };
    },
    async logSet() {
      const logs = [...await storage.getLogs()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { count: logs.length, pairs: logs.map((l) => [l.id, storage.stableValue(l)]) };
    },
    async setProfile({ patch }) {
      const current = await storage.getProfile();
      await storage.saveProfile({ ...current, ...patch });
      return { profile: summarizeProfile(await storage.getProfile()) };
    },
    async getProfile() { return { profile: await storage.getProfile() }; },

    // ── 저장소와 장부 ──
    async readStorage({ keys } = {}) {
      const all = await rawStorage.getAll();
      return { items: keys ? Object.fromEntries(keys.map((k) => [k, all[k] ?? null])) : all };
    },
    async readLedger() {
      const raw = await rawStorage.getItem(LEDGER_KEY);
      let ledger = null;
      try { ledger = raw ? JSON.parse(raw) : null; } catch { ledger = { unparsable: raw }; }
      return { ledger };
    },
    async writeStorage({ key, value, json }) {
      const text = json !== undefined ? JSON.stringify(json) : value;
      if (text === null || text === undefined) await rawStorage.removeItem(key);
      else await rawStorage.setItem(key, text);
      return { ok: true };
    },
    async forgetUploaded({ ids } = {}) {
      const raw = await rawStorage.getItem(LEDGER_KEY);
      if (!raw) return { removed: 0 };
      const ledger = JSON.parse(raw);
      const before = Object.keys(ledger.uploaded || {}).length;
      if (ids) ids.forEach((id) => { delete ledger.uploaded?.[id]; });
      else ledger.uploaded = {};
      await rawStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
      return { removed: before - Object.keys(ledger.uploaded || {}).length };
    },

    // ── 기기 시계 ──
    async advanceClock({ ms }) {
      clockOffsetMs += ms;
      return { now: Date.now(), offsetMs: clockOffsetMs };
    },
    async getClock() { return { now: Date.now(), offsetMs: clockOffsetMs }; },

    // ── 동기화 ──
    async syncWithCloud(payload = {}) {
      const key = await currentKey(payload);
      if (!key) return { success: false, error: 'no syncKey locally' };
      const {
        createBackup = false, allowFamilyCreation = true, forceFullRead = false, tokenId, abortAfterMs, withIds,
      } = payload;
      let token;
      if (tokenId || abortAfterMs !== undefined) {
        token = { aborted: false };
        if (tokenId) abortTokens.set(tokenId, token);
        if (abortAfterMs !== undefined) setTimeout(() => { token.aborted = true; }, abortAfterMs);
      }
      try {
        const result = await sync.syncWithCloud(
          key, await storage.getLogs(), await storage.getProfile(), createBackup, token, allowFamilyCreation, forceFullRead,
        );
        return summarizeResult(result, { withIds });
      } finally {
        if (tokenId) abortTokens.delete(tokenId);
      }
    },
    async abort({ tokenId }) {
      const token = abortTokens.get(tokenId);
      if (token) token.aborted = true;
      return { aborted: Boolean(token) };
    },

    // ── 러너 ──
    async runnerRequest({ request, timeoutMs }) {
      if (timeoutMs !== undefined) runnerTimeoutMs = timeoutMs;
      return summarizeResult(await runner.request(request));
    },
    async runnerEvents({ clear = false } = {}) {
      const events = runnerEvents;
      if (clear) runnerEvents = [];
      return { events };
    },
    async runnerReset({ timeoutMs } = {}) {
      runnerTimeoutMs = timeoutMs ?? SCALED_RUNNER_TIMEOUT_MS;
      runnerEvents = [];
      runner = makeRunner();
      return { timeoutMs: runnerTimeoutMs };
    },
    async runnerAbort() { runner.abortActive(); return { aborted: true }; },

    // ── 저장 고장 주입 ──
    async injectStorageFault(payload) { return storageFaults.arm(payload); },
    async releaseWrite() { return { released: storageFaults.releaseWrite() }; },
    async storageFaultStatus() { return storageFaults.status(); },
    async clearStorageFault() { storageFaults.disarm(); return { cleared: true }; },

    // ── 변경 토큰과 영구 삭제 ──
    async readChangeToken(payload = {}) {
      return { token: await sync.readFamilyChangeToken(await currentKey(payload)) };
    },
    // 서버의 변경 토큰을 그대로 읽습니다(자기 기기가 쓴 토큰도 null로 바꾸지 않고, 상태 코드를 돌려줍니다).
    async rawToken(payload = {}) {
      const key = await currentKey(payload);
      try {
        const res = await cloudClient.getSyncToken(key, await sync.getSyncClientId());
        return { ok: res.ok, changeToken: res.changeToken, profileUpdatedAt: res.profileUpdatedAt, status: 200 };
      } catch (error) {
        return { ok: false, status: error?.status ?? null, error: error?.message };
      }
    },
    async scheduleDeletion(payload = {}) { return sync.scheduleFamilyDeletion(await currentKey(payload)); },
    async cancelDeletion(payload = {}) { return sync.cancelFamilyDeletion(await currentKey(payload)); },
    async deleteFamily(payload = {}) { return sync.deleteFamilyCloudData(await currentKey(payload)); },
    async deletionStatus(payload = {}) { return sync.getFamilyDeletionStatus(await currentKey(payload)); },
    async newFamilyKey() { return { key: sync.createFamilySyncId() }; },
  };
}
