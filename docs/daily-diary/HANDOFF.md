# 인수인계: 한줄 육아일기 기능

- 워크트리: `/Users/seonggi/Desktop/PDS/dev/baby-check-diary`, 브랜치 `feat/daily-diary`(origin/master `ff25772` 기준, 1.8.0 Cloudflare 동기화 포함)
- 이전 세션 ID: `6a282913-e40c-4cda-aea9-1cda70579dfc` (`claude --resume`으로 복구할 수 있다)
- 응답은 항상 한국어로 하고, 쉬운 말로 먼저 요약한다(좋음/문제).

## 1. 성기님 요청 (2026-10-31)
- 성기님 말씀: "한줄 육아일기 추가해줄래. 오늘 어땠고 그런 걸 적고 싶어"
- 성기님이 고른 요구사항:
  1. **가족과 함께 본다.** 다른 기록처럼 새 동기화 서버(Cloudflare D1)로 서로의 휴대폰에 보인다. 누가 썼는지도 보인다.
  2. **하루 한 줄.** 날짜마다 한 줄을 쓰고, 다시 쓰면 고친다. 가족이 함께 쓰면 사람마다 한 줄씩 남는다.
  3. **홈 + 모아보기.** 홈 화면에 "오늘의 한 줄" 칸을 두고, 지난 일기는 날짜별 목록으로 모아 본다.

## 2. 알려진 사실과 제약
- 서버(`server/src/index.ts`)는 기록 종류(`type`)를 검사하지 않고 `logs.raw_json`에 그대로 저장한다. 체온 기록(`temperatureC`)도 그렇게 추가됐다. 그래서 서버 변경 없이 새 기록 종류로 넣을 수 있는지 먼저 확인한다. 다만 1.8.0 이전 버전이나 옛 기기가 모르는 `type`을 받았을 때 깨지지 않는지(`storage.ts`의 `readLogsUnsafe`, 이전 모듈의 payload 검증 `type`이 문자열인지)를 반드시 확인한다.
- "사람마다 한 줄"을 지키려면 기록 id를 날짜와 작성자로 정해서(예: 날짜 + 기기 clientId) 같은 날 다시 쓰면 같은 id를 고치게 하는 방법이 있다. 동기화는 같은 id에 대해 나중 수정이 이기는 방식(`client_updated_at`)이다. 설계에서 정한다.
- **기존 데이터는 절대 지워지면 안 된다.** 실사용 가족 하나(기록 약 2,439건)가 1.8.0으로 막 옮겨 왔다. 일기 기능이 기존 기록을 덮거나 지우는 경로가 없어야 한다.
- 동기화가 필요 없는 사용자(가족 연결 없음)는 네트워크 요청 0회여야 한다.
- 프로젝트 지침: `AGENTS.md`(Expo v56 문서를 먼저 읽는다). 작업 흐름은 `~/.codex/AGENTS.md`(요구사항 → 설계 → 독립 검토 최대 3회 → 커밋 단위 계획 → 구현 → 독립 리뷰 2개 → 전체 테스트와 변이 검증). 문서는 이 폴더에 `01-요구사항.md`~`04-검증.md`로 둔다.
- 동기화 설계 참고: `docs/cloudflare-sync-migration/06-동기화-결함-수정-설계.md`, `07-기존사용자-이전-설계.md`. 검사 하네스: `tools/sync-harness/verify.sh offline`(여러 프로세스를 띄우므로 `(ulimit -u $(( $(ps -u $(id -u) -o pid= | wc -l) + 150 )); <명령>)` 안에서 돌린다), `npx tsc --noEmit`, `npx tsc --noEmit --project server/tsconfig.json`, `npm run test:voice`.

## 3. 건드리면 안 되는 것
- `npx expo run:android`와 `expo prebuild`는 쓰지 않는다. 빌드는 `android/`에서 `./gradlew`로 한다(`JAVA_HOME=/opt/homebrew/opt/openjdk@17`, `ANDROID_HOME=~/Library/Android/sdk`). 새 워크트리의 `android/`에는 `gradlew`가 없으므로, 빌드가 필요해지면 `../baby-check/android/`에서 빠진 파일만 `rsync --ignore-existing`(build, .gradle, .cxx 제외)으로 복사한다. 서명 값은 `../baby-check/credentials.json`에서 `ORG_GRADLE_PROJECT_BABY_CHECK_RELEASE_*` 환경 변수로 넘기고 화면에 내지 않는다.
- 다른 워크트리(`../baby-check`, `../baby-check-keyboard`, `../baby-check-cloudflare`)는 건드리지 않는다. 특히 `../baby-check-cloudflare`에는 아직 푸시하지 않은 서버 수정(`467f2e6`, 운영에는 이미 배포됨)이 있고 다른 세션이 이어서 처리한다.
- Firestore와 운영 D1에는 쓰거나 지우지 않는다. 실사용자에게 앱 삭제나 재설치를 안내하지 않는다.
- `git stash`를 쓰지 않는다.

## 4. 승인 전 (실행 직전에 성기님께 확인)
- 푸시, PR, 머지, 서버 배포, 버전 올리기 뒤 Play 업로드(다음 버전 1.8.1, 코드 29 예정)와 원스토어 APK.

## 5. 다음 세션이 할 일 (이 순서대로)
1. `git log --oneline -2`로 맨 위가 이 문서 커밋이고 그 아래가 `ff25772`인지, 작업 트리가 깨끗한지 확인한다.
2. 겹치는 PR이 없는지(`gh pr list`) 보고, 기록 종류 정의(`src/types` 등), 홈 화면, 통계·목록 화면, `storage.ts`, 동기화 코드에서 관련 위치를 찾는다.
3. `01-요구사항.md`를 쓰고 성기님께 짧게 확인받는다. 열린 질문 예: 글자 수 상한, 지난 날짜 일기 쓰기 허용 여부, 일기 삭제, 백업 내보내기 포함 여부, 통계 화면 영향.
4. `02-설계.md` → 독립 검토(최대 3회, 승인 안 되면 멈추고 보고) → `03-계획.md` → 구현(여러 파일이면 t1-worker에 위임) → 독립 리뷰 2개 → 전체 검사와 변이 검증 → `04-검증.md`.
5. 로컬 커밋은 해도 된다. 4장 항목은 모두 승인 전이다.
