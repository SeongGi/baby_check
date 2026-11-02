# 인수인계 4: 한줄 육아일기 (PR 이후)

- 워크트리: `/Users/seonggi/Desktop/PDS/dev/baby-check-diary`, 브랜치 `feat/daily-diary`
- 응답은 항상 한국어로 하고, 쉬운 말로 먼저 요약한다.
- `HANDOFF.md` 3장(건드리면 안 되는 것)은 그대로 유효하다.

## 1. 지금 상태 (2026-11-01)
- 에뮬레이터로 13개 항목을 확인했고, 모두 통과했다(`04-검증.md` 5.1절).
- 지난 날짜 입력 창의 안내 문구를 성기님 승인 뒤 고쳤다(`917b13d`).
- 버전을 1.8.1(코드 29)로 올렸다(`01af752`).
- 고친 뒤 `tsc` 두 개와 `verify.sh offline`(단위 117/117, 일기 단위 107/107, 실제 서버 시나리오 전부)이 통과했다.
- 브랜치를 푸시했고, 성기님 승인 뒤 PR #17을 머지했다(머지 커밋 `167410d`).
- `node_modules` 링크를 지웠다. 시험을 다시 돌리려면 링크를 다시 만들거나(`ln -s ../baby-check-cloudflare/node_modules node_modules`, 커밋 금지) `npm ci`를 한다.
- 에뮬레이터 `babycheck_test`와 Android 35 시스템 이미지를 지웠다.
- 성기님 승인 뒤 1.8.1 릴리스를 빌드했다(머지된 코드, 2026-11-01 20:45). 빌드하는 동안만 `node_modules` 링크를 만들었고, 끝난 뒤 지웠다.
  - Play AAB: `android/app/build/outputs/bundle/release/app-release.aab`(65,528,636바이트). `createBundleReleaseJsAndAssets --rerun`로 JS 묶음을 새로 만들었다.
  - 원스토어 APK: `android/app/build/outputs/apk/release/app-release.apk`(91,427,798바이트). `EXPO_PUBLIC_DISTRIBUTION_STORE=onestore`로 JS 묶음을 다시 만들었다. 다시 `assembleRelease`를 돌리면 덮어써지므로 원스토어에 올리기 전에는 다시 빌드하지 않는다.
  - 확인: 두 파일 모두 1.8.1(코드 29)이고 EAS 키로 서명되었다(SHA-256 `6a92d3e2…4809ed73`, APK는 `apksigner` 검증 통과). 두 JS 묶음은 크기가 같고 42바이트만 다르며(1.8.0 때와 같은 차이), 둘 다 새 문구 "이 날은 어땠나요?"와 Worker 주소 1회를 담고 있다.

## 2. 다음 세션이 할 일 (2026-11-01 성기님 승인 받음: "플레이스토어에 업데이트 하고 원스토어도 등록해줘")
1. `git log --oneline -3`, 위 두 파일의 크기와 버전(1.8.1, 코드 29)이 그대로인지 확인한다. 다시 빌드하지 않는다(원스토어 APK가 덮어써진다).
2. Play 업로드: 1.8.0과 같은 Alpha 트랙에 위 AAB를 올리고 검토를 제출한다. 절차와 지난 기록은 `docs/cloudflare-sync-migration/HANDOFF.md`(Play Alpha 1.8.0 제출 기록)에 있다. 파일 선택 창은 성기님께 부탁한다(`⌘⇧G` → AAB 경로 붙여넣기). 출시 노트는 "한줄 육아일기 추가: 아빠·엄마가 하루 한 줄씩 쓰고 댓글을 달 수 있어요." 정도로 짧게 쓴다.
3. 원스토어 등록: 위 APK로 `docs/ONESTORE_RELEASE.md` 절차를 따른다.
4. 결과(제출 시각, 상태, 스크린샷)를 이 문서와 `04-검증.md`에 적고 로컬 커밋한다. 커밋 `c787f9a`와 함께 푸시·PR은 승인 전이다.
- 프로덕션 트랙 출시, 다른 트랙으로 옮기기, 로그인 정보 입력은 이번 승인에 들지 않는다. 필요하면 성기님께 먼저 여쭌다.

## 2-1. 승인 전 (성기님 확인 뒤에만)
- 이 문서 커밋들의 푸시와 PR
- 실기기에서 한글 키보드로 200자 경계까지 입력해 보는 확인(실사용 가족 휴대폰에는 설치하지 않는다)

## 3. 건드리면 안 되는 것
- 실사용 가족 휴대폰에 시험 빌드를 설치하지 않고, 운영 D1과 Firestore에 쓰지 않는다.
- `expo run:android`, `expo prebuild`, `git stash`, `git add -A`, `git add .`를 쓰지 않는다.
