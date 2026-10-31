# 인수인계 2: 한줄 육아일기 (구현 뒤 검증 단계)

- 워크트리: `/Users/seonggi/Desktop/PDS/dev/baby-check-diary`, 브랜치 `feat/daily-diary`
- 이전 세션 ID: `d51a4edc-fd8c-4732-9f8b-c20b071b3403` (`claude --resume`으로 복구할 수 있다)
- 응답은 항상 한국어로 하고, 쉬운 말로 먼저 요약한다(좋음/문제).
- 처음 인수인계 문서 `HANDOFF.md`의 2장(제약)과 3장(건드리면 안 되는 것)은 그대로 유효하다. 먼저 읽는다.

## 1. 지금 상태 (2026-11-01)
- 요구사항 `01-요구사항.md`: 성기님 답변 반영 완료.
  - 아빠/엄마 역할은 프로필에서 먼저 정한다.
  - 지난 날짜에도 쓰고 고칠 수 있다. 한 줄은 200자까지다.
  - 자기 줄만 고치고 지운다. 댓글 기능을 넣는다.
- 설계 `02-설계.md`: 독립 검토 3회차에서 **승인**.
- 계획 `03-계획.md`의 커밋 1~6 구현 완료. 모두 로컬 커밋이고 푸시하지 않았다.
  ```
  0752bfc test(diary): add two-device diary scenarios for the real server harness
  5bfc79b feat(diary): add diary editor, diary screen and today's line on home
  8d98685 feat(diary): add diary author role picker to the profile screen
  0a9d9aa feat(diary): keep diary lines and comments out of activity views
  da5e899 feat(diary): add diary save and delete paths with role preservation
  4c4affa feat(diary): add diary data types and pure helpers
  ```
- 이전 세션이 직접 확인한 것:
  - `npx tsc --noEmit`이 통과했다.
  - `npm run test:diary`가 85/85 통과했다.
  - `storage.ts`의 기존 함수 변경은 `normalizeProfile`, `importDataWithoutLoss`, `restoreFromLocalBackup`에서 각 2줄뿐이다. 나머지 변경은 새 함수 추가다.
- 구현 작업자의 보고이며, 이전 세션은 다시 돌려 보지 않은 것:
  - `verify.sh offline`에서 실패 0건이었다. 일기 시나리오는 3/3이었다.
  - 서버 tsc와 `test:voice`가 통과했다.
- 구현 작업자가 설계와 다르게 한 점:
  - `feedingReminder.ts`의 `buildWidgetSnapshot`에 `export`를 붙였다. 시험용이고 동작은 같다.
  - 일기 시나리오는 짧게 사는 별도 프로세스로 저장 함수를 부른다. `device-real.mjs`에 일기 명령이 없기 때문이다.
  - Dashboard·Statistics의 거르기는 Node에서 불러 시험할 수 없다. 그래서 소스 문자열로 확인한다.

## 2. 주의
- 작업 트리에 `?? node_modules`가 있다.
  - 정체: 구현 작업자가 만든 심볼릭 링크다. `../baby-check-cloudflare/node_modules`를 가리킨다. `package.json`과 lock 파일이 같아서 이 방법을 썼다.
  - `.gitignore`에 걸리지 않으므로 **절대 커밋하지 않는다**(`git add -A`, `git add .` 금지, 파일을 지정해서 add한다).
  - 링크 대상 폴더 안의 파일은 바꾸지 않는다.
  - 검증이 끝나면 링크만 지울지 성기님께 여쭌다. `rm node_modules`로 링크만 지우고, 끝에 `/`를 붙이지 않는다.
- 화면은 tsc 통과까지만 확인했다. 에뮬레이터나 실기기로 본 적이 없다.

## 3. 다음 세션이 할 일 (이 순서대로)
1. `git log --oneline -9`과 `git status --short`로 위 상태가 맞는지 확인한다.
2. **독립 리뷰 2개**를 동시에 띄운다. 리뷰어에게는 결론이 아니라 코드와 설계 문서를 준다.
   - 리뷰 A(정확성·데이터 보전): `storage.ts`, `src/utils/diary.ts`, 시험 파일. 설계 2·3·7장과 맞는지, 기존 기록을 덮거나 지우는 경로가 없는지 본다.
   - 리뷰 B(화면·1.8.0 호환): `Diary.tsx`, `DiaryEditor.tsx`, `Dashboard.tsx`, `Profile.tsx`, `App.tsx`. 본인만 고치기·지우기, `targetId` 전달, 저장 버튼 두 번 누르기 방지, 200자 초과 기존 줄 처리, 생일 하한 예외, 가족 연결이 없을 때 동기화를 부르지 않는지 본다.
   - 지적을 모아 고치고 다시 리뷰한다(최대 3회).
3. **전체 검사**: `npx tsc --noEmit`, `npx tsc --noEmit --project server/tsconfig.json`, `npm run test:voice`, `npm run test:diary`. 그리고 `(ulimit -u $(( $(ps -u $(id -u) -o pid= | wc -l) + 150 )); bash tools/sync-harness/verify.sh offline)`를 직접 돌린다.
4. **변이 검증**: 설계 8장 5번의 ①~⑨를 하나씩 임시로 바꾼다. 시험이 실패하는지 보고 `git checkout -- <파일>`로 원복한다.
   - ①은 작업자가 이미 해 봤다. DY2와 DY3이 실패했다. 다시 확인해도 된다.
   - 실패하지 않는 변이가 있으면 시험을 보강한다.
5. `04-검증.md`를 쓴다. 실제 명령 출력과 변이 결과표를 넣고 로컬 커밋한다.
6. 성기님께 결과를 쉬운 말로 보고하고, 아래 승인 전 항목을 여쭌다.

## 4. 승인 전 (성기님 확인 뒤에만)
- 에뮬레이터·실기기 화면 확인용 빌드.
  - 방법은 `HANDOFF.md` 3장의 `./gradlew` 방법만 쓴다. `expo run:android`와 `prebuild`는 쓰지 않는다.
- 푸시, PR, 머지.
- 버전 1.8.1(코드 29)로 올리기, Play 업로드, 원스토어 APK.
- `node_modules` 링크 삭제.
