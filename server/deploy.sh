#!/usr/bin/env bash
# Baby-Check Cloudflare Sync 원클릭 배포 스크립트
# 사용법: bash server/deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${SCRIPT_DIR}"

echo "=========================================================="
echo "👶 Baby-Check Cloudflare Workers + D1 원클릭 배포"
echo "=========================================================="

# 1. Wrangler 로그인 상태 확인
echo ""
echo "▶ [1/5] Cloudflare 로그인 상태 확인 중..."
if ! npx wrangler whoami > /dev/null 2>&1; then
  echo "⚠️ Cloudflare에 로그인되어 있지 않습니다."
  echo "👉 브라우저를 열어 로그인을 진행합니다..."
  npx wrangler login
fi

echo "✅ Cloudflare 인증 확인 완료!"
npx wrangler whoami

# 2. D1 데이터베이스 확인 및 생성
echo ""
echo "▶ [2/5] D1 데이터베이스(baby-check-db) 확인 중..."
DB_NAME="baby-check-db"
DB_INFO_JSON=$(npx wrangler d1 list --json 2>/dev/null || echo "[]")

DB_ID=$(echo "${DB_INFO_JSON}" | node -e '
  const fs = require("fs");
  const input = fs.readFileSync(0, "utf-8");
  try {
    const list = JSON.parse(input);
    const db = Array.isArray(list) ? list.find(d => d.name === "baby-check-db") : null;
    if (db && db.uuid) console.log(db.uuid);
  } catch {}
')

if [ -z "${DB_ID}" ]; then
  echo "ℹ️  '${DB_NAME}' 데이터베이스가 없어 새로 생성합니다..."
  CREATE_OUTPUT=$(npx wrangler d1 create "${DB_NAME}")
  echo "${CREATE_OUTPUT}"
  DB_ID=$(echo "${CREATE_OUTPUT}" | grep -o 'database_id = "[^"]*"' | cut -d'"' -f2 || true)
fi

if [ -z "${DB_ID}" ]; then
  echo "❌ D1 database_id를 가져오지 못했습니다. wrangler d1 list 출력을 확인해 주세요."
  exit 1
fi

echo "✅ D1 database_id: ${DB_ID}"

# wrangler.toml의 database_id 갱신
node -e '
  const fs = require("fs");
  const path = require("path");
  const tomlPath = path.join(process.cwd(), "wrangler.toml");
  let content = fs.readFileSync(tomlPath, "utf-8");
  content = content.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${process.argv[1]}"`);
  fs.writeFileSync(tomlPath, content, "utf-8");
' "${DB_ID}"
echo "✅ wrangler.toml에 database_id 반영 완료!"

# 3. D1 원격 스키마 적용
echo ""
echo "▶ [3/5] D1 원격 데이터베이스에 스키마(schema.sql) 적용 중..."
npx wrangler d1 execute "${DB_NAME}" --file=./schema.sql --remote --yes
echo "✅ 스키마 적용 완료!"

# 4. 워커 배포
echo ""
echo "▶ [4/5] Cloudflare Worker 배포 중..."
DEPLOY_OUTPUT=$(npx wrangler deploy)
echo "${DEPLOY_OUTPUT}"

WORKER_URL=$(echo "${DEPLOY_OUTPUT}" | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -n 1 || true)

if [ -z "${WORKER_URL}" ]; then
  echo "⚠️ 배포 URL을 자동으로 추출하지 못했습니다."
  echo "출력된 worker URL을 src/database/cloudConfig.ts에 직접 지정해 주세요."
else
  echo ""
  echo "▶ [5/5] 앱 설정에 Worker URL 자동 반영 중: ${WORKER_URL}"
  CONFIG_PATH="${ROOT_DIR}/src/database/cloudConfig.ts"
  node -e '
    const fs = require("fs");
    const configPath = process.argv[1];
    const workerUrl = process.argv[2];
    let content = fs.readFileSync(configPath, "utf-8");
    content = content.replace(/export const DEFAULT_WORKER_URL\s*=\s*'\''[^'\'']*'\''/, `export const DEFAULT_WORKER_URL = '\''${workerUrl}'\''`);
    fs.writeFileSync(configPath, content, "utf-8");
  ' "${CONFIG_PATH}" "${WORKER_URL}"
  echo "✅ ${CONFIG_PATH} 에 DEFAULT_WORKER_URL 설정 완료!"
fi

echo ""
echo "=========================================================="
echo "🎉 Cloudflare 백엔드 원클릭 배포가 성공적으로 완료되었습니다!"
echo "   Worker URL: ${WORKER_URL:-'(수동 확인 필요)'}"
echo "=========================================================="
