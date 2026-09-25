# 👶 아기기록-도우미 (Baby Record Helper)

부부가 실시간으로 아기의 수유, 수면, 기저귀, 목욕 등의 활동 기록을 기록하고 실시간으로 공유할 수 있는 React Native (Expo) 기반의 육아 기록 관리 앱입니다.

---

## ✨ 주요 기능

1. **실시간 육아 기록**
   - 수유(분유량, 모유 시간), 수면, 기저귀(대/소변), 목욕 및 기타 활동 기록을 직관적이고 빠르게 입력할 수 있습니다.
2. **부부 데이터 실시간 동기화**
   - 한 휴대폰에서 가족을 만든 뒤 초대 링크를 공유하면 두 휴대폰의 기록을 안전하게 동기화합니다.
3. **데이터 백업 및 복구**
   - 전체 데이터(프로필 및 로그)를 JSON 파일로 내보내고, 필요할 때 기존 기록과 안전하게 합쳐 복구합니다.
4. **Google Play 업데이트**
   - 앱의 업데이트 확인 버튼에서 Google Play 상세 화면을 열어 최신 버전 확인과 설치를 진행합니다.

---

## 📱 사용 설명서

### 1. 🔑 부부 데이터 동기화 설정하기
- 앱 우측 상단의 **설정(톱니바퀴) 아이콘**을 누릅니다.
- 첫 휴대폰에서 **"새 가족 만들기"**를 누른 뒤 가족 초대 링크를 공유합니다.
- 다른 휴대폰에서 받은 링크를 누르거나 설정 화면에 붙여넣어 연결합니다.
- 이미 다른 가족에 연결된 휴대폰은 기록이 섞이지 않도록 먼저 기존 연결을 해제해야 합니다.

### 2. 💾 데이터 백업 및 가져오기 (데이터 복원)
- **내보내기 (백업)**:
  - 설정 화면에서 **"데이터 내보내기"** 버튼을 누르면 앱 문서 저장소의 `BabyCheck` 폴더에 JSON 백업 파일이 생성됩니다.
- **가져오기 (복원)**:
  - **"데이터 가져오기"**를 누르고 이전에 저장한 JSON 파일을 선택하면 기존 기록을 지우지 않고 안전하게 합칩니다.

### 🚀 3. 🆙 앱 업데이트 진행하기
- 설정 화면 하단의 **"앱 업데이트 확인"** 버튼을 누릅니다.
- 버튼을 누르면 Google Play가 열리며, 새 버전이 있으면 **업데이트**를 눌러 설치합니다.

---

## 🛠️ 개발자 가이드 (빌드 및 배포)

### 1. 빌드 준비
버전 상향 시 `app.json`, `package.json`, `android/app/build.gradle`의 버전을 함께 일치시킵니다. `versionCode`는 Google Play에 제출할 때마다 반드시 이전 값보다 크게 올립니다.
```json
// app.json
"version": "1.5.1",
"versionCode": 15
```

### 2. Android APK 빌드
프로젝트 루트 폴더에서 아래 명령을 실행합니다:
```bash
# 네이티브 설정 동기화
npx expo prebuild --platform android --no-install

# APK 빌드 실행 (macOS 빌드 환경 기준)
cd android
ANDROID_HOME=~/Library/Android/sdk JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease
```
빌드가 완료되면 `android/app/build/outputs/apk/release/app-release.apk` 경로에 APK 파일이 생성됩니다.

### 3. Google Play 업데이트 배포
새 버전의 `versionName`과 `versionCode`를 올린 뒤 AAB를 빌드하여 Google Play 비공개 Alpha 트랙에 제출합니다. Expo OTA나 GitHub APK 업데이트는 사용하지 않습니다.
```bash
npx eas-cli build --platform android --profile production --auto-submit
```

### 4. iOS 빌드 및 Apple App Store 배포
iOS 빌드는 EAS Build(클라우드 빌드) 또는 정식 Xcode가 설치된 macOS 환경에서 진행합니다. (현재 환경에 Xcode CommandLineTools만 설치되어 있는 경우 로컬 xcodebuild 대신 EAS Build를 권장합니다.)

```bash
# 1) iOS 번들 내보내기 검증
npx expo export --platform ios

# 2) EAS Build 클라우드 빌드 (App Store 배포용 archive)
npx eas-cli build --platform ios --profile production

# 3) App Store Connect 제출 (계정 및 인증서 연결 후)
npx eas-cli submit --platform ios --profile production
```

---

## 🧪 재현 가능한 검증 명령 (Verification Commands)

코드 변경 후 아래 명령들을 통해 정적 분석, 동기화 회귀 테스트 및 빌드 호환성을 일괄 검증할 수 있습니다:

```bash
# 1. 의존성 호환성 점검
npx expo install --check

# 2. TypeScript 타입 체크
npx tsc --noEmit

# 3. 로컬 동기화 스텁 단위 테스트 (18개 시나리오)
bash tools/sync-harness/verify.sh unit

# 4. 동기화 네트워크/예외/경합 회귀 테스트 (10개 시나리오)
bash tools/sync-harness/verify.sh regression

# 5. Expo Web & iOS 번들 빌드 검증
npx expo export --platform web
npx expo export --platform ios
```

---

## 📋 Apple App Store 출시 체크리스트 및 상태 안내
상세한 심사 준비 현황, Apple Review Guidelines 미충족 항목 및 배포 전 필수 사용자 입력 사항은 [APP_STORE_RELEASE_READINESS.md](./APP_STORE_RELEASE_READINESS.md) 문서를 참고하세요.
