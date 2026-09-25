# 아기기록 출시 관리

목표: 기록을 안전하게 보존하고 보호자 간 동기화가 검증된 앱을 **Google Play
Store**에 출시한다. (2026-09-21: 사용자가 Play Store를 우선 목표로 확정.
Apple App Store는 보류 — 관련 기록은 `docs/APP_STORE_READINESS.md`에 보관.)

## 역할
- PM(Codex): 우선순위, 작업 인계, 결과 검수, 출시 준비와 장애물 관리.
- 구현(agy / Antigravity / Claude Opus): 코드 수정, 회귀 테스트, 빌드 및 화면 검증.
- 사용자: 제품·계정 관련 최종 결정, 실제 기기 검증, Play Console 운영 정보 제공.

## 진행 순서와 완료 기준
1. 동기화 안정화: 추가·수정·삭제, 오프라인 복귀, 중단/재시도, 가족 전환, 유휴 쓰기 억제 테스트 통과. 모의 서버 통과와 실제 두 기기 검증을 구분한다.
2. 디자인/사용성: 모바일 폭에서 주요 기록 동선·텍스트 대비·저장 상태·재시도·접근성을 확인한다.
3. 출시 후보: 타입 검사, Expo 의존성 검사, Android AAB 빌드·서명, 개인정보/데이터 삭제 요건 검토.
4. Play 비공개 테스트: 테스터 12명 이상 14일 연속 참여, 실기기 가족 초대·양방향 기록·재설치·오프라인 복구 확인.
5. 제출: 스토어 등록정보, Data safety 설문, 개인정보처리방침 URL, 스크린샷을 갖춘 뒤 프로덕션 트랙 공개.

## 현재 상태 (2026-09-24)
- **firestore.rules 실제 배포 완료.** 데이터 손실 위험 검증(`/code-review high`)에서 심각한 버그 2건 발견 후 수정: (1) `subscribeToCloudChanges`가 `allowFamilyCreation` 기본값(true)을 놓쳐 삭제된 가족을 되살릴 수 있었음, (2) `deleteFamilyCloudData`가 기록보다 회원 문서를 나중에 지워 삭제 도중 다른 기기가 지워진 기록을 재업로드할 수 있었음(삭제 순서를 "다른 회원 접근 차단 → 기록 → 내 회원·가족 문서" 순으로 재작성). 가족 데이터 영구 삭제는 1시간 냉각기간 후 **추가 확인 없이 자동 실행**되도록 구현(사용자 명시적 요청).
- `versionCode 17 (1.7.0)`로 GitHub Releases(`v1.7.0`)와 Play Console Alpha 트랙에 모두 제출 완료. v1.6.0은 이미 Alpha 트랙에 정상 게시된 것을 확인함.
- **Android 개발자 인증(9/30 마감) 확인 완료 — 해결됨.** computer-use로 실제 등록 페이지(패키지 이름 탭)까지 들어가 확인한 결과, 이 계정의 등록된 패키지 이름 4개 중 아기기록(`com.seonggi.babycheck`)이 이미 "등록됨" 상태(서명 키 2개, 최근 업데이트 2026-06-26)로 포함돼 있었음. 추가 조치 불필요 (`docs/PLAY_STORE_READINESS.md` 6절).
- **비공개 테스트 테스터 소스를 Google 그룹스로 전환 (2026-09-25)**: GOOTE 등 외부 테스터 모집 채널을 쓰기 위해 Alpha 트랙의 테스터 소스를 이메일 목록(21명)에서 `sg-app-testers@googlegroups.com`(여러 앱 공용, 현재 멤버 2명)으로 전환. 기존 이메일 목록 21명은 Alpha 접근권 상실(사용자 승인 후 진행). 국가/지역(대한민국 타겟팅)·opt-in 카운트(2명 유지) 모두 정상 확인.
- **P1/P2 재조사 — 둘 다 이미 8/12부터 해결돼 있었음 (2026-09-25 정정)**: "앱 콘텐츠" 메뉴는 "모니터링 및 개선 > 정책 및 프로그램"에 있었음(이전 세션에 잘못된 경로로 찾아 "없다"고 결론 냈던 것 정정). 개인정보처리방침(Gist)·Data safety 등 10개 정책 선언이 이미 "조치됨" 상태. 단, 등록된 Gist의 "제3자 서비스" 항목이 구버전 동기화 백엔드(ExtendsClass/KeyValue.immanuel.co)만 적고 현재 주 서버인 Firebase는 누락돼 있어 코드 대조 후 최소 수정함(`docs/PLAY_STORE_READINESS.md` P1 참고).

## 이전 상태 (2026-09-21)
- 출시 목표를 Google Play Store로 확정. 최신 기준 문서는 `docs/PLAY_STORE_READINESS.md` (Apple 관련 내용은 `docs/APP_STORE_READINESS.md`에 보류 처리).
- Play 준비 상태 조사 결과, 이미 상당 부분 준비돼 있음을 확인:
  - Android 업로드 키스토어(`credentials/android/keystore.jks`)와 EAS 인증서가 로컬에 존재 (EAS 클라우드 등록 여부는 `eas credentials -p android`로 별도 확인 필요)
  - Play 스토어 그래픽 자산(`play-store-icon-512.png` 512×512, `play-feature-graphic-1024x500.png` 1024×500, 스크린샷 1080×1920 2종) 규격이 Play 요구 사양과 일치함을 실측 확인
  - `tester_credentials.md`에 13명의 테스터 계정이 준비돼 있어 Play의 "비공개 테스트 12명·14일 연속" 요건을 겨냥한 것으로 보임 (Play Console에서 실제 진행 상태는 미확인)
  - `eas.json` production 빌드가 이미 Android `app-bundle`(AAB)로 설정됨
