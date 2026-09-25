#!/usr/bin/env bash
# 동기화 검증 실행기.
#   ./verify.sh unit        네트워크 없이 프로필 규칙만 (무료, 항상 먼저 돌릴 것)
#   ./verify.sh regression  가짜 클라우드로 도는 회귀 시나리오 (무료)
#   ./verify.sh compat      예전 형식 데이터 호환성  (실제 Firestore 사용)
#   ./verify.sh full        두 기기 통합 시나리오    (실제 Firestore 사용)
#   ./verify.sh offline     unit + regression. 할당량을 쓰지 않는 전부
#   ./verify.sh all         넷을 순서대로
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

case "${1:-all}" in
  unit)       run_unit ;;
  regression) run_regression ;;
  offline)    run_unit && run_regression ;;
  compat)     node "$DIR/compat.mjs" ;;
  full)       node "$DIR/run.mjs" ;;
  all)        run_unit && run_regression && node "$DIR/compat.mjs" && node "$DIR/run.mjs" ;;
  *)          echo "usage: $0 [unit|regression|offline|compat|full|all]" >&2; exit 2 ;;
esac
