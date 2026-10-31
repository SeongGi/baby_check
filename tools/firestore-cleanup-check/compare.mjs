// 운영자 정리 전 점검의 핵심 비교(07 2.8 정리 조건 2). 외부 의존이 없는 순수 함수입니다.
// 실제 Firestore와 D1은 `source` 객체 뒤에 숨기므로, 시험에서는 가짜 source를 넣어 같은 판정을 돌릴 수 있습니다.
import { d1FamilyId as defaultD1FamilyId, firestoreFamilyId as defaultFirestoreFamilyId, hint } from './hash.mjs';

const sorted = (ids) => [...ids].sort();

/**
 * 가족 하나의 기록 단위 비교.
 *  - missing: Firestore 살아 있는 기록인데 D1에 행(살아 있든 삭제 표식이든)이 없음
 *  - staleUpdates: 둘 다 살아 있는데 D1의 clientUpdatedAt이 Firestore의 updatedAt보다 오래됨.
 *    D1 행이 삭제 표식이면 통과(삭제가 이긴다)
 *  - tombstoneMissing: Firestore 삭제 표식인데 D1에 삭제 표식이 없음(행이 없거나 살아 있음)
 */
export function compareFamily({ firestoreLogs, d1Rows }) {
  const d1ById = Object.fromEntries(d1Rows.map((row) => [row.id, row]));
  const missing = [];
  const staleUpdates = [];
  const tombstoneMissing = [];
  for (const log of firestoreLogs) {
    const row = d1ById[log.id];
    if (log.deleted) {
      if (!row || !row.deleted) tombstoneMissing.push(log.id);
      continue;
    }
    if (!row) {
      missing.push(log.id);
      continue;
    }
    if (row.deleted) continue;
    if (row.clientUpdatedAt < log.updatedAt) staleUpdates.push(log.id);
  }
  const result = {
    missing: sorted(missing),
    staleUpdates: sorted(staleUpdates),
    tombstoneMissing: sorted(tombstoneMissing),
  };
  return {
    ok: result.missing.length === 0 && result.staleUpdates.length === 0 && result.tombstoneMissing.length === 0,
    ...result,
  };
}

/**
 * Firestore의 모든 가족을 훑어 가족별 상태를 냅니다.
 *  - deleted: D1 deleted_families에 있음(비교하지 않음, 실패로 세지 않음)
 *  - unpaired: 입력한 키 중 짝이 없는 Firestore 가족(실패로 세지 않음, 가족별로 사람이 판단)
 *  - ok / diff: 기록 단위 비교 결과. diff만 failedCount에 들어갑니다.
 * source 읽기가 던지는 오류는 잡지 않고 그대로 올립니다(읽지 못한 가족을 통과로 세지 않기 위해).
 */
export async function runCleanupCheck({ keys, source }) {
  const toFirestoreId = source.firestoreFamilyId ?? defaultFirestoreFamilyId;
  const toD1Id = source.d1FamilyId ?? defaultD1FamilyId;

  // Firestore 가족 id -> { key, d1Id }. 같은 가족 id를 가리키는 키가 여럿이어도 첫 키만 씁니다.
  const paired = {};
  for (const key of keys) {
    const firestoreId = await toFirestoreId(key);
    if (!(firestoreId in paired)) paired[firestoreId] = { key, d1Id: await toD1Id(key) };
  }

  const families = [];
  let failedCount = 0;
  for (const firestoreFamilyId of await source.listFirestoreFamilyIds()) {
    const pair = paired[firestoreFamilyId];
    if (!pair) {
      families.push({ firestoreFamilyId, status: 'unpaired' });
      continue;
    }
    const keyHint = hint(pair.key);
    if (await source.isD1FamilyDeleted(pair.d1Id)) {
      families.push({ firestoreFamilyId, keyHint, status: 'deleted' });
      continue;
    }
    const diff = compareFamily({
      firestoreLogs: await source.readFirestoreLogs(firestoreFamilyId),
      d1Rows: await source.readD1Rows(pair.d1Id),
    });
    if (diff.ok) {
      families.push({ firestoreFamilyId, keyHint, status: 'ok' });
    } else {
      failedCount += 1;
      const { missing, staleUpdates, tombstoneMissing } = diff;
      families.push({ firestoreFamilyId, keyHint, status: 'diff', diff: { missing, staleUpdates, tombstoneMissing } });
    }
  }
  return { families, failedCount };
}