- 09-21: (플랫폼 공통) B4/P3 — 가족 서버 데이터 영구 삭제 기능을 무료(Spark) Firebase 등급 기준으로 설계·구현 완료. `firestore.rules`(로그/회원/가족 문서 delete를 멤버에게 허용), `deleteFamilyCloudData()`(`src/database/sync.ts`), Profile 화면의 danger-zone UI까지 코드는 준비됐으나 **실제 `babycheck-sync` 프로젝트에는 아직 배포하지 않음 — 배포는 사용자 승인 필요** ([[preserve-jjukkom-data]] 참고: 실사용자 2명, jjukkom 데이터 손실 절대 금지).
- 검증 통과: `npx tsc --noEmit` 오류 0, `tools/sync-harness/verify.sh unit` 18/18, `verify.sh regression` 22/22(가족 데이터 영구 삭제 시나리오 2건 추가), `npx expo install --check` 최신, Android/iOS/web JS 번들(`expo export`) 성공. 모두 가짜 클라우드 기준이며 실제 Firebase 할당량은 쓰지 않음. Android 네이티브 AAB 빌드·서명 자체는 아직 실행하지 않음.
- CLAUDE_HANDOFF.md가 남겼던 미해결 항목(`App.tsx`의 동기화 요청이 가족 키별로 제대로 분리되는지)은 `pendingSyncByKeyRef`(`Map<familyKey, Promise>`)로 해소됨을 09-20 재검증으로 확인.
- 09-21: 사용자 브라우저에 로그인돼 있던 Play Console을 computer-use로 직접 확인 — P4·P5 상태를 실증적으로 확정.
  - **P4 확정**: 개발자 계정(Choi SeongGi, ID 8322026644846248117) 존재, 앱 "아기기록"(`com.seonggi.babycheck`) 이미 등록됨. alpha(비공개 테스트) 트랙에 버전코드 14(1.5.0) 게시 중, 내부 테스트 트랙엔 1.4.1. 프로덕션 트랙은 비활성.
  - **P5 확정 (미충족)**: 프로덕션 액세스 체크리스트에서 "테스터 12명 이상 참여"가 **2명만 충족**되어 14일 카운트가 아직 시작 안 됨. 원인 파악: 테스터 이메일은 이미 21명(`babycheck_testers` 15 + `testter_group` 6) 등록돼 있으나 opt-in 링크를 실제로 누른 사람이 2명뿐. **다음 행동은 이 21명에게 opt-in 링크를 보내는 것** (링크는 `docs/PLAY_STORE_READINESS.md` P5 참고).
  - **버전 격차 해소 중**: 터미타임/놀기시간 기록 추가 후 `versionCode 16 (1.6.0)`으로 올리고, `./gradlew bundleRelease`로 AAB를 로컬 빌드(`openjdk@17` 설치, gradle 메모리 상향 필요했음). computer-use로 Play Console "비공개 테스트 - Alpha" 트랙에 업로드하고 **검토 제출까지 완료.** Google 자동 검사·검토 대기 중(보통 더 빠르지만 최대 7일 명시됨). 타겟 SDK 36 확인(Q2 해소).
  - 참고(P7, 차단 아님): Play 사전 출시 보고서에 "더 넓은 화면용 지원 중단 API 사용" 경고 발견, 다음 업로드 전 확인 권장.
  - `gh` CLI 활성 계정을 저장소 소유 계정(`SeongGi`)으로 전환함(기존 `seonggi1547`은 쓰기 권한 없어 릴리즈 생성 실패).
- 출시 차단 항목(P1~P7, `docs/PLAY_STORE_READINESS.md` 2절):
  - P1 개인정보처리방침 공개 URL 없음 (앱 내엔 Alert 요약만 존재)
  - P2 Play Console "Data safety" 설문 작성 여부 미확인
  - P3 데이터 삭제 기능 코드 준비 완료, **배포는 미실행** — 사용자 승인 대기
  - P4 해결됨 (위 참고)
  - P5 **테스터 opt-in 부족으로 미충족 확인** — 사용자가 21명에게 opt-in 링크 발송 필요 (가장 시급)
  - P6 `eas submit` 자동 제출용 서비스 계정 키 없음 — 수동 업로드로 대체 가능, 차단 아님
  - P7 사전 출시 보고서 큰 화면 API 경고 — 차단 아님, 다음 빌드 전 확인 권장
- 실제 Firebase 보안 규칙 배포 후 두 실기기 동기화 검증, 최신 코드로의 Android AAB 빌드·서명·업로드는 아직 완료되지 않았다.

구현 상세 및 이후 검증 결과는 `docs/PLAY_STORE_READINESS.md`와 함께 갱신한다. 테스트를 통과하지 않은 상태를 출시 완료로 표현하지 않는다.
