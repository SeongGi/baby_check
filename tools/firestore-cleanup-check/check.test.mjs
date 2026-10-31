// 점검 스크립트 단위 검사(07 시나리오 28). 네트워크와 실데이터를 쓰지 않습니다.
//   node check.test.mjs   (종료 코드 0이면 전부 통과)
// 해시 대조를 위해 하네스 loader를 스스로 등록해 앱의 firestoreImport.ts와 서버의 index.ts를 불러옵니다.
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareFamily, runCleanupCheck } from './compare.mjs';
import { d1FamilyId, firestoreFamilyId } from './hash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
register(pathToFileURL(path.join(ROOT, 'tools/sync-harness/loader.mjs')), pathToFileURL(`${ROOT}/`));

let failures = 0;
const check = (name, passed, detail) => {
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const live = (id, updatedAt = 100) => ({ id, deleted: false, updatedAt });
const tomb = (id) => ({ id, deleted: true, updatedAt: 0 });
const d1Live = (id, clientUpdatedAt = 100) => ({ id, deleted: false, clientUpdatedAt });
const d1Tomb = (id, clientUpdatedAt = 100) => ({ id, deleted: true, clientUpdatedAt });

// ───── compareFamily ─────
{
  const r = compareFamily({ firestoreLogs: [live('a'), live('b')], d1Rows: [d1Live('a')] });
  check('Firestore에만 있는 기록은 missing이고 실패', !r.ok && same(r.missing, ['b']) && r.staleUpdates.length === 0 && r.tombstoneMissing.length === 0, JSON.stringify(r));
}
{
  const r = compareFamily({ firestoreLogs: [live('a'), live('b')], d1Rows: [d1Live('a'), d1Live('b')] });
  check('그 기록이 D1에 오른 뒤에는 통과', r.ok && r.missing.length + r.staleUpdates.length + r.tombstoneMissing.length === 0);
}
{
  const r = compareFamily({ firestoreLogs: [live('a', 500)], d1Rows: [d1Live('a', 400)] });
  check('Firestore가 더 새 수정본이면 staleUpdates이고 실패', !r.ok && same(r.staleUpdates, ['a']) && r.missing.length === 0, JSON.stringify(r));
}
{
  const r = compareFamily({ firestoreLogs: [live('a', 500)], d1Rows: [d1Live('a', 500)] });
  check('D1 수정 시각이 같으면 통과(>= 비교)', r.ok);
}
{
  const r = compareFamily({ firestoreLogs: [live('a', 500)], d1Rows: [d1Live('a', 900)] });
  check('D1 수정본이 더 새로우면 통과', r.ok);
}
{
  const r = compareFamily({ firestoreLogs: [live('a', 500)], d1Rows: [d1Tomb('a', 10)] });
  check('D1이 삭제 표식이면 오래된 시각이어도 통과(삭제가 이긴다)', r.ok, JSON.stringify(r));
}
{
  const r = compareFamily({ firestoreLogs: [live('a', 500)], d1Rows: [d1Tomb('a', 10)] });
  check('D1 삭제 표식은 missing도 아님', r.missing.length === 0);
}
{
  const r = compareFamily({ firestoreLogs: [tomb('a')], d1Rows: [] });
  check('Firestore 삭제 표식이 D1에 없으면 tombstoneMissing이고 실패', !r.ok && same(r.tombstoneMissing, ['a']) && r.missing.length === 0, JSON.stringify(r));
}
{
  const r = compareFamily({ firestoreLogs: [tomb('a')], d1Rows: [d1Live('a', 999)] });
  check('Firestore 삭제 표식인데 D1이 살아 있으면 tombstoneMissing이고 실패', !r.ok && same(r.tombstoneMissing, ['a']), JSON.stringify(r));
}
{
  const r = compareFamily({ firestoreLogs: [tomb('a')], d1Rows: [d1Tomb('a')] });
  check('Firestore와 D1 모두 삭제 표식이면 통과', r.ok);
}
{
  const r = compareFamily({ firestoreLogs: [], d1Rows: [d1Live('x')] });
  check('D1에만 있는 기록은 차이가 아님', r.ok);
}

// ───── runCleanupCheck(가짜 source) ─────
const makeSource = ({ firestore, d1, deleted = [] }) => ({
  firestoreFamilyId,
  d1FamilyId,
  listFirestoreFamilyIds: async () => Object.keys(firestore),
  readFirestoreLogs: async (id) => firestore[id],
  isD1FamilyDeleted: async (id) => deleted.includes(id),
  readD1Rows: async (id) => d1[id] ?? [],
});

const KEY = 'AbCdEf0123456789xyz';
const fid = await firestoreFamilyId(KEY);
const did = await d1FamilyId(KEY);

{
  const source = makeSource({ firestore: { [fid]: [live('a'), live('b')] }, d1: { [did]: [d1Live('a')] } });
  const r = await runCleanupCheck({ keys: [KEY], source });
  const f = r.families[0];
  check('시나리오 28: Firestore에만 있는 기록 하나 → diff, failedCount 1',
    r.failedCount === 1 && f.status === 'diff' && same(f.diff.missing, ['b']) && f.firestoreFamilyId === fid, JSON.stringify(r));
  check('키 힌트는 길이와 앞 4자만', f.keyHint === `길이 ${KEY.length}, 앞 4자 AbCd` && !JSON.stringify(r).includes(KEY), f.keyHint);
}
{
  const source = makeSource({ firestore: { [fid]: [live('a'), live('b')] }, d1: { [did]: [d1Live('a'), d1Live('b')] } });
  const r = await runCleanupCheck({ keys: [KEY], source });
  check('시나리오 28: 그 기록이 D1에 오른 뒤 → ok, failedCount 0', r.failedCount === 0 && r.families[0].status === 'ok', JSON.stringify(r));
}
{
  const source = makeSource({ firestore: { [fid]: [live('a', 500)] }, d1: { [did]: [d1Live('a', 400)] } });
  const r = await runCleanupCheck({ keys: [KEY], source });
  check('시나리오 28: Firestore가 더 새 수정본 → diff', r.failedCount === 1 && same(r.families[0].diff.staleUpdates, ['a']), JSON.stringify(r));
}
{
  const source = makeSource({ firestore: { [fid]: [live('a', 500)] }, d1: { [did]: [d1Tomb('a', 10)] } });
  const r = await runCleanupCheck({ keys: [KEY], source });
  check('시나리오 28: D1이 삭제 표식이면 통과', r.failedCount === 0 && r.families[0].status === 'ok');
}
{
  const source = makeSource({ firestore: { [fid]: [tomb('a')] }, d1: { [did]: [] } });
  const r = await runCleanupCheck({ keys: [KEY], source });
  check('시나리오 28: Firestore 삭제 표식이 D1에 없음 → diff', r.failedCount === 1 && same(r.families[0].diff.tombstoneMissing, ['a']), JSON.stringify(r));
}
{
  // deleted_families에 있으면 D1 행이 없어도(Firestore에 기록이 남아 있어도) 비교하지 않는다.
  const source = makeSource({ firestore: { [fid]: [live('a'), tomb('b')] }, d1: {}, deleted: [did] });
  const r = await runCleanupCheck({ keys: [KEY], source });
  check('시나리오 28: deleted_families 가족 → deleted이고 실패 아님', r.failedCount === 0 && r.families[0].status === 'deleted' && !r.families[0].diff, JSON.stringify(r));
}
{
  const source = makeSource({ firestore: { [fid]: [live('a')], [await firestoreFamilyId('otherkey1234567890')]: [live('z')] }, d1: { [did]: [d1Live('a')] } });
  const r = await runCleanupCheck({ keys: [KEY], source });
  const unpaired = r.families.find((f) => f.status === 'unpaired');
  check('시나리오 28: 키 없는 가족 → unpaired이고 실패 아님', r.failedCount === 0 && unpaired && !unpaired.keyHint && r.families.length === 2, JSON.stringify(r));
}
{
  // 짝 찾기: Firestore는 원래 키, D1은 소문자 키 기준이라 두 id가 달라도 같은 키로 짝이 이어져야 한다.
  check('대문자 키는 두 해시가 다르다', fid !== did);
  const source = makeSource({ firestore: { [fid]: [live('a')] }, d1: { [did]: [d1Live('a')] } });
  const r = await runCleanupCheck({ keys: [KEY], source });
  check('대문자 키도 두 해시로 짝이 이어진다', r.families[0].status === 'ok');
}
{
  const source = { ...makeSource({ firestore: { [fid]: [live('a')] }, d1: {} }), readD1Rows: async () => { throw new Error('boom'); } };
  let thrown = false;
  await runCleanupCheck({ keys: [KEY], source }).catch(() => { thrown = true; });
  check('읽기 오류는 통과로 세지 않고 그대로 던진다', thrown);
}

// ───── 해시 대조: 앱(firestoreImport.ts)과 서버(index.ts) ─────
const app = await import(pathToFileURL(path.join(ROOT, 'src/database/firestoreImport.ts')));
const server = (await import(pathToFileURL(path.join(ROOT, 'server/src/index.ts')))).default;

// 서버의 sha256Hex는 export되지 않으므로, 가짜 D1을 넣고 /api/family/connect를 불러
// 서버가 가족 행 조회에 bind한 familyId를 가져옵니다(실제 서버 코드가 만든 값).
const serverFamilyId = async (key) => {
  const bound = [];
  const statement = (args) => ({
    bind: (...next) => statement([...args, ...next]),
    first: async () => { bound.push(args); return null; },
    run: async () => ({ meta: { changes: 0 } }),
    all: async () => ({ results: [] }),
  });
  const env = { DB: { prepare: () => statement([]) } };
  await server.fetch(new Request('https://example.test/api/family/connect', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Client-Id': 'check' },
    body: JSON.stringify({ allowCreate: false }),
  }), env);
  return bound[0]?.[0];
};

