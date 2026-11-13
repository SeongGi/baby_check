# 인수인계: 상대 기기 기록 알림 (1.8.3 예정)

- 워크트리: `/Users/seonggi/Desktop/PDS/dev/baby-check-push`, 브랜치 `feat/partner-push` (origin에 올리지 않음)
- 이전 세션 ID: `afd0b677-1c55-4f4f-a8f9-e4aec0eb714f` (`claude --resume`으로 복구할 수 있다)
- 응답은 항상 한국어로 하고, 쉬운 말로 먼저 요약한다.
- 작업 흐름은 `~/.codex/AGENTS.md` 기본 흐름(요구사항 → 설계 → 계획 → 구현과 독립 리뷰 2개 → 전체 테스트와 임시 변이 검증)을 따른다.

## 1. 현재 상태 (2026-11-13)
- 문서: `01-요구사항.md`(성기님 1차·2차 결정 반영), `02-설계.md`(1회차 독립 검토 조건부 승인 반영, 9장에 반영표), `03-계획.md`(커밋 7개).
- 선행 PR #21(권한 사전 안내)은 성기님 승인을 받아 master에 머지했다(`b8e33e6`). 이 브랜치는 그 master 위로 옮겼다.
- 계획의 커밋 1~3(서버와 하네스)이 끝났다. t1-worker가 구현했고, 주 세션은 테스트를 다시 돌려 확인했다.
  - `5f89db7` 하네스: `ctx.waitUntil` 전달, 가짜 Expo 서버
  - `16c1fa2` `push_devices` 테이블, 등록·해제 API, 영구 삭제 정리
  - `9addb87` sync 안의 새 기록 판정과 백그라운드 발송 (`server/src/push.ts`)
- 옮긴 뒤 재검증(주 세션 실행): 앱·서버 `tsc` 통과, `verify.sh push` 25/25, `unit` 117/117, `regression` rc=0, `offline` rc=0, `tests/permissionNotice.mjs` 통과.
- 구현 에이전트가 한 임시 변이: 30분 조건 제거 → P3·P13·P14 실패, 보낸 기기 제외 제거 → P1 실패, 배치 안 존재 확인 제거 → P2·P12 실패. 모두 원복했다.

## 1-1. 2026-11-13 밤 갱신 (세션 d1aae06b)
- 커밋 1~3 리뷰 반영(`e6c38f5`), 커밋 4(`b6c2471`), 커밋 5(`3afd4b5`, App 연결), 커밋 6(`1627118`, 설정 카드와 개인정보처리방침)이 끝났다.
- 커밋 5·6의 독립 리뷰 2개가 끝났다. 꼭 고칠 것은 iOS 토큰 조회 반복과 수유 문구로 뜨는 권한 사전 안내다. 고치면 좋은 것은 채널 생성 순서, "나중에" 처리, 방해 금지 시간 앞 화면 소리, 토큰 오류 재토글, 카드 안내 문구, 개인정보처리방침 04절이다. t1-worker가 반영 커밋을 만드는 중이다.
- `1627118` 기준 재검증: 앱과 서버 `tsc` 0, `partnerPush` 34개 통과, `verify.sh push` 25/25, `offline`은 시나리오 [32] 한 건이 30초 시간 초과로 실패했다. 리뷰 에이전트와 동시에 돌린 탓으로 보며 단독으로 두 번 다시 돌리니 2.7초에 통과했다. `reminder`도 통과했다.
- 다음: 반영 커밋 확인 → 웹 export 카드 스크린샷 → 커밋 7(대량 업로드 시나리오, `04-검증.md`, 남은 임시 변이) → 성기님께 보고.

## 1-2. 커밋 7까지 끝남 (2026-11-13 밤)
- `075739c`(커밋 5·6 리뷰 반영), `6dfda28`(서버 `data.quiet`), `a3c54e1`(대량 업로드 시나리오 10개)가 끝났다. 결과는 `04-검증.md`에 있다.
- 남은 일: 설정 카드 웹 export 스크린샷, 성기님께 결과와 승인 목록 보고. 그 뒤 일은 모두 5장의 승인 전 목록이다.

## 0. 2026-11-13 23:55 인수인계: 출시 전체 진행 (이 장을 먼저 읽는다)

이전 세션: `d1aae06b-e16e-4600-8d02-e8463cb8de32` (Hide 창, `claude --resume`으로 복구 가능)

### 지금 상태
- 코드와 검증은 끝났다. 커밋 1~7, 리뷰 반영, `04-검증.md`, 카드 스크린샷(`b6ee0f4`)까지 로컬 커밋만 있고 origin에는 올리지 않았다.
- 테스트(`a3c54e1` 기준, 주 세션이 다시 돌림): 앱과 서버 tsc 0, partnerPush 44개, push 25/25, 푸시 시나리오 10/10. offline은 rc=0(구현 에이전트가 돌림).

