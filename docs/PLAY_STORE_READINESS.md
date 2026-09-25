# Google Play Store 출시 준비 상태

작성: 2026-09-21 (출시 목표를 Google Play Store 우선으로 확정한 뒤 정리)
갱신: 2026-09-21 — 터미타임/놀기시간 기록 추가, `versionCode 16`(`1.6.0`)으로
올리고 GitHub Releases(`v1.6.0`)에 테스트용 APK 배포. **이후 사용자가 실제
업데이트 경로는 Play Store임을 확인**해줘서, 같은 버전으로 AAB를 빌드해
Play Console "비공개 테스트 - Alpha" 트랙에 업로드하고 검토 제출까지 완료
(진행 상태는 4절 참고).
갱신: 2026-09-24 — v1.6.0이 실제로 Alpha 트랙에 게시됨을 확인. 가족 데이터
영구 삭제(1시간 냉각기간, 자동 실행) 기능을 완성하고 데이터 손실 위험을
`/code-review high`로 검증(발견된 버그 2건 수정) → `firestore.rules` 실제
배포 완료 → `versionCode 17`(`1.7.0`)로 GitHub Releases(`v1.7.0`)와 Play
Console Alpha 트랙에 모두 제출. **새로 발견: Play Console에 "2026년 9월
30일까지 Android 개발자 인증을 위해 앱을 등록하세요" 알림 확인 — 마감이
얼마 남지 않아 확인 필요 (6절 참고).**
대상: `app.json`/`android/app/build.gradle` 기준 `versionCode 17`, `versionName 1.7.0`,
`applicationId com.seonggi.babycheck`

`docs/APP_STORE_READINESS.md`(Apple App Store용)는 보류합니다. 이 문서가
지금부터의 기준 문서입니다. **검증된 것과 검증되지 않은 것을 분리해서** 적고,
테스트를 통과한 상태를 출시 가능으로 표현하지 않습니다.

---

## 1. 지금까지 검증된 것

| 항목 | 명령/확인 방법 | 결과 |
| --- | --- | --- |
| 타입 검사 | `npx tsc --noEmit` | 통과 (오류 0) |
| 동기화 단위 검증 | `tools/sync-harness/verify.sh unit` | 18/18 통과 |
| 동기화 회귀 | `tools/sync-harness/verify.sh regression` | 22/22 통과 (가족 데이터 영구 삭제 시나리오 포함) |
| Expo 의존성 정렬 | `npx expo install --check` | `Dependencies are up to date` |
| Android JS 번들 | `npx expo export --platform android` | 성공 (809 modules, Hermes 3.8MB) |
| Play 아이콘 규격 | `play-store-icon-512.png` 실측 | 512×512 — Play 요구 규격과 일치 |
| Play 피처 그래픽 규격 | `play-feature-graphic-1024x500.png` 실측 | 1024×500 — Play 요구 규격과 일치 |
| Play 스크린샷 규격 | `play-screenshot-*-1080x1920.png` 실측 | 1080×1920 (9:16) — Play 허용 범위(320~3840px, 16:9~9:16) 안 |
| 안드로이드 업로드 키스토어 존재 | `credentials.json` + `credentials/android/keystore.jks`, `eas-upload-certificate.pem` 확인 | 파일 존재 (로컬). EAS 클라우드 계정에 실제 등록돼 있는지는 `eas credentials -p android`로 별도 확인 필요 |
| Play 비공개 테스트용 테스터 계정 준비 | `tester_credentials.md` 확인 | 13명 계정 목록 존재. Google Play의 "비공개 테스트 12명·14일 연속" 요건을 겨냥한 것으로 보임 |

모두 가짜 클라우드/로컬 검증 기준이며 실제 Firebase 할당량은 쓰지 않았습니다.
Android AAB 네이티브 빌드·서명 자체(EAS 클라우드 빌드)는 이번에 실행하지 않았습니다.

---

## 2. 출시 차단 항목 (blocker)

### P1. 개인정보처리방침 공개 URL — **해결됨 (2026-08-12부터 이미 등록돼 있었음, 2026-09-25 내용 갱신)**

**정정**: 2026-09-21 조사에서 "입력할 곳을 못 찾았다"고 결론 내렸던 건 잘못된
탐색 경로 때문이었습니다. 올바른 경로는 **"모니터링 및 개선" > "정책 및
프로그램" > "앱 콘텐츠" > "조치됨" 탭**이며, 여기서 "개인정보처리방침" 행을
펼치면 이미 등록된 URL이 바로 보입니다. 이 앱은 **2026년 8월 12일에 이미
개인정보처리방침이 선언·완료된 상태**였습니다.

