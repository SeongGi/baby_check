# Firestore 운영자 정리 전 점검 (읽기 전용)

> **상태: 승인 전.** 이 스크립트를 실제 Firestore와 D1에 대고 실행하는 것은 성기님 승인 후에만 합니다.
> 코드와 단위 검사만 저장소에 있고, 실데이터 실행 기록은 아직 없습니다.

## 목적
`docs/cloudflare-sync-migration/07-기존사용자-이전-설계.md` 2.8의 **정리 조건 2(기록 단위 비교)** 를 확인합니다.
Firebase 콘솔에서 `families` 컬렉션을 지우기 전에, 가족마다 아래가 모두 맞는지 봅니다.

- Firestore의 살아 있는 기록 문서 id 집합 ⊆ D1의 (살아 있는 행 ∪ 삭제 표식) id 집합 (`missing`)
- 둘 다 살아 있으면 D1 `client_updated_at` ≥ Firestore `payload.updatedAt` (`staleUpdates`). D1 행이 삭제 표식이면 통과(삭제가 이긴다)
- Firestore의 삭제 표식 문서는 D1에도 삭제 표식이 있어야 한다 (`tombstoneMissing`)

차이가 하나라도 있으면 정리하지 않고, 그 기록을 D1로 옮길 방법을 먼저 정합니다. 정리 조건 1(모든 기기가 1.8.0으로 옮겼는지)은
성기님이 두 가족에게 직접 확인하며, 이 스크립트가 대신하지 않습니다.

## 실행 방법 (승인 후)
```sh
cd tools/firestore-cleanup-check
npm install                                   # firebase-admin은 이 폴더에만 설치됩니다
export GOOGLE_APPLICATION_CREDENTIALS=/경로/서비스계정.json
# 키 파일: 한 줄에 가족 키 하나. 빈 줄과 # 로 시작하는 줄은 무시. 저장소에 넣지 않습니다.
node run.mjs --keys-file /경로/keys.txt [--db baby-check-db]
```
- Firestore 가족 id는 원래 키의 해시, D1 가족 id는 소문자 키의 해시라서 id만으로는 짝을 찾지 못합니다. 그래서 키를 입력받아 각자 기준으로 해시합니다(2.3.1).
- `--db`를 주지 않으면 `server/wrangler.toml`의 `database_name`을 씁니다. D1 읽기는 `server/` 안에서 `npx wrangler d1 execute <db> --remote --json --command "SELECT ..."`로 실행하므로 wrangler 로그인이 되어 있어야 합니다.
- 키와 해시는 길이와 앞 4자만 출력합니다. 기록 id는 최대 5개까지 보여 주고 나머지는 개수로 줄입니다.

## 출력 해석
| 상태 | 뜻 | 종료 코드에 영향 |
|---|---|---|
| 통과 | 위 세 조건을 모두 만족 | 없음 |
| 차이 | `missing`, `staleUpdates`, `tombstoneMissing` 중 하나 이상. 정리 금지 | 1 |
| 삭제됨 | D1 `deleted_families`에 있는 가족. 비교하지 않음. 정리 대상에 넣을지는 성기님이 정함(2.8-a) | 없음 |
| 짝 없음 | 입력한 키 중 짝이 없는 Firestore 가족(시험 가족, 떠난 가족). 가족별로 성기님이 판단(2.8-b) | 없음 |

종료 코드: 0 = 차이 없음, 1 = 차이 있음, 2 = 사용법 오류나 읽기 실패(읽지 못한 가족을 통과로 세지 않습니다).
입력한 키 중 Firestore에 가족이 없는 키는 출력에 나오지 않습니다(요약의 가족 수와 입력 키 수를 비교하세요).
통과가 나와도 그 시점의 스냅샷일 뿐이므로, 정리 직전에 한 번 더 돌리는 편이 안전합니다.

## 구성
- `compare.mjs`: 순수 비교. `compareFamily({ firestoreLogs, d1Rows })`, `runCleanupCheck({ keys, source })`
- `hash.mjs`: 두 가족 id 해시(앱 `firestoreFamilyCredentials`, 서버 `getAuthContext`와 같은 계산)와 출력용 힌트
- `sources.mjs`: 실데이터 어댑터(firebase-admin 읽기, wrangler SELECT)
- `run.mjs`: 실행 진입점
- `check.test.mjs`: 단위 검사(시나리오 28). 앱의 `firestoreImport.ts`와 서버의 `index.ts`가 만드는 id와 해시를 대조합니다.

## 검사
```sh
npm test    # = node check.test.mjs. 네트워크와 실데이터를 쓰지 않습니다.
```

## 읽기 전용 보장
- Firestore: `listDocuments()`와 `get()`만 씁니다. 쓰기와 삭제 API는 없습니다.
- D1: `SELECT`로 시작하지 않는 문장은 실행 전에 거부하고, 가족 id는 소문자 16진수 64자만 질의에 넣습니다.
- 확인 명령(결과 없음이어야 합니다):
```sh
grep -nE "\.set\(|\.update\(|\.delete\(|\.add\(|batch|INSERT|UPDATE|DELETE|DROP" tools/firestore-cleanup-check/*.mjs
```
- 서비스 계정에는 읽기 권한만 있는 계정을 쓰는 편이 더 안전합니다(Cloud Datastore 뷰어).