### 받은 허락 (성기님, 2026-11-13 23:5x, 원문 "1번을 왜 .. 너가 전체 진행해줘")
아래를 **모두 직접 진행하라는 허락**을 받았다. 다시 묻지 말고 순서대로 하되, 결과는 단계마다 보고한다.
1. Firebase 프로젝트 `babycheck-sync`에 Android 앱(`com.seonggi.babycheck`) 등록, `google-services.json` 받기, FCM V1용 서비스 계정 키를 Expo(EAS) 프로젝트에 등록, Expo push 보안 설정 확인
2. 운영 D1에 `push_devices` 테이블 추가(`server/schema.sql`의 해당 CREATE만, 기존 표는 건드리지 않음)와 Worker 배포. **서버를 앱보다 먼저** 낸다.
3. `feat/partner-push` 푸시, PR, 머지
4. 버전 1.8.3(코드 31) 올리기, Play AAB와 원스토어 APK 빌드, Play와 원스토어 등록, Play 데이터 보안 항목 수정(Expo와 FCM 전달 추가)

### 막힐 수 있는 곳과 처리
- `firebase`, `eas`, `wrangler` 명령은 전역에 없다. `npx firebase-tools`, `npx eas-cli`, `cd server && npx wrangler`로 쓴다. gcloud는 로그인돼 있다(gmail 계정). Expo 로그인 상태는 `~/.expo/state.json`에 있다.
- FCM V1 키 등록은 `eas credentials`가 대화형이다. 대화형으로 안 되면 expo.dev 웹 화면으로 한다. 브라우저 조작은 Claude in Chrome 확장이 이 세션에서 연결되지 않았으므로 `orca computer`(orca-computer-use 스킬)를 쓴다.
- 서비스 계정 키 JSON은 저장소에 넣지 않고 화면에 출력하지 않는다. 등록 뒤 로컬 사본은 지운다.
- 빌드는 `expo prebuild`나 `expo run:android`를 쓰지 않는다. `android/`(git에 없음)에서 `./gradlew`로 한다(`docs/daily-diary/HANDOFF.md`의 방법, `JAVA_HOME=/opt/homebrew/opt/openjdk@17`). FCM을 쓰려면 `android/app/google-services.json`과 Gradle의 google-services 플러그인이 필요하다. `app.json`에도 `android.googleServicesFile`을 넣는다.
- 원스토어 APK는 `EXPO_PUBLIC_DISTRIBUTION_STORE=onestore`로 따로 빌드한다. 서명은 Play와 원스토어 모두 EAS 키다(메모리 "서명 키 결정").
- 사용자를 묻기 전에 운영 D1 데이터를 읽기 전용으로 확인한다. 실사용자 2명의 기록은 절대 지우거나 덮어쓰지 않는다(메모리 "jjukkom 데이터 보전").
- gh 기본 계정은 쓰기 권한이 없다. `GH_TOKEN=$(gh auth token -u SeongGi)`를 그 명령에만 쓴다. 전역 `gh auth switch`는 하지 않는다.
- 많은 프로세스를 띄우는 명령은 `(ulimit -u $(( $(ps -u $(id -u) -o pid= | wc -l) + 150 )); <명령>)`으로 감싼다.
- 4b 시나리오 [32]는 부하가 많으면 30초 대기로 한 번 실패할 수 있다. 그 파일만 다시 돌려 확인한다.

### 진행 기록 (2026-11-14 00시, 세션 4a7d7a43)
1. Firebase: Android 앱 `1:446080458953:android:703026ffba89a9a4606d18`을 API로 등록하고 `google-services.json`을 저장소 루트에 받았다. `firebase-adminsdk-fbsvc` 계정에 새 키를 만들어 Expo GraphQL API로 올리고(키 id `ed10d9ba-…`) Android 자격 증명 `165591e4-…`의 FCM V1 키로 연결했다. 로컬 키 사본은 지웠다. Expo `pushSecurityEnabled`는 false라 서버에 접근 토큰이 필요 없다.
2. 서버: 운영 D1에 `push_devices` 표와 색인만 만들었다. 전후 행 수는 families 7, members 8, logs 2775, deleted_families 0으로 같다. Worker 버전 `7b2569a4`를 배포했다(이전 버전 `360f2ef1`). 인증 없는 `/push-register`, `/sync`는 401이다.
3. 빌드: `android/app/build.gradle`에 google-services 플러그인을 넣었다(루트 build.gradle이 git에 없어 classpath도 앱 모듈에 둔다). 빌드 전에 `google-services.json`을 `android/app/`에 복사해야 한다. Play AAB `~/Desktop/babycheck-1.8.3-code31.aab`, 원스토어 APK `~/Desktop/babycheck-1.8.3-code31-onestore.apk`를 만들었고, 서명 SHA-256은 1.8.2와 같은 `6A:92:…:09:ED:73`이다.