- 등록된 URL: **https://gist.github.com/SeongGi/ece696b14578b14bccb62cf00ff3da12**
  (GitHub Gist, 공개)
- 내용을 실제 코드와 대조한 결과, "제3자 서비스" 항목이 **구버전 동기화
  백엔드(ExtendsClass JSON Storage, KeyValue.immanuel.co)만 적혀 있고 현재
  주 동기화 서버인 Firebase(Firestore)가 전혀 언급돼 있지 않아** 실제
  아키텍처와 어긋났습니다. `src/database/legacySync.ts`의 `readLegacyCloud`가
  구형(비-32자리 hex) 동기화 키 사용자를 대상으로 1회성 마이그레이션
  읽기 용도로만 두 구 서비스를 짧게 호출하는 걸 코드로 확인 후, 사용자
  승인을 받아 **"제3자 서비스" 항목을 최소 수정**했습니다(`gh api -X PATCH
  gists/...`) — Firebase를 주 서비스로 추가하고, 구 서비스 두 개는
  "예전 사용자 마이그레이션 전용, 신규 연결에는 미사용"으로 명확화.
- **별도로 GitHub Pages에도 정적 페이지가 있음**: https://seonggi.github.io/baby_check/privacy-policy.html
  (이번 세션 초반에 만든 것, 앱 내 `src/screens/Profile.tsx`의
  "개인정보처리방침 전문 보기 🔗" 버튼이 여는 URL). 이 페이지는 처음부터
  Firebase를 정확히 언급하고 있어 내용은 문제없으나, **Play Console에
  등록된 공식 URL(Gist)과는 별개의 문서**라는 점은 인지해 둘 것 — 필요하면
  나중에 하나로 통합 검토.

### P2. Play Console "Data safety(데이터 보안)" 설문 — **해결됨 (2026-08-12부터 이미 완료돼 있었음)**

**정정**: P1과 같은 이유로 잘못된 경로에서 찾고 있었습니다. 같은
"앱 콘텐츠 > 조치됨" 탭에 "데이터 보안"을 포함해 **총 10개 정책 선언이
모두 2026년 8월 12일(콘텐츠 등급만 8월 9일) 기준으로 이미 "조치됨" 상태**
였습니다: 광고 ID, 데이터 보안, 금융 기능, 타겟층 및 콘텐츠, 로그인
세부정보, 개인정보처리방침, 콘텐츠 등급 등. **"프로덕션 신청" 버튼이
비활성이라 안 보인다"는 이전 추정은 틀렸음** — 이 메뉴는 테스터 요건과
무관하게 항상 접근 가능했습니다.

**남은 일**: "데이터 보안" 선언의 세부 답변 내용까지는 이번에 열어보지
않았습니다. P1에서 발견한 것처럼 오래된(8월 12일) 답변이 최신 기능(가족
데이터 영구 삭제, 터미타임/놀이시간 기록 등)을 반영 못 했을 가능성이 있어,
프로덕션 신청 전에 한 번 열어서 실제 코드와 대조 확인 권장.

### P3. 앱 내 데이터·계정 삭제 흐름 — **해결됨 (2026-09-24, firestore.rules 배포 완료)**

Google Play도 2023년 말부터 계정 생성이 가능한 앱에 **앱 내 계정/데이터 삭제
수단**을 요구합니다. 이 요건에 대응하는 기능을 구현하고, 검증 후 실제
`babycheck-sync` 프로젝트에 배포했습니다(자세한 내용은
[[preserve-jjukkom-data]] 관련 안전장치와 함께 아래 4절 참고).

- `firestore.rules`: 가족 멤버에게만, 그리고 **1시간 냉각 기간이 지난 뒤에만**
  `logs`/`members`/가족 문서 `delete` 허용. 삭제 예약(`pendingDeletionAt`)은
  최소 50분 뒤의 미래 시각으로만 설정 가능하도록 서버 쪽에서 검증.
- `src/database/sync.ts`: `scheduleFamilyDeletion()`(예약)/`cancelFamilyDeletion()`
  (취소)/`deleteFamilyCloudData()`(실제 batch 삭제 — 다른 회원 접근부터
  즉시 차단하는 순서로 재작성, 부분 실패 시 `partiallyDeleted` 플래그로 알림)
- `src/screens/Profile.tsx`: "삭제합니다" 입력 + 네이티브 재확인 → 1시간 뒤
  **추가 확인 없이 자동 실행**되는 위험 구역(danger zone) UI. 그 전까지는
  언제든 취소 가능.
