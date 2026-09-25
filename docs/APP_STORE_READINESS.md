# Apple App Store 출시 준비 상태 (보류)

> **2026-09-21: 출시 목표를 Google Play Store 우선으로 확정했습니다.**
> 이 문서는 iOS/App Store 작업을 나중에 재개할 때 참고할 기록으로
> 보류(archive)합니다. 지금부터의 살아있는 기준 문서는
> `docs/PLAY_STORE_READINESS.md`입니다. 이 문서에 있던 B4(서버 데이터 삭제)와
> C2/C3 관련 코드 변경은 플랫폼 불문으로 이미 반영되어 Play 문서에도
> 동일하게 적용됩니다.

작성: 2026-09-19 (Claude Opus 구현 인계 후 1차)
갱신: 2026-09-21 — C1/C2/C3 반영, B4(서버 데이터 삭제) 무료 등급 기준 설계·구현 완료(배포 전). 이후 Play Store 우선으로 보류.
대상 버전: `app.json` 기준 `version 1.5.1`, iOS bundle `com.seonggi.babycheck`

이 문서는 **검증된 것과 검증되지 않은 것을 분리해서** 적습니다. 테스트를 통과한
상태를 출시 가능으로 표현하지 않습니다.

---

## 1. 지금까지 검증된 것

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| 타입 검사 | `npx tsc --noEmit` | 통과 (오류 0) |
| 프로필 공유 규칙 | `tools/sync-harness/verify.sh unit` | 18/18 통과 |
| 동기화 회귀 | `tools/sync-harness/verify.sh regression` | 22/22 통과 (2026-09-21에 가족 데이터 영구 삭제 시나리오 2건 추가) |
| Expo 의존성 정렬 | `npx expo install --check` | `Dependencies are up to date` |
| iOS JS 번들 | `npx expo export --platform ios` | 성공 (803 modules, Hermes 3.8MB) |
| web 번들 | `npx expo export --platform web` | 성공 (456 modules) |

`verify.sh offline` 하나로 unit + regression 을 모두 돌립니다. 이 둘은 가짜
클라우드 위에서 돌아 **Firebase 할당량을 쓰지 않습니다.**

`compat` / `full` 은 실제 `babycheck-sync` 프로젝트에 씁니다. 무료 등급 할당량을
소모하므로 이번 작업에서는 돌리지 않았습니다.

---

## 2. 출시 차단 항목 (blocker)

### B1. iOS 네이티브 빌드·서명 미검증 — **차단**

이 Mac 은 전체 Xcode 가 활성화되어 있지 않습니다 (`xcodebuild -version` 이
active developer directory 가 CommandLineTools 라 실패). 따라서 확인된 것은
**JS 번들이 만들어진다**는 것뿐이고, 다음은 전혀 검증되지 않았습니다.

- 네이티브 컴파일, 서명, provisioning profile
- `plugins/withBabyStatusWidget` 와 `expo-widgets` 의 iOS WidgetKit extension 빌드
- `expo-notifications` 의 iOS 권한 흐름

해소 방법: EAS 클라우드 빌드(`eas build -p ios --profile production`)를 돌리거나
전체 Xcode 를 설치한 뒤 로컬 빌드. **사용자 승인 후 진행해야 합니다.**

### B2. 두 실기기 / TestFlight 동기화 미검증 — **차단**

이번에 동기화 구조를 크게 바꿨습니다(아래 4절). 가짜 클라우드 회귀 20종은
통과했지만, **실제 Firestore 와 실제 두 대의 휴대폰에서는 아직 확인하지
않았습니다.** 최소한 다음을 실기기에서 확인해야 합니다.

1. 초대 링크로 가족 연결
2. A 에서 기록 추가 → B 에 도착
3. B 에서 수정 → A 에 반영
4. B 에서 삭제 → A 에서 사라지고 되살아나지 않음
5. A 를 비행기 모드로 두고 기록 → 복귀 후 자동 업로드
6. 앱 재설치 후 같은 가족에 재연결 → 기록 복구
7. **증분 동기화 확인**: 위를 며칠 반복한 뒤 Firebase 사용량 페이지에서 읽기 수가
   기록 수에 비례해 늘지 않는지

### B3. 개인정보처리방침 공개 URL 없음 — **차단**

App Store Connect 는 **공개적으로 접근 가능한 privacy policy URL** 을 필수로
요구합니다. 현재 앱에는 `src/screens/Profile.tsx` 의 `Alert` 로 띄우는 요약만
있고 공개 URL 이 없습니다.

필요한 것:
- 공개 URL (GitHub Pages / Firebase Hosting 으로 충분. 이미 `firebase.json` 이 있음)
- App Store Connect 앱 정보의 Privacy Policy URL 필드
- 앱 안에서 그 URL 로 나가는 링크 (현재는 Alert 요약뿐)
- App Privacy "nutrition label" 답변: 이 앱은 아기 이름·생일·출생체중·수유/기저귀
  기록을 Firestore 에 저장하므로 "Data Linked to You" 가 아니라 **익명 식별자에
  연결된 사용자 콘텐츠**로 신고해야 합니다. 익명 인증 UID 도 식별자입니다.

