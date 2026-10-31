#!/usr/bin/env bash
# 동기화 검증 실행기.
#   ./verify.sh unit        네트워크 없이 프로필 규칙만 (무료, 항상 먼저 돌릴 것)
#   ./verify.sh regression  가짜 Worker로 도는 회귀 시나리오 (무료)
#   ./verify.sh real        실제 Worker 코드를 서버 프로세스로 띄운 모드 (무료, 127.0.0.1만 사용).
#                           제어 엔드포인트 자체 점검, 같은 회귀, 시나리오(real-scenarios-*.mjs)
#   ./verify.sh scenario <파일>  실제 서버 시나리오 파일 하나만
#   ./verify.sh compat      예전 형식 데이터 호환성  (실제 Firestore 사용)
#   ./verify.sh full        두 기기 통합 시나리오    (실제 Firestore 사용)
#   ./verify.sh reminder    알림 계산
#   ./verify.sh rules       firestore.rules 가정 여덟 가지를 로컬 Firebase 에뮬레이터로 확인
#                           (Java 17과 에뮬레이터 내려받기가 필요해 offline, all에는 넣지 않음.
#                           tools/rules-check 에서 npm install 을 먼저 하세요. 실제 Firebase에는 접속하지 않음)
#   ./verify.sh offline     unit + regression + real + reminder. 할당량을 쓰지 않는 전부
#   ./verify.sh all         offline 다음에 compat, full을 순서대로
# real 모드의 기기는 firestoreImport.ts와 firebase.ts의 firebase/* import를 가짜 Firestore(stubs/fake-firestore.mjs)로 보냅니다
# (loader.mjs, HARNESS_REAL_WORKER=1에서 자동). 실제 Firebase에는 접속하지 않습니다.
# real 모드는 프로세스를 여러 개 띄웁니다. 아래처럼 프로세스 수 상한 안에서 돌리세요.
#   (ulimit -u $(( $(ps -u $(id -u) -o pid= | wc -l) + 150 )); ./verify.sh real)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOADER_IMPORT="data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('file://${DIR}/loader.mjs', pathToFileURL('./'));"

run_unit() {
  rm -f "$DIR/storage-unit.json"
  HARNESS_STORAGE_FILE="$DIR/storage-unit.json" node --import "$LOADER_IMPORT" "$DIR/unit.mjs"
}

run_regression() {
  rm -f "$DIR/storage-regression.json"
  HARNESS_FAKE_CLOUD=1 HARNESS_STORAGE_FILE="$DIR/storage-regression.json" \
    node --import "$LOADER_IMPORT" "$DIR/regression.mjs"
}

# node:sqlite 의 실험 기능 경고를 숨기는 옵션을 더해 서버와 기기 프로세스를 띄웁니다.
run_real() {
  rm -f "$DIR"/storage-real-*.json "$DIR/storage-regression-real.json" "$DIR"/storage-scenarios-real*.json
  node --disable-warning=ExperimentalWarning --import "$LOADER_IMPORT" "$DIR/real-selfcheck.mjs"
  HARNESS_REAL_WORKER=1 HARNESS_STORAGE_FILE="$DIR/storage-regression-real.json" \
    node --disable-warning=ExperimentalWarning --import "$LOADER_IMPORT" "$DIR/regression.mjs"
  # 설계 06 5.1의 시나리오 파일(real-scenarios-1.mjs, real-scenarios-2.mjs …)을 이름 순서로 모두 돌립니다.
  local scenario
  for scenario in "$DIR"/real-scenarios-*.mjs; do
    [ -f "$scenario" ] || continue
    HARNESS_STORAGE_FILE="$DIR/storage-scenarios-real-$(basename "$scenario" .mjs).json" \
      node --disable-warning=ExperimentalWarning --import "$LOADER_IMPORT" "$scenario"
  done
}

# 시나리오 파일 하나만 돌립니다. 예: ./verify.sh scenario real-scenarios-1.mjs
run_scenario() {
  local scenario="$DIR/$1"
  [ -f "$scenario" ] || { echo "시나리오 파일이 없습니다: $1" >&2; exit 2; }
  HARNESS_STORAGE_FILE="$DIR/storage-scenarios-real-$(basename "$scenario" .mjs).json" \
    node --disable-warning=ExperimentalWarning --import "$LOADER_IMPORT" "$scenario"
}

run_reminder() {
  rm -f "$DIR/storage-reminder.json"
  HARNESS_STORAGE_FILE="$DIR/storage-reminder.json" node --import "$LOADER_IMPORT" "$DIR/reminder.mjs"
}

# 설계 07 5.1의 규칙 가정 확인. demo- 프로젝트 id라 실제 Firebase에 접속하지 않습니다.
run_rules() {
  local rules_dir="$DIR/../rules-check"
  [ -d "$rules_dir/node_modules" ] || { echo "먼저 실행하세요: (cd tools/rules-check && npm install)" >&2; exit 2; }
  (
    cd "$rules_dir"
    export JAVA_HOME=/opt/homebrew/opt/openjdk@17
    export PATH="$JAVA_HOME/bin:$PATH"
    npx --no-install firebase emulators:exec --only firestore --project demo-babycheck-rules "node rules.test.mjs"
  )
}

case "${1:-all}" in
  unit)       run_unit ;;
  regression) run_regression ;;
  real)       run_real ;;
  scenario)   run_scenario "${2:?시나리오 파일 이름이 필요합니다}" ;;
  reminder)   run_reminder ;;
  rules)      run_rules ;;
  offline)    run_unit && run_regression && run_real && run_reminder ;;
  compat)     node "$DIR/compat.mjs" ;;
  full)       node "$DIR/run.mjs" ;;
  all)        run_unit && run_regression && run_real && run_reminder && node "$DIR/compat.mjs" && node "$DIR/run.mjs" ;;
  *)          echo "usage: $0 [unit|regression|real|scenario <파일>|reminder|rules|offline|compat|full|all]" >&2; exit 2 ;;
esac