- **동기화 결합 버그 수정**: 평소 자동 동기화의 `allowFamilyCreation` 기본값을
  `true`→`false`로 변경(삭제된 가족을 다른 기기가 조용히 되살리는 것 방지),
  `familyUnavailable` 감지 시 그 기기도 로컬 연결을 자동 해제(로컬 기록은 유지).
- 별도 코드 리뷰 에이전트로 데이터 손실 경로를 검증(`/code-review high`),
  발견된 심각 버그 2건(`subscribeToCloudChanges`의 `allowFamilyCreation` 누락,
  삭제 순서로 인한 부활 가능성)을 배포 전에 수정.

**2026-09-24: `firebase login` + `firebase deploy --only firestore:rules
--project babycheck-sync`로 실제 배포 완료.** (`firebase-tools`가 이
작업 환경에 없어 사용자 계정으로 로그인 후 배포. 로그인은 대화형 터미널이
필요해 컴퓨터 사용 도구로 실제 터미널 앱에서 진행.)

### P4. Play Console 개발자 계정·앱 등록 상태 — **해결됨 (2026-09-21 화면 직접 확인)**

사용자 브라우저에 이미 로그인돼 있던 Play Console을 (computer-use로) 직접
확인했습니다.

- 개발자 계정 존재: **Choi SeongGi**, 개인 계정, 계정 ID `8322026644846248117`
- 앱 "아기기록"(`com.seonggi.babycheck`)이 **이미 콘솔에 등록되어 있음**,
  최종 업데이트 2026년 8월 25일
- 트랙 현황: **비공개 테스트(alpha)** 트랙에 버전코드 **14 (1.5.0)**가 게시됨
  (2026-08-25 17:42), **내부 테스트** 트랙에는 1.4.1 "가족 데이터 동기화"
  버전(2026-08-20)이 있음, **프로덕션 트랙은 비활성**(아직 아무것도 게시 안 함)
- 같은 계정에 다른 앱도 함께 있음: `PicTrail 여행기록`, `Black Box Editor`,
  `출석체크` — 이 저장소와는 무관하니 착오로 건드리지 않도록 주의

⚠️ **중요**: Play에 올라간 최신 버전은 `14 (1.5.0)`인데, 로컬 저장소는 이제
`versionCode 16`, `versionName 1.6.0`입니다(이번 세션에 터미타임/놀기시간
기록 추가 후 상향). GitHub Releases `v1.6.0`에 테스트용 APK를 배포해 실기기
테스트는 가능하지만, **Play에는 여전히 1.5.0 이후로 아무것도 업로드되지
않았습니다.** Play 제출 시에는 AAB로 새로 빌드해야 합니다(APK와 별개).

### P5. 비공개 테스트(closed testing) 요건 — **해결됨 (미충족 상태로 확인, 구체적 원인 파악)**

앱 대시보드의 "프로덕션 액세스 신청" 체크리스트를 직접 확인했습니다.

- ✅ 비공개 테스트 버전 게시 — 완료
- ❌ 테스터 12명 이상 참여 — **현재 2명만 참여를 선택함**
- ❌ 12명 이상 대상 14일 이상 연속 테스트 — 위 조건 미충족으로 **아직 시작조차 안 됨**
- "프로덕션 신청" 버튼은 비활성 상태

**원인**: `tester_credentials.md`의 13명과는 별도로, alpha 트랙 테스터 설정에
이메일 목록이 **두 개, 총 21명**(`babycheck_testers` 15명 + `testter_group`
6명) 이미 등록돼 있습니다. 즉 **테스터 이메일 등록은 충분히 돼 있는데, 그
사람들이 실제로 "테스트 참여" 링크를 눌러 opt-in을 안 한 상태**입니다. 콘솔에서
확인한 opt-in 링크는 다음 두 개입니다.

- Android(Play 스토어 경유): `https://play.google.com/store/apps/details?id=com.seonggi.babycheck`
- 웹: `https://play.google.com/apps/testing/com.seonggi.babycheck`

**다음 행동**: 이 두 링크 중 하나를 21명(또는 최소 12명)에게 보내 "테스트
참여" 버튼을 누르게 해야 14일 카운트가 시작됩니다. 이미 링크가 발송됐는지는
콘솔에서 알 수 없어 사용자 확인이 필요합니다.

