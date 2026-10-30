# 인수인계: 1.7.9 키보드 가림·체온 기록·원스토어

- 워크트리: `/Users/seonggi/Desktop/PDS/dev/baby-check-keyboard`, 브랜치 `fix/keyboard-edge-to-edge`(origin/master 기준)
- 로컬 커밋 `e420ff3`까지 완료했고, 푸시는 하지 않았다.
- 검증 결과는 같은 폴더의 `04-검증.md`에 있다(tsc, 테스트, 에뮬레이터, 변이 검증 모두 통과).
- 에뮬레이터는 종료했고, 앱 삭제와 Gradle 데몬 정지도 마쳤다.

## 승인 전 (사용자 승인 없이 진행 금지)
1. 브랜치 푸시와 master 대상 PR 생성
2. PR 머지
3. Play 업로드: 서명된 AAB(`bundleRelease`, 코드 27)를 alpha 트랙에 올린다.
4. 원스토어용 APK 빌드(`docs/ONESTORE_RELEASE.md` 2단계, 릴리스 키 필요)와 사용자에게 전달

## 사용자에게 받아야 할 것
- Play Console의 앱 서명 방식(원스토어 설치본과 서명이 같은지가 이 답에 달려 있다)
- 원스토어 등록 후 상품 ID(PID). 받으면 설정 화면에 원스토어 링크를 추가한다.

## 건드리면 안 되는 것
- `npx expo run:android`와 `expo prebuild`는 쓰지 않는다. 이 명령들이 `android/`의 릴리스 서명 설정과 위젯 코드를 덮어쓴다. 빌드는 `android/`에서 `./gradlew`로 하고, `JAVA_HOME=/opt/homebrew/opt/openjdk@17`을 지정한다.
- 실사용자 데이터: 기존 Play 사용자에게 원스토어 버전으로 갈아타라고 안내하지 않는다.
- `feat/cloudflare-sync` 브랜치(원래 저장소 디렉터리)는 이 작업과 무관하다.

## 남은 확인
- 입력창이 키보드 경계에 딱 붙어서 보인다(24px 여유가 적용되지 않음). 실기기에서 확인해야 한다.
