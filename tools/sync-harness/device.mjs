// 한 대의 휴대폰을 흉내 냅니다. stdin 으로 명령(JSON 한 줄)을 받아 실행하고
// 결과를 stdout 에 JSON 한 줄로 돌려줍니다. 프로세스가 살아 있는 동안
// 익명 로그인 UID 가 유지되므로 실제 앱 세션과 같은 조건이 됩니다.
import readline from 'node:readline';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const NAME = process.env.HARNESS_DEVICE_NAME || 'device';

const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const err = (msg) => process.stderr.write(`[${NAME}] ${msg}\n`);

const firestore = await import('firebase/firestore');
const cryptoStub = await import('./stubs/expo-crypto.mjs');
const storage = await import(`${SRC}/database/storage.ts`);
const sync = await import(`${SRC}/database/sync.ts`);
const { auth, db } = await import(`${SRC}/database/firebase.ts`);

let unsubscribe;
let notifications = 0;

// 예전 버전 앱이 남긴 모양(공유 시각 필드 없음)으로 클라우드 프로필을 직접 씁니다.
const legacyFamilyRef = async (syncKey) => {
  const familyId = await cryptoStub.digestStringAsync(
    cryptoStub.CryptoDigestAlgorithm.SHA256, `babycheck:family:v2:${syncKey}`);
  return firestore.doc(db, 'families', familyId);
};

const commands = {
  async writeLegacySharedProfile({ patch }) {
    const profile = await storage.getProfile();
    const familyRef = await legacyFamilyRef(profile.syncKey);
    const profileRef = firestore.doc(familyRef, 'profile', 'shared');
    await firestore.setDoc(profileRef, patch);
    return { wrote: patch };
  },

  async readSharedProfile() {
    const profile = await storage.getProfile();
    const familyRef = await legacyFamilyRef(profile.syncKey);
    const snapshot = await firestore.getDoc(firestore.doc(familyRef, 'profile', 'shared'));
    return { exists: snapshot.exists(), data: snapshot.data() || null };
  },

  async seedLegacyLocalProfile({ patch }) {
    // sharedUpdatedAt 이 없는 예전 로컬 프로필을 그대로 심습니다.
    const AsyncStorage = (await import('./stubs/async-storage.mjs')).default;
    await AsyncStorage.setItem('@baby_profile', JSON.stringify(patch));
    return { seeded: patch };
  },

  async uid() {
    return { uid: auth.currentUser?.uid || null };
  },

  async setProfile({ patch }) {
    const current = await storage.getProfile();
    await storage.saveProfile({ ...current, ...patch });
    return { profile: await storage.getProfile() };
  },

  async addLog({ log }) {
    const saved = await storage.addLog(log);
    return { saved };
  },

  async deleteLog({ id }) {
    return { ok: await storage.deleteLog(id) };
  },

  async updateLog({ log }) {
    return { ok: await storage.updateLog(log) };
  },

  async sync() {
    const logs = await storage.getLogs();
    const profile = await storage.getProfile();
    if (!profile.syncKey) return { success: false, error: 'no syncKey locally' };
    const result = await sync.syncWithCloud(profile.syncKey, logs, profile, false);
    return {
      success: result.success,
      merged: result.merged,
      error: result.error,
      logCount: result.logs.length,
      logIds: result.logs.map((l) => l.id),
      profile: {
        name: result.profile.name,
        targetFormula: result.profile.targetFormula,
        birthDate: result.profile.birthDate,
        updatedAt: result.profile.updatedAt,
        deletedLogIds: result.profile.deletedLogIds,
      },
    };
  },

  async dump() {
    const logs = await storage.getLogs();
    const profile = await storage.getProfile();
    return {
      logCount: logs.length,
      logIds: logs.map((l) => l.id),
      logs: logs.map((l) => ({ id: l.id, type: l.type, amount: l.amount, updatedAt: l.updatedAt })),
      profile: {
        name: profile.name,
        targetFormula: profile.targetFormula,
        birthDate: profile.birthDate,
        updatedAt: profile.updatedAt,
        syncKey: profile.syncKey,
        deletedLogIds: profile.deletedLogIds,
      },
    };
  },

  async listen() {
    const profile = await storage.getProfile();
    notifications = 0;
    unsubscribe = await sync.subscribeToCloudChanges(
      profile.syncKey,
      () => { notifications += 1; err(`realtime notification #${notifications}`); },
      (e) => err(`listener error: ${e?.message || e}`),
    );
    return { listening: true };
  },

  async notifications() {
    return { notifications };
  },

  async stopListening() {
    unsubscribe?.();
    unsubscribe = undefined;
    return { stopped: true };
  },

  async quit() {
    unsubscribe?.();
    setTimeout(() => process.exit(0), 50);
    return { bye: true };
  },
};

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  try {
    const handler = commands[request.cmd];
    if (!handler) throw new Error(`unknown command ${request.cmd}`);
    say({ id: request.id, ok: true, result: await handler(request.payload || {}) });
  } catch (error) {
    say({ id: request.id, ok: false, error: error?.message || String(error), code: error?.code });
  }
}