**2026-09-25 갱신**: GOOTE(외부 테스터 모집 사이트) 활용을 위해 Alpha 트랙의
테스터 소스를 이메일 목록에서 **Google 그룹스(`sg-app-testers@googlegroups.com`,
PicTrail 등과 공용)로 전환**했습니다(자세한 내용은 `docs/tester-recruitment.md`).
Play Console은 트랙당 이메일 목록/Google 그룹스 중 하나만 지원하므로, 이
전환으로 기존 이메일 목록 21명은 Alpha 접근권을 잃었습니다(사용자 승인 후
진행). 전환 시점 그룹 멤버는 2명(`sgchoi1547@gmail.com`, `jjukkom@gmail.com`).
**opt-in 카운트가 전환 시점에 리셋됐을 가능성이 있어, 12명·14일 요건 진행
상황은 재확인이 필요합니다.**

### P6. `eas submit` 자동 제출 설정 없음 — **차단 아님, 수동 업로드로 대체 가능**

`eas.json`의 `submit.production.android`에 `track: "alpha"`만 있고 Play
Console API용 서비스 계정 키(`serviceAccountKeyPath`) 설정이 없습니다.
자동 제출을 원하면 Play Console에서 서비스 계정을 만들어 키를 발급해야
하고, 그렇지 않으면 EAS로 빌드한 AAB 파일을 Play Console에 수동으로
업로드하면 됩니다(첫 제출은 수동이 오히려 흔합니다).

### P7. Play 사전 출시 보고서 경고 — **참고, 당장 차단 아님**

같은 화면에서 "다음 출시 버전을 위한 발견 항목"에 경고가 하나 있었습니다:
**"앱에서 더 넓은 화면용으로 지원 중단된 API 또는 파라미터를 사용합니다"**
(Android 15부터 지원 중단된 큰 화면 관련 API/파라미터 사용 추정). 지금 당장
제출을 막지는 않지만, 다음 버전 업로드 전에 Play Console "사전 출시 보고서"
메뉴에서 상세 내용을 확인하는 것을 권장합니다.

---

## 3. 출시 전 정리해야 할 항목 (차단은 아님)

### Q1. Android 릴리스 서명 자격 증명이 EAS 계정에 실제 등록돼 있는지 확인

로컬에 `credentials/android/keystore.jks`와 `credentials.json`은 있지만,
EAS 클라우드 빌드가 이 키를 실제로 쓰는지는 `eas credentials -p android`
로그인 후 확인이 필요합니다(이번 세션에는 로그인 없이 실행 불가).
**이 키스토어를 잃어버리면 같은 `applicationId`로 업데이트를 낼 수 없으므로**
안전한 곳에 별도 백업을 권장합니다.

### Q2. `targetSdkVersion`이 Play 최신 요구치를 만족하는지 최종 빌드 로그에서 확인

저장소에는 `targetSdkVersion`이 하드코딩돼 있지 않고 Expo SDK 56 기본값을
따릅니다. 보통 Expo가 Play 요구 수준에 맞게 최신화하지만, 실제 EAS 빌드
로그에서 한 번은 확인하는 것을 권장합니다.

### Q3. 개발용 `DashboardSample` 화면이 번들에 포함됨

`__DEV__` 게이트로 진입은 불가능하지만 `App.tsx`가 무조건 import해서
번들 용량만 늘립니다. 기능상 문제는 없습니다(우선순위 낮음).

### Q4. Firebase 설정값이 저장소에 하드코딩됨

`src/database/firebase.ts`의 apiKey 등은 Firebase 웹 apiKey 특성상 공개돼도
그 자체로 취약점은 아니며, 보안은 전적으로 `firestore.rules`에 달려 있습니다.
Play 심사와는 무관합니다.

---

## 4. 이번에 바꾼 것들 요약 (2026-09-21)

- `app.json`: `ios.supportsTablet` → `false`, `ios.buildNumber` → `"1"`,
  `ios.infoPlist.ITSAppUsesNonExemptEncryption` → `false`. (iOS는 보류지만
  나중에 재개할 때 다시 손대지 않도록 미리 반영해 둠. Android 설정에는 영향 없음.)
- `firestore.rules` / `src/database/sync.ts` / `src/screens/Profile.tsx` /
  `App.tsx`: 가족 서버 데이터 영구 삭제 기능 추가 (P3 참고). 실제 배포는
  사용자 승인 대기.
- `tools/sync-harness/stubs/fake-cloud.mjs`, `tools/sync-harness/regression.mjs`:
  위 기능에 대한 회귀 테스트 2건 추가.
