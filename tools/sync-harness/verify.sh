#!/usr/bin/env bash
# 동기화 검증 실행기.
#   ./verify.sh unit        네트워크 없이 프로필 규칙만 (무료, 항상 먼저 돌릴 것)
#   ./verify.sh regression  가짜 Worker로 도는 회귀 시나리오 (무료)
#   ./verify.sh real        실제 Worker 코드를 서버 프로세스로 띄운 모드 (무료, 127.0.0.1만 사용).
#                           제어 엔드포인트 자체 점검, 같은 회귀, 시나리오(real-scenarios.mjs가 있으면)
#   ./verify.sh compat      예전 형식 데이터 호환성  (실제 Firestore 사용)
#   ./verify.sh full        두 기기 통합 시나리오    (실제 Firestore 사용)
#   ./verify.sh reminder    알림 계산
#   ./verify.sh offline     unit + regression + real + reminder. 할당량을 쓰지 않는 전부
#   ./verify.sh all         offline 다음에 compat, full을 순서대로
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
  rm -f "$DIR"/storage-real-*.json "$DIR/storage-regression-real.json" "$DIR/storage-scenarios-real.json"
  node --disable-warning=ExperimentalWarning --import "$LOADER_IMPORT" "$DIR/real-selfcheck.mjs"
  HARNESS_REAL_WORKER=1 HARNESS_STORAGE_FILE="$DIR/storage-regression-real.json" \
    node --disable-warning=ExperimentalWarning --import "$LOADER_IMPORT" "$DIR/regression.mjs"
  # A7에서 붙는 시나리오 파일입니다. 아직 없으면 건너뜁니다.
  if [ -f "$DIR/real-scenarios.mjs" ]; then
    HARNESS_STORAGE_FILE="$DIR/storage-scenarios-real.json" \
      node --disable-warning=ExperimentalWarning --import "$LOADER_IMPORT" "$DIR/real-scenarios.mjs"
  fi
}

run_reminder() {
  rm -f "$DIR/storage-reminder.json"
  HARNESS_STORAGE_FILE="$DIR/storage-reminder.json" node --import "$LOADER_IMPORT" "$DIR/reminder.mjs"
}

case "${1:-all}" in
  unit)       run_unit ;;
  regression) run_regression ;;
  real)       run_real ;;
  reminder)   run_reminder ;;
  offline)    run_unit && run_regression && run_real && run_reminder ;;
  compat)     node "$DIR/compat.mjs" ;;
  full)       node "$DIR/run.mjs" ;;
  all)        run_unit && run_regression && run_real && run_reminder && node "$DIR/compat.mjs" && node "$DIR/run.mjs" ;;
  *)          echo "usage: $0 [unit|regression|real|reminder|offline|compat|full|all]" >&2; exit 2 ;;
esac
