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

## 가짜 Firestore와 이전 시나리오 도구 (07 설계 5.1)

1.7.9(Firestore) 가족이 1.8.0으로 옮겨 오는 경로(단계 B)를 검증하는 도구입니다. 실제 Firestore와 Firebase 프로젝트에는 접속하지 않습니다.

- **방식:** `loader.mjs`가 `src/database/firestoreImport.ts`와 `src/database/firebase.ts`에서 온 `firebase/firestore`, `firebase/auth`, `firebase/app`
  import만 `stubs/fake-firestore.mjs`(가짜 SDK)로 보냅니다. 그래서 두 파일의 **실제 코드**가 그대로 돌고, 이전 모듈(`familyMigration.ts`)은
  앱(`App.tsx`)처럼 `loadFirestore` 주입 없이 `import('./firestoreImport')` 기본 경로로 불러옵니다. 실제 서버 모드(`HARNESS_REAL_WORKER=1`)나
  `HARNESS_FAKE_FIRESTORE=1`일 때만 켜지므로 compat, full과 가짜 Worker 모드는 그대로입니다.
- **상태:** 서버 프로세스(`real-server.mjs`)가 `stubs/fake-firestore-state.mjs`로 Firestore 상태, 규칙, 집계를 갖고, 기기의 가짜 SDK가
  `POST /__fs/rpc`로 질의합니다. 두 기기가 같은 Firestore를 봅니다. `server.adapter.reset()`이 가짜 Firestore도 비웁니다.
- **규칙 흉내:** `firestore.rules`를 옮긴 것이며 `tools/rules-check/rules.test.mjs`의 가정 8가지와 같은 동작입니다(자체 점검이 같은 순서로 재현).
  요청마다 회원 확인(`exists()`)은 규칙 평가 읽기 1회, 회원 생성은 가족 문서 `get()` 1회로 셉니다.
- **캐시 읽기는 없습니다:** 가짜 SDK는 `getDocFromServer`/`getDocsFromServer`만 내보냅니다. 앱이 캐시 허용 `getDoc`/`getDocs`로 바뀌면 불러오는 순간 실패합니다.

### 어댑터 `server.fs` (= `harness.fs`, `firestore-adapter.mjs`)

```js
const { server, fs } = harness;                                  // fs === server.fs
await fs.seed(key, { members: ['legacy-B'], logs, tombstones,    // 1.7.9 가족을 Firestore에 직접 만듦(규칙 우회)
  family: { pendingDeletionAt: ms|null|(생략), inviteHash: 'match'|'omit'|문자열, lastChangedAt: ms|'omit' }, // family: null이면 가족 문서 없음
  profile: { name, sharedUpdatedAt, ... }, docs: [{ path, data }] });   // docs는 깨진 기록 같은 원본 문서. Timestamp는 {__ts: ms}
await fs.snapshot(key);            // { family, members, live: [[id, payload]], deleted: [id], profile }
const mark = await fs.opCount();   // 구간 집계: 앞에서 mark를 잡고
await fs.stats(mark);              // { docReads, ruleReads, reads, writes, denied, terminates, signIns, maxInflight, byDevice }
await fs.audit(mark);              // { appWrites, forbidden, deletes } 불변 조건 2. 또는 auditFirestoreWrites(harness)가 위반 시 예외
await fs.ops(mark); await fs.writes({ from, actor });            // 호출 기록(op, path, kind, 허용 여부, 읽기 수)과 쓰기 목록
await fs.instances();              // Firestore 인스턴스 목록과 terminated 여부
await fs.clock({ advance: ms });   // Firestore 시계. 기기 시계와 함께: await harness.advanceClocks(ms, { d1: true })
```

- **오류와 끝나지 않는 호출:** `fs.fail({ match, code, skip, times })`, `fs.hang(match)`(응답 없음, 기기 SDK는 끝나지 않는 약속), `fs.exhaust(match)`
  (`resource-exhausted`를 계속), `fs.delay(match, ms)`, `fs.offline(on)`, `fs.clearFaults()`. `match`는 `{op: get|list|set|delete|auth|terminate, kind: family|members|logs|profile, device, uid, key, actor}`.
