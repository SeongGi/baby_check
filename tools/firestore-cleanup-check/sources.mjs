// 실데이터 어댑터. 읽기만 합니다. 이 파일을 불러오는 것만으로는 접속하지 않고,
// createRealSource()를 부르고 그 메서드를 쓸 때 접속합니다. 점검 시험에서는 쓰지 않습니다.
//  - Firestore: firebase-admin으로 읽기(listDocuments, get)만. 서비스 계정 JSON은 GOOGLE_APPLICATION_CREDENTIALS.
//  - D1: wrangler d1 execute --remote --json --command "SELECT ..." 만. SELECT가 아닌 문장은 실행 전에 거부합니다.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { d1FamilyId, firestoreFamilyId } from './hash.mjs';

const run = promisify(execFile);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server');
const FAMILY_ID_PATTERN = /^[0-9a-f]{64}$/;

/** server/wrangler.toml의 database_name을 읽습니다. */
export const readD1DatabaseName = () => {
  const toml = readFileSync(path.join(SERVER_DIR, 'wrangler.toml'), 'utf8');
  const match = toml.match(/^\s*database_name\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('server/wrangler.toml에서 database_name을 찾지 못했습니다.');
  return match[1];
};

const assertFamilyId = (id) => {
  if (!FAMILY_ID_PATTERN.test(id)) throw new Error('가족 id 형식이 올바르지 않습니다(소문자 16진수 64자).');
  return id;
};

/** wrangler로 SELECT 한 문장을 실행하고 결과 행을 돌려줍니다. */
const selectD1 = async (database, sql) => {
  if (!/^\s*SELECT\s/.test(sql)) throw new Error('읽기 전용 점검은 SELECT만 실행합니다.');
  const { stdout } = await run('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql], {
    cwd: SERVER_DIR,
    maxBuffer: 256 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false) throw new Error('D1 질의가 실패했습니다.');
  return first.results ?? [];
};

const toMillis = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  return 0;
};

export async function createRealSource({ database = readD1DatabaseName() } = {}) {
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp({ credential: applicationDefault() });
  const db = getFirestore(app);

  return {
    firestoreFamilyId,
    d1FamilyId,

    // 하위 컬렉션만 있는 가족 문서도 보이도록 listDocuments를 씁니다.
    async listFirestoreFamilyIds() {
      const refs = await db.collection('families').listDocuments();
      return refs.map((ref) => ref.id).sort();
    },

    // 살아 있는 기록은 payload.updatedAt(없으면 timestamp), 삭제 표식은 deleted === true입니다(1.7.9 sync.ts).
    async readFirestoreLogs(familyId) {
      const snapshot = await db.collection('families').doc(familyId).collection('logs').get();
      return snapshot.docs.map((document) => {
        const data = document.data();
        const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
        return {
          id: document.id,
          deleted: data.deleted === true,
          updatedAt: toMillis(payload.updatedAt) || toMillis(payload.timestamp),
        };
      });
    },

    async isD1FamilyDeleted(id) {
      const rows = await selectD1(database, `SELECT 1 AS found FROM deleted_families WHERE id = '${assertFamilyId(id)}'`);
      return rows.length > 0;
    },

    async readD1Rows(id) {
      const rows = await selectD1(
        database,
        `SELECT log_id, client_updated_at, deleted_at FROM logs WHERE family_id = '${assertFamilyId(id)}'`,
      );
      return rows.map((row) => ({
        id: String(row.log_id),
        deleted: row.deleted_at !== null && row.deleted_at !== undefined,
        clientUpdatedAt: Number(row.client_updated_at),
      }));
    },
  };
}
