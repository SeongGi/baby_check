// firestore.rules 가정 여덟 가지를 로컬 에뮬레이터로 확인합니다.
// 설계 07 5.1 "규칙 가정 확인". firestore.rules는 고치지 않고 있는 그대로 검사합니다.
// 실행: firebase emulators:exec --only firestore --project demo-babycheck-rules "node rules.test.mjs"
// (verify.sh rules 가 이 명령을 돌립니다.) 프로젝트 id가 demo- 로 시작해 실제 Firebase에는 접속하지 않습니다.
//
// 문서 모양은 1.7.9(7d4753b) src/database/sync.ts 가 쓰던 그대로입니다.
//   families/{familyId}          { inviteHash, schemaVersion: 3, createdAt, lastChangedAt, lastChangedBy, pendingDeletionAt? }
//   families/{familyId}/members/{uid}  { inviteHash, joinedAt }
//   families/{familyId}/logs/{id}      { payload, deleted, updatedAt, updatedBy }
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  setLogLevel,
  startAfter,
  Timestamp,
} from 'firebase/firestore';

// 거부 응답마다 SDK가 길게 찍는 오류 로그를 숨깁니다(거부는 이 검사의 정상 결과).
setLogLevel('silent');

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const FAMILY = 'family-with-hash';
const LEGACY = 'family-legacy-no-hash'; // inviteHash 없는 예전 가족 문서
const MISSING = 'family-does-not-exist';
const HASH = 'hash-correct';
const MEMBER = 'uid-member';
const JOINER = 'uid-joiner';
const OUTSIDER = 'uid-outsider';

const testEnv = await initializeTestEnvironment({
  projectId: process.env.GCLOUD_PROJECT || 'demo-babycheck-rules',
  firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
});

// 에뮬레이터 데이터는 규칙을 끄고 넣습니다.
await testEnv.withSecurityRulesDisabled(async context => {
  const db = context.firestore();
  const createdAt = Timestamp.fromMillis(Date.now() - 86_400_000);
  const logPayload = (id, at) => ({
    payload: { id, type: 'feeding', timestamp: at, amount: 120 },
    deleted: false,
    updatedAt: Timestamp.fromMillis(at),
    updatedBy: MEMBER,
  });
  await setDoc(doc(db, 'families', FAMILY), {
    inviteHash: HASH,
    schemaVersion: 3,
    createdAt,
    lastChangedAt: createdAt,
    lastChangedBy: MEMBER,
  });
  await setDoc(doc(db, 'families', FAMILY, 'members', MEMBER), { inviteHash: HASH, joinedAt: createdAt });
  for (const [index, id] of ['log-a', 'log-b', 'log-c', 'log-d', 'log-e'].entries()) {
    await setDoc(doc(db, 'families', FAMILY, 'logs', id), logPayload(id, 1_700_000_000_000 + index * 1000));
  }
  // 예전 스키마 가족: inviteHash 필드 없음. 회원 한 명은 이미 있음.
  await setDoc(doc(db, 'families', LEGACY), { schemaVersion: 2, createdAt });
  await setDoc(doc(db, 'families', LEGACY, 'members', MEMBER), { joinedAt: createdAt });
});

const as = uid => testEnv.authenticatedContext(uid).firestore();
const results = [];
const notes = [];

const assume = async (no, title, body) => {
  try {
    await body();
    results.push(true);
    console.log(`PASS ${no}. ${title}`);
  } catch (error) {
    results.push(false);
    const detail = String(error?.message ?? error).split('\n').slice(0, 4).join(' | ');
    console.log(`FAIL ${no}. ${title}\n     -> ${detail}`);
  }
};

await assume(1, '초대 해시가 맞으면 회원 문서를 만들 수 있다', async () => {
  const db = as(JOINER);
  // 1.7.9 ensureFamilyMembership 의 쓰기 형태 그대로(merge: true).
  await assertSucceeds(
    setDoc(doc(db, 'families', FAMILY, 'members', JOINER), { inviteHash: HASH, joinedAt: serverTimestamp() }, { merge: true }),
  );
  // 반대로 해시가 틀리면 거부된다(대조군).
  await assertFails(
    setDoc(doc(as('uid-wrong-hash'), 'families', FAMILY, 'members', 'uid-wrong-hash'), { inviteHash: 'hash-wrong', joinedAt: serverTimestamp() }, { merge: true }),
  );
  // 남의 uid 로는 만들 수 없다(대조군).
  await assertFails(
    setDoc(doc(as('uid-someone'), 'families', FAMILY, 'members', 'uid-other'), { inviteHash: HASH, joinedAt: serverTimestamp() }, { merge: true }),
  );
});

await assume(2, '예전 가족 문서처럼 inviteHash가 없으면 회원 생성이 거부된다', async () => {
  const db = as(JOINER);
  await assertFails(
    setDoc(doc(db, 'families', LEGACY, 'members', JOINER), { inviteHash: HASH, joinedAt: serverTimestamp() }, { merge: true }),
  );
});

