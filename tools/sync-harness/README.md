# 동기화 검증 하네스

두 대의 휴대폰을 실제로 흉내 내서 Firestore 동기화를 검증합니다. 동기화 버그는
기기가 둘 있어야만 재현되기 때문에, 코드를 고칠 때마다 여기서 먼저 확인합니다.

## 실행

```bash
tools/sync-harness/verify.sh offline     # unit + regression + real + reminder. 네트워크 없음, 무료. 항상 먼저.
tools/sync-harness/verify.sh unit        # 프로필 공유 시각 규칙만
tools/sync-harness/verify.sh regression  # 가짜 Worker로 도는 회귀 시나리오
tools/sync-harness/verify.sh real        # 실제 Worker 코드를 서버 프로세스로 띄운 모드 (아래 "실제 서버 모드")
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

## 실제 서버 모드

Cloudflare 동기화(1.8.0)는 가짜 Worker(`stubs/fake-worker.mjs`)로 클라이언트만 빠르게 검사하고, 서버 동작의 판정은
**실제 서버 코드(`server/src/index.ts`)** 로 합니다. `verify.sh real` 이 아래를 순서대로 돌립니다. 127.0.0.1 밖으로는 나가지
않고 Cloudflare 계정도 쓰지 않습니다.

1. `real-selfcheck.mjs`: 제어 엔드포인트, D1 흉내의 한도와 집계, 기기 명령, 저장 고장 주입, 자기 검사를 점검합니다.
2. `regression.mjs` (`HARNESS_REAL_WORKER=1`): 기존 회귀를 실제 서버에 대고 다시 돌립니다. 이 프로세스가 기기 하나이고 서버는 따로 뜹니다.
3. `real-scenarios.mjs`: 두 기기 시나리오입니다. 파일이 생기면 자동으로 이어서 돕니다.

프로세스를 여러 개 띄우므로 상한 안에서 돌리세요. `spawn ... EAGAIN` 이 보이면 다시 돌리지 말고 `ps` 로 무엇이 불어났는지 보세요.

```bash
(ulimit -u $(( $(ps -u $(id -u) -o pid= | wc -l) + 150 )); tools/sync-harness/verify.sh real)
```

시나리오를 쓸 때는 `real-harness.mjs` 를 씁니다. 서버 하나와 기기 여러 대를 띄우고, 끝나면(예외와 시그널 포함) 자식 프로세스를 모두 정리합니다.

```js
const harness = await startRealHarness({ devices: ['A', 'B'] });
const { server, devices: { A, B } } = harness;
await selfCheckDevices(harness);                  // 기기마다 clientId와 저장 파일이 다른지
await A.send('runnerRequest', { request: { syncKey, allowFamilyCreation: true, connecting: true } });
await selfCheckMembers(harness, syncKey);         // 첫 연결 뒤 members 에 client_id 두 개
await server.adapter.holdNext({ kind: 'push', batch: 'write' });   // 서버 상태 조회 어댑터
await A.kill(); await A.restart();                // SIGKILL 뒤 같은 저장 파일로 다시
await harness.stop();
```

- **서버**(`real-server.mjs`): `node:sqlite` 위의 D1 흉내(`stubs/d1-mock.mjs`)에서 실제 Worker 코드를 돌립니다. 요청마다 쿼리 수,
  읽은 행, 쓴 행(삽입은 1 + 인덱스 수, 갱신은 1 + 바뀌는 열을 담은 인덱스 수), Worker 처리 시간을 기록합니다. `/__harness/` 제어
  엔드포인트(`clock`, `hold`, `release`, `fail`, `state`, `inject`, `wipe`, `config`)의 사용법은 파일 머리말에 있습니다.
- **기기**(`device.mjs`, `HARNESS_REAL_WORKER=1`): 명령(`device-real.mjs` 머리말 참고)을 동시에 처리하는 휴대폰 한 대입니다.
  요청 상한과 러너 상한은 실제의 10분의 1로 줄여 시작하고, 저장소 흉내(`stubs/async-storage.mjs`)에 저장 고장 주입
  (`injectStorageFault`: 쓰기 뒤 예외, 쓰기 직후 SIGKILL, 쓰기 지연과 `releaseWrite`)이 있습니다.
- **어댑터**(`server-adapter.mjs`): 가짜 Worker와 실제 서버에 같은 질의와 조작을 던집니다. `regression.mjs` 는 어댑터로 쓰여 있어
  두 모드에서 모두 돕니다. 서버 응답을 바꿔치기해야 하는 검사(진전 없음 중단, 불완전한 `remoteProfile` 주입)만 가짜 Worker 모드 전용입니다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `loader.mjs` | Node 에서 앱의 `.ts` 를 그대로 불러오는 ESM 훅. `expo-crypto`, AsyncStorage, `react-native`, 구버전 저장소를 `stubs/` 로 대체합니다. |
| `device.mjs` | 휴대폰 한 대. 프로세스 하나가 익명 사용자 하나에 대응하므로, 프로세스를 나누면 진짜 두 기기와 같은 조건이 됩니다. stdin 으로 JSON 명령을 받습니다. |
| `client.mjs` | 기기 프로세스를 띄우고 명령을 주고받는 쪽. |
| `unit.mjs` | 프로필 공유 시각 규칙 (네트워크 없음). |
| `regression.mjs` | 시간 초과·중단·오프라인·커밋 실패·증분 동기화. 가짜 Worker(`stubs/fake-cloud.mjs` 가 가리키는 `stubs/fake-worker.mjs`)와 실제 서버 모드 양쪽에서 돌아 무료입니다. |
| `real-server.mjs` | 실제 Worker 코드를 HTTP 서버로 띄우는 프로세스와 제어 엔드포인트. `stubs/d1-mock.mjs` 가 D1 흉내입니다. |
| `device-real.mjs` | 실제 서버 모드 기기 명령(러너, 장부, 저장 고장 주입, 기기 시계). |
| `real-harness.mjs` | 서버와 기기 프로세스를 띄우고 SIGKILL, 재시작, 자기 검사, 정리를 맡는 도우미. |
| `server-adapter.mjs` | 서버 상태 조회 어댑터(가짜 Worker용, 실제 서버용). |
| `real-selfcheck.mjs` | 실제 서버 모드 기반 구조의 자체 점검. |
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