### B4. 서버 데이터 삭제 흐름 — **코드는 준비됨, 배포는 미실행 (사용자 승인 대기)**

기존에는 "가족 연결 해제"가 **이 휴대폰의 동기화만 중단**하고 Firestore 의
`families/{familyId}/logs/*`, `profile/shared`, `members/*` 문서는 그대로
남았습니다. Apple 심사 가이드라인 5.1.1(v)는 계정을 만드는 앱에 **앱 안에서의
계정 삭제**를 요구하므로, 이 상태로는 리젝 위험이 컸습니다.

**2026-09-21에 무료(Spark) 등급 기준으로 구현을 완료했습니다.** Cloud Functions
방식(`deleteFamily`)은 Blaze 유료 요금제가 필요해 채택하지 않았고, 문서가
권장한 차선책인 **규칙 개방 + 클라이언트 batch delete** 방식을 썼습니다.

- `firestore.rules`: `families/{familyId}`, `members/{uid}`, `logs/{logId}`의
  `delete`를 `isMember(familyId)`에게 허용 (기존에는 세 곳 모두 `if false`).
  `list`는 여전히 막아 둡니다. `profile/{profileId}`는 기존 `allow write`에
  delete가 이미 포함되어 있어 변경 없음.
- `src/database/sync.ts`의 `deleteFamilyCloudData(syncKey)`: 가족의 모든
  로그·회원 문서, 공유 프로필, 가족 문서 자체를 `writeBatch`로 지웁니다.
  존재하지 않는 가족을 새로 만들며 지우는 사고를 막기 위해 가족 생성은
  허용하지 않습니다.
- `src/screens/Profile.tsx` / `App.tsx`: "🔒 개인정보 보호 및 데이터 관리"
  카드에 위험 구역(danger zone)을 추가. `"삭제합니다"` 문구를 정확히 입력해야
  버튼이 활성화되고, 이후 네이티브 Alert로 한 번 더 확인한 뒤에만 실행됩니다.
  성공 시 이 기기의 가족 연결만 해제되며 **로컬 기록은 지우지 않습니다.**
- `tools/sync-harness/stubs/fake-cloud.mjs`에 `writeBatch` 스텁을 추가하고,
  `tools/sync-harness/regression.mjs`에 가짜 클라우드 기준 회귀 테스트 2건을
  추가해 통과를 확인했습니다 (가족 경로의 모든 문서가 지워지는지, 잘못된 키로는
  실행되지 않는지).

**아직 안 된 것 — 배포 전 반드시 확인:**

1. **`firestore.rules`를 실제 `babycheck-sync` 프로젝트에 배포하지 않았습니다.**
   이 작업 환경에는 `firebase` CLI도 설치되어 있지 않습니다. 배포는 실사용자
   2명([[preserve-jjukkom-data]] 참고: jjukkom 데이터 손실 절대 금지)이 쓰는
   운영 규칙을 바꾸는 일이라 **사용자의 명시적 승인 없이는 진행하지 않습니다.**
2. 이 기능은 배우자를 포함한 **가족 전체**의 서버 데이터를 지웁니다(가족이
   공유 모델이라 개인 데이터만 분리해서 지울 방법이 없음). 배포 전에 이 동작이
   의도한 것인지 다시 한번 확인이 필요합니다.
3. 실제 Firestore 규칙 배포 후 테스트 계정으로 삭제 흐름을 최소 한 번
   실기기에서 검증해야 합니다(B2와 함께 진행 권장).

**배포 방법(사용자 승인 후)**: `npx firebase-tools deploy --only firestore:rules`
(또는 `firebase` CLI 설치 후 동일 명령). 배포 전 `firebase login`으로 프로젝트
소유자 계정 인증이 필요합니다.

### B5. App Store Connect / 계정 정보 미확인 — **차단**

확인되지 않은 것: Apple Developer Program 가입 여부, Team ID, App Store Connect
앱 레코드 생성 여부, 심사용 연락처/데모 계정.

`eas.json` 의 `submit.production.ios` 가 비어 있습니다. 제출하려면
`appleId`, `ascAppId`, `appleTeamId` 가 필요합니다.

---

## 3. 출시 전 정리해야 할 항목 (차단은 아님)

### C1. `ios.supportsTablet` — **반영됨 (2026-09-21)**

`"supportsTablet": false` 로 변경했습니다(권장안, 작업량 0). iPad 지원이
필요해지면 되돌리고 iPad 레이아웃·스크린샷을 별도로 준비해야 합니다.

### C2. `ios.buildNumber` — **반영됨 (2026-09-21)**

`app.json`의 `ios.buildNumber`를 `"1"`로 추가했습니다. `eas.json`이
`"appVersionSource": "local"`이므로 재제출 시마다 이 값을 올려야 합니다.

### C3. 수출 규정(encryption) 답변 — **반영됨 (2026-09-21)**