await assume(3, '비회원은 가족 문서와 기록을 읽을 수 없고, 자기 회원 문서는 읽을 수 있다', async () => {
  const db = as(OUTSIDER);
  await assertFails(getDoc(doc(db, 'families', FAMILY)));
  await assertFails(getDoc(doc(db, 'families', FAMILY, 'logs', 'log-a')));
  await assertFails(getDocs(collection(db, 'families', FAMILY, 'logs')));
  // 아직 가입 전이어서 문서가 없어도 읽기 자체는 허용돼야 한다(exists=false 로 돌아옴).
  const own = await assertSucceeds(getDoc(doc(db, 'families', FAMILY, 'members', OUTSIDER)));
  assert.equal(own.exists(), false, '가입 전 자기 회원 문서는 exists=false 여야 합니다');
  // 다른 uid 의 회원 문서는 읽을 수 없다(대조군).
  await assertFails(getDoc(doc(db, 'families', FAMILY, 'members', MEMBER)));
  // 가족 문서 자체가 없는 곳의 자기 회원 문서 읽기도 거부가 아니다.
  await assertSucceeds(getDoc(doc(db, 'families', MISSING, 'members', OUTSIDER)));
});

await assume(4, '회원은 가족 문서에 pendingDeletionAt: null을 쓸 수 있다', async () => {
  const db = as(MEMBER);
  // 1.7.9 cancelFamilyDeletion 과 같은 형태: setDoc(familyRef, { pendingDeletionAt: null }, { merge: true })
  await assertSucceeds(setDoc(doc(db, 'families', FAMILY), { pendingDeletionAt: null }, { merge: true }));
  // 비회원은 못 쓴다(대조군).
  await assertFails(setDoc(doc(as(OUTSIDER), 'families', FAMILY), { pendingDeletionAt: null }, { merge: true }));
  // inviteHash 가 없는 예전 가족 문서에서도 취소 쓰기가 되는지(pinned 의 get(field, null) 처리).
  await assertSucceeds(setDoc(doc(db, 'families', LEGACY), { pendingDeletionAt: null }, { merge: true }));
});

await assume(5, '회원 목록 쿼리(families/<id>/members list)는 회원이어도 거부된다', async () => {
  await assertFails(getDocs(collection(as(MEMBER), 'families', FAMILY, 'members')));
  await assertFails(getDocs(collection(as(OUTSIDER), 'families', FAMILY, 'members')));
});

await assume(6, '가족 문서가 없으면 회원 생성이 거부된다', async () => {
  await assertFails(
    setDoc(doc(as(JOINER), 'families', MISSING, 'members', JOINER), { inviteHash: HASH, joinedAt: serverTimestamp() }, { merge: true }),
  );
});

await assume(7, '회원은 logs 목록 쿼리(orderBy(documentId()), startAfter, limit)를 할 수 있다', async () => {
  const logs = collection(as(MEMBER), 'families', FAMILY, 'logs');
  const first = await assertSucceeds(getDocs(query(logs, orderBy(documentId()), limit(2))));
  assert.deepEqual(first.docs.map(d => d.id), ['log-a', 'log-b']);
  // 직전 페이지 마지막 문서 스냅샷으로 이어 읽기.
  const second = await assertSucceeds(getDocs(query(logs, orderBy(documentId()), startAfter(first.docs.at(-1)), limit(2))));
  assert.deepEqual(second.docs.map(d => d.id), ['log-c', 'log-d']);
  // 저장해 둔 마지막 문서 id 문자열로 이어 읽기(재시작 뒤 커서 형태).
  const third = await assertSucceeds(getDocs(query(logs, orderBy(documentId()), startAfter('log-d'), limit(2))));
  assert.deepEqual(third.docs.map(d => d.id), ['log-e']);
  // 비회원은 같은 쿼리도 거부된다(대조군).
  await assertFails(getDocs(query(collection(as(OUTSIDER), 'families', FAMILY, 'logs'), orderBy(documentId()), limit(2))));
});

await assume(8, 'setDoc(familyDocRef, { pendingDeletionAt: null }, { merge: true })를 쓸 수 있다', async () => {
  // 4번과 같은 쓰기 형태를 inviteHash, createdAt 이 모두 있는 일반 가족 문서에서 다시 확인하고,
  // 쓴 뒤 문서에 필드가 null 로 남고 다른 필드는 그대로인지 본다.
  const db = as(MEMBER);
  await assertSucceeds(setDoc(doc(db, 'families', FAMILY), { pendingDeletionAt: null }, { merge: true }));
  const after = (await assertSucceeds(getDoc(doc(db, 'families', FAMILY)))).data();
  assert.equal(after.pendingDeletionAt, null);
  assert.equal(after.inviteHash, HASH);
  assert.equal(after.schemaVersion, 3);
  // 예약이 걸린 상태(미래 시각)에서의 취소 쓰기도 되는지.
  await assertSucceeds(setDoc(doc(db, 'families', FAMILY), { pendingDeletionAt: Timestamp.fromMillis(Date.now() + 3_600_000) }, { merge: true }));
  await assertSucceeds(setDoc(doc(db, 'families', FAMILY), { pendingDeletionAt: null }, { merge: true }));
});

await testEnv.cleanup();
const passed = results.filter(Boolean).length;
console.log(`\n합계: ${passed}/${results.length} PASS, ${results.length - passed} FAIL`);
process.exit(passed === results.length && results.length === 8 ? 0 : 1);
