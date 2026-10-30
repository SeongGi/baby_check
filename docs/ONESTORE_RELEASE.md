# 원스토어 출시 절차

구글 플레이 심사가 길어서 원스토어 출시를 함께 진행합니다. 원스토어 개발자 FAQ에 따르면 심사는 보통 한국 영업일 기준 1일 안에 끝납니다.

## 1. 먼저 결정할 것: 서명 키

원스토어 바이너리 서명 방식은 네 가지가 있으며, 앱을 한 번 등록하면 서명 키를 바꿀 수 없습니다.

| 방식 | 설명 | 이 앱에 맞는지 |
|---|---|---|
| 원스토어 앱 서명 | 원스토어가 키를 만들어 보관합니다. | Play 설치본과 서명이 달라집니다. |
| 직접 만든 키 등록 | PEPK 도구로 내 키를 원스토어에 넘깁니다. | Play 앱 서명 키를 내려받을 수 있을 때만 서명을 맞출 수 있습니다. |
| 앱 서명 사용 안 함 | 직접 서명한 APK를 올립니다(APK만 가능). | **추천합니다.** 우리 릴리스 키(`baby-check-release.jks`)로 서명한 APK를 그대로 올립니다. |
| 같은 계정의 다른 앱 키 재사용 | 해당 없음 | 해당 없음 |

**주의:** Play Console에서 Play 앱 서명이 켜져 있으면, Play 설치본은 Google 키로 서명됩니다. 이 경우 원스토어 설치본(우리 업로드 키로 서명)과 서명이 달라서, 한 기기에서 스토어를 바꿔 업데이트할 수 없습니다.

- 기존 Play 테스터(실사용자 2명 포함)는 Play 설치본을 계속 쓰게 합니다.
- 스토어를 꼭 바꿔야 하면, 가족 연결 동기화가 끝난 것을 확인하고 설정 화면에서 백업을 내보낸 뒤 앱을 지우고 설치합니다. 앱을 지우면 기기에 저장된 기록도 함께 지워집니다.
- Play Console → 앱 무결성 → 앱 서명에서 실제 서명 방식을 확인해 주세요.

업로드 인증서 정보(`baby-check-upload-certificate.pem`)는 다음과 같습니다.

- 주체: `C=KR, ST=Seoul, L=Seoul, O=BabyCheck, OU=Release, CN=SeongGi`
- SHA-256: `60:1E:71:8F:9F:A6:D0:CE:53:E8:08:1D:2F:10:71:EE:44:03:7D:11:E4:1D:D2:07:0B:BE:AC:F2:99:CD:AA:8B`

원스토어는 패키지명과 서명 인증서 SHA-256으로 Google의 Android 개발자 인증 여부를 확인합니다. Google Play Console의 개발자 인증에 위 지문이 패키지 `com.seonggi.babycheck`로 등록되어 있어야 합니다.

## 2. 원스토어 빌드 만들기

원스토어 빌드는 설정 화면에 "Google Play에서 업데이트 확인" 버튼 대신 원스토어 안내 문구를 보여 줍니다. 빌드할 때 환경 변수를 넣으면 이 동작이 켜집니다.

```bash
cd android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
EXPO_PUBLIC_DISTRIBUTION_STORE=onestore ./gradlew app:assembleRelease \
  -PBABY_CHECK_RELEASE_STORE_FILE=<릴리스 키스토어 경로> \
  -PBABY_CHECK_RELEASE_STORE_PASSWORD=<비밀번호> \
  -PBABY_CHECK_RELEASE_KEY_ALIAS=<별칭> \
  -PBABY_CHECK_RELEASE_KEY_PASSWORD=<비밀번호>
# 결과: android/app/build/outputs/apk/release/app-release.apk
```

- `npx expo run:android`와 `expo prebuild`는 쓰지 마세요. 이 명령들은 `android/`를 다시 만들면서 직접 관리하는 릴리스 서명 설정과 위젯 코드를 덮어씁니다.
- Play용 AAB는 지금처럼 환경 변수 없이 `bundleRelease`로 만듭니다.
- 서명 확인: `$ANDROID_HOME/build-tools/<버전>/apksigner verify --print-certs app-release.apk`에서 SHA-256이 위 지문과 같아야 합니다.

## 3. 원스토어 개발자센터 등록 순서

1. [원스토어 개발자센터](https://dev.onestore.co.kr)에 가입하고 개발자 정보와 정산 정보를 등록합니다. 무료 앱이면 정산 정보는 나중에 넣어도 됩니다.
2. Apps → 상품현황 → **신규 상품 등록**을 누릅니다.
   - 서비스 구분: **정식 출시**를 고릅니다. 베타로 등록하면 정식 출시할 때 같은 패키지명을 다시 쓸 수 없습니다.
   - OS: Android
   - 상품제목: 아기기록
   - 기본언어: 한국어
   - 패키지 네임: `com.seonggi.babycheck`(등록 후 바꿀 수 없습니다)
3. 앱 정보를 입력합니다. Play 등록에 썼던 자료를 다시 씁니다.
   - 아이콘: `play-store-icon-512.png`
   - 스크린샷: `play-screenshot-home-1080x1920.png`, `play-screenshot-statistics-1080x1920.png`
   - 대표 이미지: `play-feature-graphic-1024x500.png`
   - 개인정보처리방침: https://seonggi.github.io/baby_check/privacy-policy.html
   - 카테고리: 육아 또는 건강에 가까운 항목을 고릅니다.
4. 바이너리 정보: 유형은 APK, 서명은 **앱 서명 사용 안 함**으로 두고 2단계의 `app-release.apk`를 올립니다.
5. 심사를 요청합니다.
6. 심사를 통과하면 상품 ID(PID)를 알려 주세요. 설정 화면에서 원스토어 상세 페이지로 바로 가는 링크를 추가하겠습니다.

## 출처

- [신규로 앱 등록하기](https://onestore-dev.gitbook.io/dev/docs/apps/register-app)
- [Binary 등록 요건](https://onestore-dev.gitbook.io/dev/eng/docs/apps/android/binary)
- [앱 심사 절차](https://onestore-dev.gitbook.io/dev/eng/docs/review)
