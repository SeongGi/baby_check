# 동기화 검증 하네스

두 대의 휴대폰을 실제로 흉내 내서 Firestore 동기화를 검증합니다. 동기화 버그는
기기가 둘 있어야만 재현되기 때문에, 코드를 고칠 때마다 여기서 먼저 확인합니다.

## 실행

```bash
tools/sync-harness/verify.sh offline     # unit + regression. 네트워크 없음, 무료. 항상 먼저.
tools/sync-harness/verify.sh unit        # 프로필 공유 시각 규칙만
tools/sync-harness/verify.sh regression  # 가짜 클라우드로 도는 회귀 시나리오
tools/sync-harness/verify.sh compat      # 예전 형식 데이터 호환성
tools/sync-harness/verify.sh full        # 두 기기 통합 시나리오
tools/sync-harness/verify.sh all
```

`compat` 과 `full` 은 **실제 Firebase 프로젝트(`babycheck-sync`)에 씁니다.**
`harness*` / `compat*` 로 시작하는 임의 가족 ID만 쓰므로 실사용자 가족 데이터는
건드리지 않지만, 무료 등급의 하루 쓰기 한도를 소모하므로 남발하지 마세요.
쓰기가 계속 멈춰 있다면 먼저 사용량을 확인하세요:
https://console.firebase.google.com/project/babycheck-sync/usage

`probe-quota.mjs` 는 쓰기 한 번만 시도해 할당량 소진 여부를 빠르게 확인합니다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `loader.mjs` | Node 에서 앱의 `.ts` 를 그대로 불러오는 ESM 훅. `expo-crypto`, AsyncStorage, `react-native`, 구버전 저장소를 `stubs/` 로 대체합니다. |
| `device.mjs` | 휴대폰 한 대. 프로세스 하나가 익명 사용자 하나에 대응하므로, 프로세스를 나누면 진짜 두 기기와 같은 조건이 됩니다. stdin 으로 JSON 명령을 받습니다. |
| `client.mjs` | 기기 프로세스를 띄우고 명령을 주고받는 쪽. |
| `unit.mjs` | 프로필 공유 시각 규칙 (네트워크 없음). |
| `regression.mjs` | 시간 초과·중단·오프라인·커밋 실패·증분 동기화. `stubs/fake-cloud.mjs` 위에서 돌아 무료입니다. |
| `compat.mjs` | 이미 저장돼 있는 예전 형식 데이터가 보존되는지. |
| `run.mjs` | 합류·전파·삭제·충돌·수렴 등 두 기기 통합 시나리오. |

## 왜 이런 검사를 하는가

- **유휴 동기화가 원격 쓰기를 만들면 안 됩니다.** 변경이 없는데 업로드하면 상대 기기를
  깨우고 그 알림이 다시 동기화를 부르는 루프가 생겨, 하루 쓰기 한도를 태우고 동기화가
  통째로 멈춥니다.
- **새로 설치한 기기가 가족 프로필을 덮으면 안 됩니다.** 기본값(`희성이`/오늘/800)이
  실제 아기 정보를 지운 적이 있습니다.
- **예전 형식 데이터가 계속 읽혀야 합니다.** 클라우드와 휴대폰에 `sharedUpdatedAt` 이
  없는 문서가 남아 있습니다.
- **동기화 한 번이 기록 수만큼 읽기를 쓰면 안 됩니다.** 기록이 쌓일수록 전체 읽기
  방식은 하루 읽기 한도(5만)를 태우고, 한도가 끝나는 순간 두 보호자 모두 동기화가
  멈춥니다. `regression.mjs` 의 증분 동기화 절이 읽기 수를 직접 세어 확인합니다.