- 로컬 Android 빌드 환경 구축: `openjdk@17`(Homebrew) 설치,
  `android/gradle.properties`의 `org.gradle.jvmargs`를 2GB/512MB →
  4GB/1GB로 상향(첫 빌드가 Metaspace 부족으로 실패해서 조정).
- `./gradlew assembleRelease`로 서명된 APK를 만들어 GitHub Releases
  `v1.6.0`에 배포. 이후 사용자가 실제 업데이트 경로는 GitHub이 아니라 **Play
  Store**임을 확인해줘서, `./gradlew bundleRelease`로 AAB를 추가로 빌드.
- Play Console "비공개 테스트 - Alpha" 트랙에 `computer-use`(브라우저 조작)로
  직접 접속해 AAB 업로드 → 출시 노트 작성 → **검토를 위해 제출까지 완료.**
  타겟 SDK 36, API 24 이상으로 업로드됨을 확인(Q2 해소). 경고 1건(디버그
  심벌 파일 미첨부)은 크래시 분석 편의 관련이라 차단 아님.

---

## 5. 다음 단계 권장 순서 (2026-09-24 갱신)

1. **진행 중, 대기만 하면 됨**: `versionCode 17 (1.7.0)`이 Play Console
   "비공개 테스트 - Alpha" 트랙에 검토 제출됨. Google 자동 검사(최대 약
   14분) 후 보통 더 짧게(길면 최대 7일) 검토가 끝나면 테스터에게 배포됩니다.
   Play Console "게시 개요"에서 진행 상태 확인 가능.
2. ~~Android 개발자 인증~~ — **해결됨 (6절 참고, 아기기록은 이미 등록돼 있어
   추가 조치 불필요)**
3. **가장 시급, 유일하게 실제로 남은 블로커**: 비공개 테스트(Alpha, 2026-09-25부터
   `sg-app-testers@googlegroups.com` 그룹 기반) opt-in을 12명 이상으로 늘리기.
   현재 2명(`sgchoi1547@gmail.com`, `jjukkom@gmail.com`). **14일 카운트는 이
   시점부터 시작되므로 가장 먼저 처리할수록 유리합니다.** (`docs/tester-recruitment.md`
   참고, GOOTE 등 외부 모집 채널 활용 중)
4. ~~개인정보처리방침 URL 입력~~ — **해결됨 (P1, 2026-08-12부터 이미 등록,
   2026-09-25 내용 정확성 갱신 완료)**
5. ~~Play Console Data safety 설문 작성~~ — **해결됨 (P2, 2026-08-12부터 이미
   완료). 단, 답변 내용이 최신 기능을 반영하는지는 프로덕션 신청 전 재확인 권장.**
6. `eas credentials -p android`로 서명 키 등록 상태 확인 (Q1) — 참고로 이번
   로컬 빌드는 EAS 관리 키스토어(`credentials/android/keystore.jks`)로
   서명했으니 Play에 등록된 키와 일치할 가능성이 높음
7. 1번의 검토 통과와 3번의 14일 카운트 완료를 모두 확인한 뒤 "프로덕션
   신청" → 프로덕션 공개

---

## 6. Android 개발자 인증 마감 (2026-09-30) — **해결됨 (2026-09-24, 이미 등록 확인)**

computer-use로 알림을 직접 클릭해 `play.google.com/console/.../android-developer-verification`
페이지까지 들어가 "패키지 이름" 탭의 실제 등록 테이블을 확인했습니다. 이
계정에 등록된 패키지 이름은 총 4개이며, **아기기록(`com.seonggi.babycheck`)도
이미 포함돼 있습니다**:

| 패키지 이름 | 상태 | 키 | 최근 업데이트 날짜 |
| --- | --- | --- | --- |
| 아기기록 (`com.seonggi.babycheck`) | ✅ 등록됨 | 2 | 2026년 6월 26일 |
| Black Box Editor (`com.seonggi.blackboxeditor`) | ✅ 등록됨 | 1 | 2026년 5월 10일 |
| 출석체크 (`com.seonggi.popattendance`) | ✅ 등록됨 | 1 | 2026년 7월 20일 |
| 나의 여행기록 - PicTrail Log (`com.seonggi.travel_log`) | ✅ 등록됨 | 1 | 2026년 5월 11일 |

**결론**: 아기기록은 이미 6월에 등록이 완료된 상태라 9월 30일 마감과
무관하게 추가 조치가 필요 없습니다. 알림이 계속 뜨는 건 계정 전체(다른 앱
포함) 기준의 일반 안내로 보입니다. **차단 아님, 완료로 재분류.**
