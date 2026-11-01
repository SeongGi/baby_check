# 인수인계 4: 한줄 육아일기 (PR 이후)

- 워크트리: `/Users/seonggi/Desktop/PDS/dev/baby-check-diary`, 브랜치 `feat/daily-diary`
- 응답은 항상 한국어로 하고, 쉬운 말로 먼저 요약한다.
- `HANDOFF.md` 3장(건드리면 안 되는 것)은 그대로 유효하다.

## 1. 지금 상태 (2026-11-01)
- 에뮬레이터로 13개 항목을 확인했고, 모두 통과했다(`04-검증.md` 5.1절).
- 지난 날짜 입력 창의 안내 문구를 성기님 승인 뒤 고쳤다(`917b13d`).
- 버전을 1.8.1(코드 29)로 올렸다(`01af752`).
- 고친 뒤 `tsc` 두 개와 `verify.sh offline`(단위 117/117, 일기 단위 107/107, 실제 서버 시나리오 전부)이 통과했다.
- 브랜치를 푸시했고, PR #17을 열었다: https://github.com/SeongGi/baby_check/pull/17 (머지하지 않음)
- `node_modules` 링크를 지웠다. 시험을 다시 돌리려면 링크를 다시 만들거나(`ln -s ../baby-check-cloudflare/node_modules node_modules`, 커밋 금지) `npm ci`를 한다.
- 에뮬레이터 `babycheck_test`와 Android 35 시스템 이미지를 지웠다.
- 1.8.1 APK와 AAB는 아직 빌드하지 않았다. `android/app/build/outputs/apk/release/app-release.apk`는 1.8.0(코드 28) 파일이다.

## 2. 승인 전 (성기님 확인 뒤에만)
- PR #17 머지
- 1.8.1 릴리스 빌드(AAB와 APK), Play 업로드, 원스토어 APK 등록
- 실기기에서 한글 키보드로 200자 경계까지 입력해 보는 확인(실사용 가족 휴대폰에는 설치하지 않는다)

## 3. 건드리면 안 되는 것
- 실사용 가족 휴대폰에 시험 빌드를 설치하지 않고, 운영 D1과 Firestore에 쓰지 않는다.
- `expo run:android`, `expo prebuild`, `git stash`, `git add -A`, `git add .`를 쓰지 않는다.