- **걸쇠(페이지 읽기 사이 끼워 넣기):** 호출 하나를 서버에서 멈췄다가 풀어 줍니다.
  ```js
  await fs.interleave({ op: 'list', kind: 'logs', device: 'A' }, { skip: 1 }, {      // 두 번째 페이지 요청을 멈춤
    call: () => A.send('runMigration'),
    between: () => fs.legacy179Write(key, { uid: 'legacy-B', logs: [고친기록] }),    // 이미 읽은 문서를 다른 기기가 고침
  });
  ```
  더 세밀하게는 `const gate = await fs.holdNext(match, opts); ... await gate.held; ...; await gate.release();`.
- **1.7.9 기기 흉내:** `fs.legacy179Join(key, { uid, create })`, `fs.legacy179Write(key, { uid, logs, deleteIds, profile, serverTime })`(기록 쓰기와 `lastChangedAt` 갱신은 같은 트랜잭션, 서버 시각,
  삭제 표식에도 `updatedAt`), `fs.legacy179Schedule(key, { uid, readyAt })`(`lastChangedAt`을 바꾸지 않음), `fs.legacy179Cancel(key, { uid })`. `uid`는 1.7.9 기기를 가리키는 이름이고 규칙(회원이어야 씀)을 그대로 받습니다.
  회원이 아니면 예외입니다. 앱 쓰기 감사(`audit`)에는 섞이지 않습니다.
- **키와 해시:** Firestore 해시는 키를 대소문자 그대로 만듭니다(`fs.familyId(key)`, `fs.inviteHash(key)`). D1 해시는 소문자 키 기준입니다(서버 어댑터의 `family(key)`).

### 기기 명령 (`device-real.mjs` 머리말에도 있음)

| 명령 | 인자 | 반환 | 예 |
| --- | --- | --- | --- |
| `bootApp` | - | `{marker}` | 앱 시작 때의 `migrateStoredData`. 1.7.9 연결 근거 표식을 적음 |
| `runMigration` | `{syncKey?}` | `{result:{status,message}, state}` | 이전 모듈 `ensure`. 키가 없으면 앱처럼 부르지 않고 `{skipped, result:{status:'no_key'}}` |
| `join` | `{key, allowFamilyCreation?, createBackup?, waitMigration?}` | `{outcome, message, syncResult, migrationResult?}` | `joinFamily` 그대로(초대 링크, 키 입력 두 진입점) |
| `legacyJoin` | `{key, createBackup?, waitMigration?}` | `join`과 같음 | 404 뒤 1.7.9 가족 합류 직접 호출 |
| `migrationState` | `{syncKey?}` | `{state, transition, marker, backupMeta, hasBackupValue, gate, d1Status, complete}` | 이전 상태와 관문. 저장소는 `rawStorage`로 읽어 읽기 집계에 섞이지 않음 |
| `transitionTick` | `{syncKey?, force?}` | `{status, reason, message}` | 전환기 읽기 한 번 |
| `setLegacyMarker` / `clearLegacyMarker` | `{keys, checkedAt?}`·`{value:null}` / - | `{marker}` | 표식을 직접 정함, 개발 메뉴의 비우기(`{checkedAt, keys: []}` 덮어쓰기) |
| `restorePreMigrationBackup` | - | `{success, added, logCount}` | 이전 직전 백업 복원 |
| `importData` / `backupLocalData` / `restoreLocalBackup` | `{logs, profile}` / - / - | `{logCount}` / `{ok}` / `{success}` | 가져오기, 로컬 백업 복원(시나리오 11) |
| `setChoiceAnswers` | `{backupFailure?, legacyDeletion?, defaults?, replace?}` | 대기열 길이 | 화면 콜백의 답. 항목은 `'continue'` 같은 문자열, `{answer, delayMs}`, `{hold: true}` |
| `choiceLog` / `answerChoice` | `{clear?}` / `{kind, answer}` | `{backupFailure[], legacyDeletion[], notices[], pending[]}` | 화면 콜백이 받은 값(`context`, `options`)과 안내 기록. `{hold}`로 멈춘 선택 화면은 `answerChoice`가 풀어 줌 |
| `migratorEvents` / `migrationTimers` / `migrationMessages` | `{clear?}` / `{clear?}` / - | `{events}` / `{timers}` / `{messages}` | 이전 모듈 사건, 재시도 타이머, 안내 문구 |
| `migratorReset` | `{firestoreBudgetMs?, firestoreCallTimeoutMs?}` | 적용한 값 | 앱을 다시 연 것처럼 이전 모듈과 러너를 새로 만듦(저장소와 시계는 그대로) |
| `moduleLoads` | - | `{loads:[{module, at}], firestoreImportLoaded, firebaseLoaded, injectedLoads}` | 동적 import 판정(불변 조건 5·6) |
| `storageReads` | `{clear?}` | `{reads:{키:횟수}, order, writes}` | 저장소 읽기 집계(시나리오 34) |
| `firestoreUid` | `{uid?, reset?}` | `{uid}` | 가짜 Firebase 로그인 uid 조회, 변경(uid 변경 시나리오 6) |
| `seedLegacyStorage` | `{items}` | `{count}` | 시작 후 저장소 항목을 직접 적음 |