### 남겨 둘 것
- tmux `PDS`의 이전 세션(76194178)은 성기님이 두라고 했다. 끄지 않는다.
- 텔레그램 연동은 같은 날 고쳤다(`~/.ccgram-focus/hide-bridge.mjs`, patch v11, `live-sessions.js`). 건드리지 않는다.
- 카드 위치(수유 카드와 저장 버튼 사이)는 그대로 두었다. 성기님이 옮기라고 하면 옮긴다.

## 2. 커밋 1~3에서 아직 하지 않은 것
1. **독립 리뷰 2개가 아직 없다.** 다음 세션이 먼저 돌린다. 하나는 `02-설계.md`와 맞는지, 하나는 정확성 버그만 본다. 대상은 `git diff e29c745..9addb87`이다.
2. 구현 에이전트가 설계와 다르게 하거나 덧붙인 점이 있다. 리뷰 때 함께 확인한다.
   - `sendPartnerPush` 첫 줄에 `await Promise.resolve()`가 있다. 하네스가 백그라운드 쿼리를 따로 세려고 넣었다(d1-mock `redirectTo`).
   - 같은 id가 여러 쓰기 배치에 걸칠 때 쓰는 `writtenCandidateIds` 보완(P13이 검사).
   - 숫자 표기: 분유량과 목욕 시간은 소수 첫째 자리, 끝 0 제거. 기간은 "1시간 20분", "1시간", "25분". 종료 시각이 시작보다 앞서면 수치를 뺀다.
   - `verify.sh push`(약 15초)는 offline과 all에 넣지 않았다.
3. **결정할 일:** `push-register`는 같은 토큰을 가진 다른 행을 멤버십 확인 없이 지운다. 그래서 403을 받는 요청도 옛 행을 지운다. 주 세션의 판단은 DELETE에 `EXISTS(members)` 조건을 붙이는 쪽이 맞다는 것이다. 설계 2.2를 고치고, 리뷰 반영 때 함께 수정한다.

## 3. 다음 세션이 할 일 (이 순서대로)
1. 2장 1~3을 처리한다(리뷰 2개 → 반영, 최대 3회).
2. 계획 커밋 4~6(앱)을 진행한다. `02-설계.md` 3장, 6장 앱 단위 테스트가 기준이다. 여러 파일 구현은 t1-worker에 맡기고, 주 세션은 diff와 실제 테스트 출력을 확인한다.
   - 권한 요청은 머지된 `src/utils/permissionNotice.ts`의 사전 안내를 거친다.
3. 커밋 7: device-real 대량 업로드 시나리오와 `04-검증.md`, 남은 임시 변이(02 6장)를 처리한다.
4. 끝나면 성기님께 결과와 승인 목록을 보고한다.

## 4. 이미 받은 허락
- 01·02 결정 사항 전부와 PR #21 머지(끝남).
- 이 브랜치의 로컬 커밋.

## 5. 승인 전 (반드시 따로 묻는다)
- `feat/partner-push` 푸시와 PR, 머지
- 운영 D1에 `push_devices` 테이블 추가(`wrangler d1 execute --remote`), Worker 배포
- Firebase 콘솔 Android 앱 등록, `google-services.json`, FCM 키를 EAS에 등록(성기님 작업), Expo push 보안 설정 확인
- 버전 1.8.3(코드 31) 올리기, 빌드, Play·원스토어 등록, Play 데이터 보안 수정

## 6. 하지 말 것
- `npx expo run:android`, `expo prebuild`를 쓰지 않는다.
- Firestore에 쓰거나 지우지 않는다. 서명 값, 서비스 계정 키, 토큰을 화면에 출력하거나 저장소에 넣지 않는다.
- 하네스에서 외부망(exp.host)을 호출하지 않는다.
- gh 기본 계정(`seonggi1547`)은 이 저장소 쓰기 권한이 없다. 승인을 받은 뒤 푸시와 PR은 `gh auth token -u SeongGi` 토큰으로 그 명령에만 쓴다. 전역 `gh auth switch`는 하지 않는다.
- 많은 프로세스를 띄우는 명령은 `(ulimit -u $(( $(ps -u $(id -u) -o pid= | wc -l) + 150 )); <명령>)`으로 감싼다.
