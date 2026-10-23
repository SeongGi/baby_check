-- Cloudflare D1 Database Schema for Baby-Check Sync

CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,                       -- familyId (SHA-256 해시)
  created_at INTEGER NOT NULL,               -- 생성 시각 (밀리초)
  updated_at INTEGER NOT NULL,               -- 마지막 변경 시각 (토큰용)
  last_client_id TEXT DEFAULT NULL,          -- 마지막으로 변경을 커밋한 클라이언트 ID
  deletion_ready_at INTEGER DEFAULT NULL,    -- 삭제 예약 시각 (1시간 냉각 기간 종료 시점)
  shared_name TEXT,                          -- 아기 이름
  shared_birth_date TEXT,                    -- 생년월일
  shared_birth_weight TEXT,                  -- 출생 체중
  shared_target_formula INTEGER,             -- 목표 수유량
  profile_updated_at INTEGER DEFAULT 0       -- 프로필 수정 시각
);

CREATE TABLE IF NOT EXISTS members (
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, client_id)
);

CREATE TABLE IF NOT EXISTS logs (
  family_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,        -- 클라이언트 측정/수정 시각 (LWW 충돌 판정용)
  updated_at INTEGER NOT NULL,               -- 서버 수신 시각 (증분 풀 커서용)
  deleted_at INTEGER DEFAULT NULL,           -- 삭제 표식 (tombstone)
  raw_json TEXT NOT NULL,                    -- 전체 BabyLogEntry JSON
  PRIMARY KEY (family_id, log_id)
);

CREATE INDEX IF NOT EXISTS idx_logs_family_updated 
ON logs (family_id, updated_at);