- `runnerRequest` 결과에 `migrationPending`이, 러너 사건에 `syncKey`와 `requestId`가 들어 있습니다.
- 기기는 Firestore 예산과 호출 상한도 10분의 1로 줄입니다(9초, 1.5초). `migratorReset`으로 바꿉니다.
- 저장 고장 주입에 `mode: 'reject'`(`times`, 용량 부족처럼 파일에 반영하지 않고 던짐)가 더해졌고, `keys`에 `'접두어*'`를 쓸 수 있습니다.
- **1.7.9 기기의 저장소:** `startRealHarness({ devices, deviceOptions: { A: { initialStorage: make179Storage({ syncKey, legacyLedgerKey, logs, profile }) } } })`.
  스키마 2에 프로필 키(`syncKey`)나 옛 장부의 `familyKey`(`legacyLedgerKey`)가 있는 저장소입니다. 새로 설치한 기기는 `initialStorage` 없이 띄웁니다.
- 기기마다 `env: { HARNESS_LOAD_FIRESTORE: 'inject' }`를 주면 이전 모듈에 `loadFirestore`를 주입하고(호출 횟수는 `moduleLoads.injectedLoads`), 없으면 앱과 같은 기본 경로입니다.
- 도우미(`real-harness.mjs`): `waitMigrationComplete(device)`, `waitFor(fn)`, `auditFirestoreWrites(harness)`, `harness.advanceClocks(ms, {d1})`, `firestoreFamilyId(key)`.

### 시나리오 파일 이름 규칙
- 시나리오 1~34는 `real-scenarios-4a.mjs`(기기 이름 접두어 `s4a`)와 `real-scenarios-4b.mjs`(접두어 `s4b`)에 둡니다. 기기 이름이 저장 파일 이름이 되므로
  접두어가 다르면 파일끼리 겹치지 않습니다(`storage-real-s4aA.json` 등). `verify.sh real`이 `real-scenarios-*.mjs`를 이름 순서로 모두 돌립니다.
- 뼈대는 `real-scenarios-3.mjs`를 그대로 씁니다(`scenario(id, title, deviceNames, fn)`). 이전 시나리오는 `startRealHarness({ devices, deviceOptions })`를
  쓰고, 끝나기 전에 `await auditFirestoreWrites(harness)`로 불변 조건 2(시나리오 25)를 모읍니다.
- 일부만: `HARNESS_ONLY=1,2 bash tools/sync-harness/verify.sh scenario real-scenarios-4a.mjs`. 자체 점검의 연기 시험(시나리오 1, 2)은 `real-selfcheck.mjs`에 있습니다.

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
| `real-selfcheck.mjs` | 실제 서버 모드 기반 구조의 자체 점검(가짜 Firestore와 이전 시나리오 연기 시험 포함). |
| `stubs/fake-firestore.mjs` | 기기 쪽 가짜 Firebase SDK(`firebase/firestore`, `auth`, `app`). 서버의 상태에 HTTP로 질의. |
| `stubs/fake-firestore-state.mjs` | 가짜 Firestore의 서버 쪽: 규칙, 집계, 오류 주입, 걸쇠, 1.7.9 흉내. |
| `firestore-adapter.mjs` | `server.fs`: 가짜 Firestore 조작 어댑터. |
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
