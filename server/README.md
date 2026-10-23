# Baby-Check Cloudflare Sync Server

Cloudflare Workers + D1 기반의 무과금 초경량 데이터 동기화 백엔드입니다.

## 기능
* **비용 0원**: Cloudflare Workers 무료 티어(일 10만 회) 및 D1 무료 티어(일 500만 읽기, 10만 쓰기) 활용.
* **가족 단위 암호화 격리**: SHA-256 해시 기반의 단방향 `familyId` 식별.
* **LWW 충돌 해결 및 묘비명(tombstone) 보존**: 조건부 SQLite upsert로 오프라인 복구 시 데이터 역전/부활 차단.
* **1시간 냉각 기간 가족 영구 삭제 지원**.

## 배포 방법

### 1. 원클릭 자동 배포 (추천)
Cloudflare 계정 로그인 후 아래 명령어를 실행하면, **D1 생성 → 스키마 적용 → Worker 배포 → 앱 클라이언트 URL 설정**까지 한 번에 완료됩니다:
```bash
npm run server:deploy
```
*(또는 `bash server/deploy.sh`)*

### 2. 수동 배포 단계 (참고용)
1. 터미널에서 Cloudflare 계정 로그인:
   ```bash
   npx wrangler login
   ```
2. D1 데이터베이스 생성:
   ```bash
   npx wrangler d1 create baby-check-db
   ```
   * 출력되는 `database_id`를 복사하여 `server/wrangler.toml`의 `database_id`에 붙여넣습니다.
3. 데이터베이스 테이블 스키마 적용:
   ```bash
   npx wrangler d1 execute baby-check-db --file=./schema.sql --remote --yes
   ```
4. 워커 배포:
   ```bash
   npx wrangler deploy
   ```
   * 배포 완료 후 출력되는 URL (예: `https://baby-check-sync.<your-subdomain>.workers.dev`)을 복사하여 앱의 `src/database/cloudConfig.ts`의 `DEFAULT_WORKER_URL`에 설정합니다.

---

## 로컬 개발 및 오프라인 테스트 (로그인 불필요)
Cloudflare 계정이 없어도 로컬에서 완전한 Worker + SQLite 환경으로 실행할 수 있습니다:
1. 로컬 D1 스키마 초기화:
   ```bash
   npm run server:init-local
   ```
2. 로컬 개발 서버 실행:
   ```bash
   npm run server:dev
   ```
   * `http://localhost:8787`에서 로컬 Worker와 D1이 동작합니다.