for (const key of ['abcdef0123456789xyz', 'AbCdEf0123456789xyz', 'ZZZZ-yyyy_0000-1111']) {
  const appId = (await app.firestoreFamilyCredentials(key)).familyId;
  check(`Firestore 해시가 앱 firestoreFamilyCredentials와 같다(키 길이 ${key.length}, 앞 4자 ${key.slice(0, 4)})`, appId === (await firestoreFamilyId(key)));
  const serverId = await serverFamilyId(key);
  check(`D1 해시가 서버 index.ts가 만든 가족 id와 같다(키 길이 ${key.length}, 앞 4자 ${key.slice(0, 4)})`, typeof serverId === 'string' && serverId === (await d1FamilyId(key)), serverId ? `서버 id 앞 4자 ${serverId.slice(0, 4)}` : '서버 id를 얻지 못함');
  // 서버의 소문자 정규화를 확인: 앱 해시를 소문자 키에 적용하면 D1 해시와 같아야 한다.
  check(`D1 해시는 앱 해시를 소문자 키에 적용한 값과 같다(앞 4자 ${key.slice(0, 4)})`, (await app.firestoreFamilyCredentials(key.toLowerCase())).familyId === (await d1FamilyId(key)));
}

console.log(failures === 0 ? '\n전부 통과' : `\n실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
