# Baby Check — Claude Opus 인계

## 목표

디자인과 보호자 간 동기화 문제를 해결하고, Apple App Store 출시 가능한 상태까지 진행한다.
사용자는 Claude Opus가 구현을 이어가고, 현재 Codex는 PM 인계 후 작업 소유권을 넘기길 요청했다.

## 작업 원칙

- 루트의 `AGENTS.md`를 먼저 읽고, 코드를 쓰기 전에 Expo SDK 56 버전 문서
  `https://docs.expo.dev/versions/v56.0.0/`를 확인한다.
- 현재 작업 트리는 매우 dirty하며 기존 변경 전체가 사용자 작업이다. 되돌리거나 초기화하지 않는다.
- 실제 사용자 Firebase 데이터, App Store Connect, 배포 상태는 명시적 승인 없이 변경하지 않는다.
- 테스트 통과와 실제 두 기기/TestFlight 검증을 구분한다.

## 현재까지 반영된 핵심 변경

- `src/database/sync.ts`
  - 서버 전용 Firestore 읽기, 익명 인증 준비 대기, 가족 회원 캐시를 UID별로 분리.
  - 기록/프로필 변경과 가족 변경 알림을 같은 transaction에 저장.
  - 삭제 tombstone, 동시 수정 tie-break, 오프라인 재시도, 늦은 응답 폐기 보강.
  - 초대 키 strict validation. 신규 32자리 키는 legacy 서버로 보내지 않음.
- `src/database/storage.ts`, `src/database/syncDeadline.ts`
  - 로컬 쓰기 직렬화, 서버 응답 중 생긴 추가·삭제 보존, syncKey fence, timeout abort 처리.
- `App.tsx`
  - 동기화 timeout 뒤 큐 잠김 방지, 재시도 배너와 상태 표시, 가족 변경 시 이전 작업 취소.
  - 연속 자동 동기화 요청 합치기 작업이 추가됐으나 가족 키별 분리가 완전한지 최종 검토 필요.
- `src/screens/Dashboard.tsx`
  - 빠른 기록을 위로 이동, 카드와 버튼 가독성 개선, 타임라인 더 보기와 접근성 레이블 추가.
- `src/screens/Profile.tsx`
  - 백업에서 가족 초대 키 제외, iOS 공유 시트 지원(`expo-sharing`).
- Expo 패치 의존성 정렬: `expo ~56.0.22`, `expo-updates ~56.0.27`, `expo-sharing ~56.0.26`.
- 로컬 동기화 회귀 하네스 추가: `tools/sync-harness/`.
- PM 상태 문서: `docs/PROJECT_STATUS.md`.

## 확인된 검증

- `npx tsc --noEmit`: 통과.
- `bash tools/sync-harness/verify.sh unit`: 18/18 통과.
- `bash tools/sync-harness/verify.sh regression`: 10개 회귀 시나리오 통과.
- `npx expo install --check`: `Dependencies are up to date`.
- agy가 웹 export를 시도하고 `dist-web/`를 만들었으나 최종 보고 전에 timeout. 결과를 직접 재확인한다.

## 반드시 이어서 할 일

1. 현재 diff를 리뷰한다. 특히 `App.tsx`의 `pendingSyncRef`가 서로 다른 가족 키 요청을 합치지 않는지,
   timeout 이후 늦은 writer와 다음 sync가 안전하게 공존하는지 확인한다.
2. 타입 검사, unit/regression, Expo doctor/export를 재실행한다. 실제 Firebase를 쓰는 `compat/full`은
   운영 프로젝트 할당량을 사용하므로 기본 실행하지 않는다.
3. 모바일 폭에서 실제 화면을 검토하고 디자인 회귀를 수정한다. 개발용 `DashboardSample`은 출시 화면에 노출하지 않는다.
4. `docs/APP_STORE_READINESS.md`를 작성한다. 현재 출시 차단 항목은 다음과 같다.
   - 이 Mac은 전체 Xcode가 활성화되지 않아 iOS native build/signing 미검증.
   - 두 실제 기기 또는 TestFlight에서 초대, 양방향 추가·수정·삭제, 오프라인 복귀 미검증.
   - 개인정보처리방침 공개 URL과 앱 내 링크 미확인.
   - 익명 Firebase 사용자/가족 데이터 삭제 흐름이 부족함. 단순 연결 해제는 서버 삭제가 아님.
   - Apple Developer/App Store Connect 등록, Team ID, 심사 정보, iOS 스크린샷 미확인.
5. 구현이 안전하게 끝나면 변경 파일, 검증 결과, 남은 차단 항목을 사용자에게 한국어로 보고한다.

## 환경 메모

- 프로젝트: `/Users/seonggi/Desktop/PDS/dev/baby-check`
- 날짜/시간대: 2026-09-19, Asia/Seoul.
- `xcodebuild -version`은 active developer directory가 CommandLineTools라 실패했다.
- `dist-web/`은 검증 산출물이며 커밋 대상인지 판단해서 정리한다. 삭제가 필요하면 범위를 확인한다.
