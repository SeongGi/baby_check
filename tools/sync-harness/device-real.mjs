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
// 이전 모듈(07 설계 5.1, 앱 App.tsx와 같은 방식으로 조립. loadFirestore는 주입하지 않아 앱과 같은 동적 import 경로):
//   runMigration {syncKey?} -> {result:{status,message}, state} | join {key, allowFamilyCreation?, createBackup?, waitMigration?} -> {outcome, message, syncResult, migrationResult?}
//   legacyJoin {key, createBackup?, waitMigration?} -> join과 같음 | transitionTick {syncKey?, force?} -> {status, reason, message}
//   migrationState {syncKey?} -> {syncKey, state, transition, marker, backupMeta, hasBackupValue, gate, d1Status, complete}
//   bootApp {} -> {marker} 앱 시작 때의 migrateStoredData | setLegacyMarker {value|keys, checkedAt?} (value:null이면 표식을 지움) | clearLegacyMarker {} (개발 메뉴의 비우기와 같은 함수)
//   importData {logs?, profile?} | backupLocalData {} | restoreLocalBackup {} (가져오기와 로컬 백업 복원, 시나리오 11)
//   restorePreMigrationBackup {} -> {success, added, logCount} | seedLegacyStorage {items} (값은 문자열 또는 JSON으로 적을 객체)
//   setChoiceAnswers {backupFailure?, legacyDeletion?, defaults?, replace?} | choiceLog {clear?} -> {backupFailure, legacyDeletion, notices, pending} | answerChoice {kind, answer}
//   migrationMessages {} -> {messages} 이전 모듈의 안내 문구 | migratorEvents {clear?} | migrationTimers {clear?} | migratorReset {firestoreBudgetMs?, firestoreCallTimeoutMs?} (앱을 다시 연 것처럼 이전 모듈과 러너를 새로 만듦)
//   moduleLoads {} -> {loads, firestoreImportLoaded, firebaseLoaded, injectedLoads} 동적 import 기록 | storageReads {clear?} -> {reads, order, writes}
//   firestoreUid {uid?|reset?} -> {uid} 가짜 Firebase 로그인 uid 조회와 변경(uid 변경, 07 2.5)
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
  const { rawStorage, storageFaults, storageStats } = await import('./stubs/async-storage.mjs');
  const { createFamilyMigrator, MIGRATION_MESSAGES } = await import(`${SRC}/database/familyMigration.ts`);
  const { harnessAuth } = await import('./stubs/fake-firestore.mjs');

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
    migrationPending: result.migrationPending,
    uploadStalled: result.uploadStalled,
    oversizedIds: result.oversizedIds,
    pullTooSlow: result.pullTooSlow,
    logCount: result.logs?.length,
    ...(withIds ? { logIds: result.logs?.map((l) => l.id) } : {}),
    profile: summarizeProfile(result.profile),
  });

  const summarizeEvent = (event) => {
    const base = { seq: (eventSeq += 1), at: realNow(), type: event.type, syncKey: event.syncKey, requestId: event.requestId };
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

  // ── 이전 모듈(App.tsx의 조립과 같은 방식): 러너와 이전 모듈은 서로를 참조합니다 ──
  // 기기 프로세스는 Firestore 예산과 호출 상한도 10분의 1로 줄입니다(90초 -> 9초, 15초 -> 1.5초).
  let migratorTiming = { firestoreBudgetMs: 9_000, firestoreCallTimeoutMs: 1_500 };
  const injectLoadFirestore = process.env.HARNESS_LOAD_FIRESTORE === 'inject';
  let injectedLoads = 0;
  let migratorEvents = [];
  let migrationTimers = [];
  const choice = { backupFailure: [], legacyDeletion: [], defaults: { backupFailure: 'later', legacyDeletion: 'later' } };
  const choiceLog = { backupFailure: [], legacyDeletion: [], notices: [] };
  const pendingChoices = [];

  const takeAnswer = (kind) => (choice[kind].length > 0 ? { entry: choice[kind].shift(), fromDefault: false } : { entry: choice.defaults[kind], fromDefault: true });
  /** 화면 콜백의 답. 문자열이면 곧바로, {answer, delayMs}면 늦게, {hold: true}면 answerChoice가 올 때까지 기다립니다. */
  const answerFor = (kind, log) => {
    const { entry, fromDefault } = takeAnswer(kind);
    const record = { ...log, at: realNow(), fromDefault, answer: null, pending: false };
    choiceLog[kind].push(record);
    const done = (answer) => { record.answer = answer; record.pending = false; return answer; };
    if (entry && typeof entry === 'object' && entry.hold) {
      record.pending = true;
      return new Promise((resolve) => { pendingChoices.push({ kind, record, resolve: (answer) => resolve(done(answer)) }); });
    }
    if (entry && typeof entry === 'object' && entry.delayMs) {
      return new Promise((resolve) => setTimeout(() => resolve(done(entry.answer)), entry.delayMs));
    }
    return Promise.resolve(done(entry));
  };

  let runner = null;
  let migrator = null;
  const makeMigrator = () => {
    const created = createFamilyMigrator({
      storage,
      cloud: {
        connectFamily: cloudClient.connectFamily,
        deleteFamilyData: cloudClient.deleteFamilyData,
        getSyncToken: cloudClient.getSyncToken,
        scheduleFamilyDeletion: cloudClient.scheduleFamilyDeletion,
      },
      getClientId: sync.getSyncClientId,
      getRunner: () => runner,
      ...(injectLoadFirestore ? {
        loadFirestore: async () => { injectedLoads += 1; return import(`${SRC}/database/firestoreImport.ts`); },
      } : {}),
      askBackupFailure: () => answerFor('backupFailure', {}),
      askLegacyDeletionChoice: (prompt) => answerFor('legacyDeletion', { context: prompt.context, pendingDeletionAt: prompt.pendingDeletionAt, options: prompt.options }),
      notify: (notice) => { choiceLog.notices.push({ ...notice, at: realNow() }); },
      setTimer: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref?.();
        migrationTimers.push({ ms, at: Date.now(), cleared: false, handle });
        return handle;
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
        const timer = migrationTimers.find((t) => t.handle === handle);
        if (timer) timer.cleared = true;
      },
      ...migratorTiming,
    });
    created.subscribe((event) => migratorEvents.push({ ...event, seq: (eventSeq += 1), at: realNow() }));
    return created;
  };

  const makeRunner = () => createSyncRunner({
    syncWithCloud: sync.syncWithCloud,
    getLogs: storage.getLogs,
    getProfile: storage.getProfile,
    saveProfile: storage.saveProfile,
    readProfileAfterPendingWrites: storage.readProfileAfterPendingWrites,
    // 러너가 회차마다 읽는 값이라서, 명령에서 정한 상한이 다음 회차부터 적용됩니다.
    get timeoutMs() { return runnerTimeoutMs; },
    // 근거가 없는 키(1.8.0 가족, 혼자 쓰기)는 관문이 곧바로 proceed를 돌려줍니다(07 2.3).
    migrationGate: (key) => migrator.migrationGate(key),
    onEvent: (event) => runnerEvents.push(summarizeEvent(event)),
  });
  runner = makeRunner();
  migrator = makeMigrator();

  const completeOf = (state) => typeof state.mergedAt === 'number' && typeof state.d1UploadedAt === 'number';
  const summarizeJoin = async (result, waitMigration) => ({
    outcome: result.outcome,
    message: result.message,
    syncResult: result.syncResult ? summarizeResult(result.syncResult) : undefined,
    hasMigration: Boolean(result.migration),
    ...(waitMigration && result.migration ? { migrationResult: await result.migration } : {}),
  });

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

    // ── 이전 모듈(07 설계 5.1) ──
    async runMigration(payload = {}) {
      const key = await currentKey(payload);
      // 앱도 syncKey가 없으면 ensure를 부르지 않습니다(혼자 쓰기, 불변 조건 5).
      if (!key) return { result: { status: 'no_key' }, state: {}, skipped: true };
      const result = await migrator.ensure(key);
      return { result, state: await storage.getMigrationState(key) };
    },
    async join({ key, allowFamilyCreation = false, createBackup, waitMigration = false }) {
      return summarizeJoin(await migrator.joinFamily(key, { allowFamilyCreation, createBackup }), waitMigration);
    },
    async legacyJoin({ key, createBackup, waitMigration = false }) {
      return summarizeJoin(await migrator.legacyJoin(key, { createBackup }), waitMigration);
    },
    async transitionTick(payload = {}) {
      return migrator.transitionTick(await currentKey(payload), { force: payload.force });
    },
    async migrationState(payload = {}) {
      const key = await currentKey(payload);
      if (!key) return { syncKey: null, complete: false, state: {}, transition: {}, marker: null, gate: 'proceed' };
      const state = await storage.getMigrationState(key);
      const meta = await rawStorage.getItem('@baby_pre_cloudflare_backup_meta_v1');
      return {
        syncKey: key,
        state,
        transition: await storage.getTransitionState(key),
        marker: await storage.getLegacyKeyMarker(),
        backupMeta: meta ? JSON.parse(meta) : null,
        hasBackupValue: (await rawStorage.getItem('@baby_pre_cloudflare_backup_v1')) !== null,
        gate: await migrator.peekGate(key),
        d1Status: migrator.getD1Status(key) ?? null,
        complete: completeOf(state),
      };
    },
    async bootApp() {
      await storage.migrateStoredData();
      return { marker: await storage.getLegacyKeyMarker() };
    },
    async setLegacyMarker({ value, keys, checkedAt }) {
      const next = keys !== undefined ? { checkedAt: checkedAt ?? Date.now(), keys } : value;
      await storage.setLegacyKeyMarkerForTests(next ?? null);
      return { marker: await storage.getLegacyKeyMarker() };
    },
    async clearLegacyMarker() {
      return { ok: await storage.clearLegacyKeyMarker(), marker: await storage.getLegacyKeyMarker() };
    },
    async restorePreMigrationBackup() {
      const result = await storage.restorePreMigrationBackup();
      return { success: result.success, added: result.added, logCount: result.logs?.length };
    },
    // 가져오기와 로컬 백업 복원(시나리오 11: 전환기 상태가 이 경로에서 지워지지 않는지)
    async importData({ logs = [], profile }) {
      const result = await storage.importDataWithoutLoss(logs, { ...(await storage.getProfile()), ...(profile || {}) });
      return { logCount: result.logs.length };
    },
    async backupLocalData() { return { ok: await storage.backupLocalData() }; },
    async restoreLocalBackup() {
      const result = await storage.restoreFromLocalBackup();
      return { success: result.success };
    },
    async seedLegacyStorage({ items }) {
      for (const [key, value] of Object.entries(items)) {
        await rawStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      return { count: Object.keys(items).length };
    },
    // 화면 콜백의 답 대기열. 항목은 'continue' 같은 문자열, {answer, delayMs}, {hold: true}(answerChoice가 올 때까지 기다림).
    // 대기열이 비면 defaults(기본 'later')를 쓰고 기록에 fromDefault: true로 남습니다.
    async setChoiceAnswers({ backupFailure, legacyDeletion, defaults, replace = false } = {}) {
      if (replace) { choice.backupFailure = []; choice.legacyDeletion = []; }
      if (backupFailure) choice.backupFailure.push(...backupFailure);
      if (legacyDeletion) choice.legacyDeletion.push(...legacyDeletion);
      if (defaults) Object.assign(choice.defaults, defaults);
      return { queued: { backupFailure: choice.backupFailure.length, legacyDeletion: choice.legacyDeletion.length }, defaults: choice.defaults };
    },
    async choiceLog({ clear = false } = {}) {
      const snapshot = JSON.parse(JSON.stringify({ ...choiceLog, pending: pendingChoices.map((p) => ({ kind: p.kind, ...p.record })) }));
      if (clear) { choiceLog.backupFailure = []; choiceLog.legacyDeletion = []; choiceLog.notices = []; }
      return snapshot;
    },
    async answerChoice({ kind, answer }) {
      const index = pendingChoices.findIndex((p) => p.kind === kind);
      if (index < 0) return { answered: false };
      pendingChoices.splice(index, 1)[0].resolve(answer);
      return { answered: true };
    },
    async migrationMessages() { return { messages: MIGRATION_MESSAGES }; },
    async migratorEvents({ clear = false } = {}) {
      const events = migratorEvents;
      if (clear) migratorEvents = [];
      return { events };
    },
    async migrationTimers({ clear = false } = {}) {
      const timers = migrationTimers.map(({ handle: _handle, ...t }) => t);
      if (clear) migrationTimers = [];
      return { timers };
    },
    // 앱을 다시 연 것처럼 이전 모듈(메모리 상태 d1Status 등)과 러너를 새로 만듭니다. 프로세스 재시작(restart)과 달리 저장소와 시계는 그대로입니다.
    async migratorReset(timing = {}) {
      migratorTiming = { ...migratorTiming, ...timing };
      migrator.dispose();
      runnerEvents = [];
      migratorEvents = [];
      runner = makeRunner();
      migrator = makeMigrator();
      return migratorTiming;
    },
    async moduleLoads() {
      const loads = globalThis.__harnessModuleLoads || [];
      return {
        loads,
        firestoreImportLoaded: loads.some((l) => l.module === 'firestoreImport.ts'),
        firebaseLoaded: loads.some((l) => l.module === 'firebase.ts'),
        injectedLoads,
      };
    },
    async storageReads({ clear = false } = {}) {
      const snapshot = { reads: { ...storageStats.reads }, order: [...storageStats.order], writes: { ...storageStats.writes } };
      if (clear) storageStats.clear();
      return snapshot;
    },
    async firestoreUid({ uid, reset = false } = {}) {
      if (reset) harnessAuth.setUid(null);
      else if (uid !== undefined) harnessAuth.setUid(uid);
      return { uid: harnessAuth.getUid() };
    },

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
