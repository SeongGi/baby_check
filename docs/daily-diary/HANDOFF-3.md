# 인수인계 3: 한줄 육아일기 (에뮬레이터 화면 확인)

- 워크트리: `/Users/seonggi/Desktop/PDS/dev/baby-check-diary`, 브랜치 `feat/daily-diary`
- 이전 세션 ID: `fc8c80c2-4229-4cd3-a2f7-a3ce1346a8ed` (`claude --resume`으로 복구할 수 있다)
- 응답은 항상 한국어로 하고, 쉬운 말로 먼저 요약한다(좋음/문제).
- `HANDOFF.md`의 2장(제약)과 3장(건드리면 안 되는 것), `HANDOFF-2.md`의 2장(주의)은 그대로 유효하다. 먼저 읽는다.

## 1. 지금 상태 (2026-11-01)
- 리뷰 3회, 전체 검사, 변이 검증을 마쳤다. 결과는 `04-검증.md`에 있다. 모든 커밋은 로컬에만 있고 푸시하지 않았다.
  ```
  c86b20b docs(diary): verification report with full checks and mutation results
  13e6640 test(diary): close surviving mutants in shape checks and editor target picks
  d8e132b fix(diary): hide the write button on future-dated day cards
  cd3a6e1 fix(diary): address post-implementation review findings
  ```
- 성기님이 **실기기 확인용 빌드(승인 전 1번)를 승인했다.** 설치할 곳으로 "에뮬레이터 새로 만들기"를 골랐다.
- 릴리스 APK 빌드에 성공했다.
  - 파일: `android/app/build/outputs/apk/release/app-release.apk`(91MB, 1.8.0, 코드 28, EAS 키로 서명)
  - 빌드 방법: `../baby-check/android/`에서 빠진 파일을 `rsync --ignore-existing`(build, .gradle, .cxx 제외)으로 복사했다. 그 뒤 서명 값을 `ORG_GRADLE_PROJECT_BABY_CHECK_RELEASE_*` 환경 변수로 넘겨 `./gradlew assembleRelease`를 돌렸다. `android/`는 git에 잡히지 않는다.
  - 코드를 고쳐 다시 빌드할 때도 같은 방법을 쓴다. 키스토어 경로는 `../baby-check/credentials.json`의 `android.keystore.keystorePath`이고 `../baby-check`를 기준으로 한다. 서명 값은 화면에 내지 않는다.
- 에뮬레이터 `babycheck_test`(Pixel 6, Android 15 API 35, google_apis arm64)를 만들었다. 아직 켜지 않았다.
  - **주의:** `sdkmanager`(`~/Library/Android/sdk/cmdline-tools/latest`)가 시스템 이미지를 `/opt/homebrew/share/android-commandlinetools/system-images/android-35/google_apis/arm64-v8a`에 설치했다. 에뮬레이터 실행 파일은 `~/Library/Android/sdk/emulator/emulator`다. 이미지를 찾지 못하면 `ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools`로 띄우거나 `~/.android/avd/babycheck_test.avd/config.ini`의 `image.sysdir.1`을 확인한다.
  - `avdmanager`가 `devices.xml` 오류를 냈지만 AVD는 만들어졌다.
  - adb 경로는 `~/Library/Android/sdk/platform-tools/adb`다.

## 2. 다음 세션이 할 일 (이 순서대로)
1. `git log --oneline -5`, `git status --short`(`?? node_modules`만 있어야 한다), `ls ~/.android/avd`로 상태를 확인한다.
2. 에뮬레이터를 백그라운드로 띄운다(`-no-snapshot-save` 권장). `adb wait-for-device` 뒤 `sys.boot_completed`를 확인하고 `adb install -r <apk>`로 설치한다.
3. 가족 연결 없이 화면을 확인하고 스크린샷을 남긴다(`adb exec-out screencap -p > <scratchpad>/xx.png`). 조작은 `adb shell input`이나 `uiautomator dump`로 한다.
   1. 첫 실행, 아기 프로필 만들기
   2. 프로필에서 아빠·엄마 역할 정하기. 역할을 정하기 전에 일기 버튼을 누르면 안내가 뜨는지도 본다.
   3. 홈의 "오늘의 한 줄"에서 쓰기 → 같은 날 다시 쓰기(고치기)
   4. 일기 화면: 지난 날짜에 쓰기, 날짜 이동 한계(생일, 오늘), 고치기·지우기 확인 창, 댓글 달기·지우기
   5. 입력 창: 200자 카운터, 200자에서 더 입력할 때 거부되는지. 한글 입력은 `adb shell input text`로 넣기 어려우므로, 가능한 범위만 보고 한계를 적는다.
   6. 창이 닫힐 때 모양이 바뀌어 보이지 않는지(가능하면 화면 녹화 `adb shell screenrecord`)
   7. 홈 타임라인과 통계에 일기·댓글이 섞이지 않는지
4. 결과를 `04-검증.md` 5장 아래에 "에뮬레이터 확인" 절로 더하고 로컬 커밋한다. 문제가 있으면 고치기 전에 성기님께 먼저 보고한다.
5. 성기님께 스크린샷과 함께 결과를 쉬운 말로 보고하고, 아래 승인 전 항목을 여쭌다.

## 3. 승인 전 (성기님 확인 뒤에만)
- 푸시, PR, 머지
- 버전 1.8.1(코드 29)로 올리기, Play 업로드, 원스토어 APK
- `node_modules` 링크 삭제(`rm node_modules`, 끝에 `/`를 붙이지 않는다)
- 에뮬레이터와 내려받은 이미지 삭제

## 4. 건드리면 안 되는 것
- 이 APK를 실사용 가족의 휴대폰에 설치하지 않는다. 에뮬레이터에서 가족 연결(동기화 코드 입력)을 하지 않는다. 운영 D1이나 Firestore에 쓰지 않기 위해서다.
- `expo run:android`, `expo prebuild`, `git stash`는 쓰지 않는다. `git add -A`와 `git add .`도 쓰지 않는다.