`app.json`의 `ios.infoPlist`에 `"ITSAppUsesNonExemptEncryption": false`를
추가했습니다. HTTPS만 쓰므로 이 값이 맞습니다.

### C4. iOS 스크린샷 없음

6.7"(iPhone 15 Pro Max 등) 스크린샷이 필수입니다. 현재는 Android 용
1080x1920 만 있습니다.

### C5. 개발용 화면이 번들에 포함됨

`src/screens/DashboardSample.tsx` 는 `__DEV__` 로 진입 버튼이 가려져 있고
딥링크 경로도 없어서 **출시 빌드에서 도달할 수 없습니다.** 다만 `App.tsx` 가
무조건 import 하므로 번들에는 들어갑니다. 기능상 문제는 없고 용량만 늘어납니다.

### C6. Firebase 설정값이 저장소에 하드코딩

`src/database/firebase.ts` 에 apiKey 등이 그대로 있습니다. Firebase 웹 apiKey 는
원래 공개되는 값이라 그 자체는 취약점이 아니지만, 보안은 전적으로
`firestore.rules` 에 달려 있습니다. 규칙을 바꿀 때 특히 주의해야 합니다.

---

## 4. 이번에 바꾼 동기화 구조 (심사와 무관하지만 검증 대상)

### 무엇이 문제였나

기록을 하나 남길 때마다 `syncWithCloud` 가 `getDocs(logsRef)` 로 **가족의 기록
문서 전체를 서버에서 다시 읽었습니다.** 기록이 1,000건이면 동기화 한 번에 읽기
1,000회입니다. 무료 등급 하루 읽기 한도는 50,000회라, 두 보호자가 평소처럼 쓰면
하루치 한도가 수십 번의 동기화로 사라집니다.

한도가 소진되면 Firestore 는 거부가 아니라 **무한 재시도로 매달려서**, 앱에서는
"동기화가 그냥 멈춘 것"처럼 보입니다 (2026-08-22 에 실제로 겪은 증상).

### 무엇을 바꿨나

로컬 우선 + 아웃박스(outbox) 방식으로 바꿨습니다.

- `@baby_sync_ledger_v1` 에 가족별로 (a) 마지막으로 반영한 **서버 시각 커서**,
  (b) 서버에 올라간 것이 확인된 기록의 `updatedAt`, (c) 확정된 삭제 표시를 적습니다.
- 다음 동기화는 `where('updatedAt', '>=', 커서)` 로 **그 이후 바뀐 문서만** 읽습니다.
- 업로드 대상은 장부와 비교해 정합니다. 증분 응답에 없다고 해서 "서버에 없다"고
  판단하지 않으므로, 기록 전체를 다시 올리는 사고가 나지 않습니다.
- 삭제 표시(tombstone)에도 `updatedAt` 을 남깁니다. 없으면 증분 질의에 영영
  걸리지 않아 상대가 삭제를 못 받습니다.

### 안전장치 (장부가 틀려도 기록이 사라지지 않게)

장부는 **비용을 줄이기 위한 힌트일 뿐**이고, 틀리면 항상 전체 읽기로 되돌아갑니다.

| 상황 | 동작 |
| --- | --- |
| 장부 없음 / 깨짐 / 다른 가족 | 전체 읽기 |
| 마지막 전체 대조 후 6시간 경과 | 전체 읽기 |
| 사용자가 당겨서 새로고침 | 전체 읽기 (강제) |
| 백업 복원 · 데이터 가져오기 | 장부 삭제 → 다음 회차 전체 읽기 |
| 커밋 직전에 상대가 먼저 씀 | 장부에 기록하지 않고 다음 회차 전체 대조 |

커서 경계는 `>` 가 아니라 `>=` 입니다. 같은 밀리초에 쓰인 문서를 놓치느니
이미 가진 문서 몇 개를 다시 읽는 편이 낫기 때문입니다.

### 측정된 효과 (가짜 클라우드)

기록 40건 기준으로 **동기화 1회당 읽기 40건 → 1건**, 변경 없을 때 쓰기 0회.
`regression.mjs` 가 읽기 수를 직접 세어 확인합니다.

실제 Firestore 에서의 효과는 B2 에서 확인해야 합니다.

---

## 5. 다음 단계 권장 순서

1. **사용자 승인**: B4의 `firestore.rules` 변경을 실제 `babycheck-sync` 프로젝트에
   배포할지 결정 (배포 전 가족 전체 삭제 동작이 의도한 것인지 재확인)
2. 공개 개인정보처리방침 URL 게시 + 앱 내 링크 추가 (B3)
3. ~~C1·C2·C3 설정 반영~~ — 완료 (2026-09-21)
4. EAS iOS 빌드로 B1 해소
5. TestFlight 2기기로 B2 해소 — 특히 증분 동기화 실측 및 B4 삭제 흐름 실기기 검증
6. iOS 스크린샷 촬영 (C4)
7. App Store Connect 등록 + `eas.json` submit 정보 채우기 (B5)
8. 제출
