export interface Env {
  DB: D1Database;
}

interface FamilyRow {
  id: string;
  created_at: number;
  updated_at: number;
  last_client_id: string | null;
  deletion_ready_at: number | null;
  shared_name: string | null;
  shared_birth_date: string | null;
  shared_birth_weight: string | null;
  shared_target_formula: number | null;
  profile_updated_at: number;
}

interface LogRow {
  family_id: string;
  log_id: string;
  client_updated_at: number;
  updated_at: number;
  deleted_at: number | null;
  raw_json: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Id',
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(error: string, status = 400): Response {
  return jsonResponse({ ok: false, error }, status);
}

async function sha256Hex(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getAuthContext(request: Request): Promise<{ familyId: string; clientId: string } | null> {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+([a-fA-F0-9]{32})$/);
  if (!match) return null;

  const syncKey = match[1].toLowerCase();
  const familyId = await sha256Hex(`babycheck:family:v2:${syncKey}`);
  const clientId = request.headers.get('X-Client-Id')?.trim() || 'unknown-client';

  return { familyId, clientId };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const auth = await getAuthContext(request);
    if (!auth) {
      return errorResponse('invalid_or_missing_sync_key', 401);
    }
    const { familyId, clientId } = auth;

    try {
      // 1. POST /api/family/connect
      if (request.method === 'POST' && path === '/api/family/connect') {
        const body = (await request.json().catch(() => ({}))) as { allowCreate?: boolean };
        const allowCreate = Boolean(body.allowCreate);
        const now = Date.now();

        const family = await env.DB.prepare('SELECT * FROM families WHERE id = ?')
          .bind(familyId)
          .first<FamilyRow>();

        if (family) {
          await env.DB.prepare(
            `INSERT INTO members (family_id, client_id, created_at, last_active_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(family_id, client_id) DO UPDATE SET last_active_at = excluded.last_active_at`
          )
            .bind(familyId, clientId, now)
            .run();

          return jsonResponse({ ok: true, isNewFamily: false });
        }

        if (!allowCreate) {
          return errorResponse('family_not_found', 404);
        }

        // 새 가족 생성
        const statements = [
          env.DB.prepare(
            `INSERT INTO families (id, created_at, updated_at, last_client_id)
             VALUES (?1, ?2, ?2, ?3)`
          ).bind(familyId, now, clientId),
          env.DB.prepare(
            `INSERT INTO members (family_id, client_id, created_at, last_active_at)
             VALUES (?1, ?2, ?3, ?3)`
          ).bind(familyId, clientId, now),
        ];

        await env.DB.batch(statements);
        return jsonResponse({ ok: true, isNewFamily: true });
      }

      // 2. GET /api/family/token
      if (request.method === 'GET' && path === '/api/family/token') {
        const family = await env.DB.prepare('SELECT * FROM families WHERE id = ?')
          .bind(familyId)
          .first<FamilyRow>();

        if (!family) {
          return errorResponse('family_not_found', 404);
        }

        const changeToken = `${family.updated_at}:${family.last_client_id || ''}`;
        return jsonResponse({
          ok: true,
          changeToken,
          profileUpdatedAt: family.profile_updated_at || 0,
          deletionReadyAt: family.deletion_ready_at,
        });
      }

      // 3. GET /api/family/deletion-status
      if (request.method === 'GET' && path === '/api/family/deletion-status') {
        const family = await env.DB.prepare('SELECT * FROM families WHERE id = ?')
          .bind(familyId)
          .first<FamilyRow>();

        if (!family) {
          return errorResponse('family_not_found', 404);
        }

        const now = Date.now();
        const scheduled = family.deletion_ready_at !== null;
        const readyAt = family.deletion_ready_at || undefined;
        const canDeleteNow = scheduled && (family.deletion_ready_at! <= now);

        return jsonResponse({
          ok: true,
          scheduled,
          readyAt,
          canDeleteNow,
        });
      }

      // 4. POST /api/family/delete-schedule (1시간 냉각)
      if (request.method === 'POST' && path === '/api/family/delete-schedule') {
        const family = await env.DB.prepare('SELECT id FROM families WHERE id = ?')
          .bind(familyId)
          .first();

        if (!family) {
          return errorResponse('family_not_found', 404);
        }

        const now = Date.now();
        const readyAt = now + 60 * 60 * 1000; // 1시간 뒤

        await env.DB.prepare('UPDATE families SET deletion_ready_at = ? WHERE id = ?')
          .bind(readyAt, familyId)
          .run();

        return jsonResponse({ ok: true, readyAt });
      }

      // 5. POST /api/family/cancel-delete
      if (request.method === 'POST' && path === '/api/family/cancel-delete') {
        const family = await env.DB.prepare('SELECT id FROM families WHERE id = ?')
          .bind(familyId)
          .first();

        if (!family) {
          return errorResponse('family_not_found', 404);
        }

        await env.DB.prepare('UPDATE families SET deletion_ready_at = NULL WHERE id = ?')
          .bind(familyId)
          .run();

        return jsonResponse({ ok: true });
      }

      // 6. POST /api/family/delete (영구 삭제)
      if (request.method === 'POST' && path === '/api/family/delete') {
        const family = await env.DB.prepare('SELECT * FROM families WHERE id = ?')
          .bind(familyId)
          .first<FamilyRow>();

        if (!family) {
          return errorResponse('family_not_found', 404);
        }

        // 배치로 완전 삭제
        const statements = [
          env.DB.prepare('DELETE FROM logs WHERE family_id = ?').bind(familyId),
          env.DB.prepare('DELETE FROM members WHERE family_id = ?').bind(familyId),
          env.DB.prepare('DELETE FROM families WHERE id = ?').bind(familyId),
        ];

        await env.DB.batch(statements);
        return jsonResponse({ ok: true });
      }

      // 7. POST /api/family/sync (증분 푸시 & 풀)
      if (request.method === 'POST' && path === '/api/family/sync') {
        const body = (await request.json().catch(() => ({}))) as {
          lastSyncedAt?: number;
          pushLogs?: any[];
          pushProfile?: any;
          pushDeletedIds?: string[];
        };

        const family = await env.DB.prepare('SELECT * FROM families WHERE id = ?')
          .bind(familyId)
          .first<FamilyRow>();

        if (!family) {
          return errorResponse('family_not_found', 404);
        }

        const serverTime = Date.now();
        const lastSyncedAt = Number(body.lastSyncedAt) || 0;
        const pushLogs = Array.isArray(body.pushLogs) ? body.pushLogs : [];
        const pushDeletedIds = Array.isArray(body.pushDeletedIds) ? body.pushDeletedIds : [];
        const pushProfile = body.pushProfile || null;

        const writeStatements: D1PreparedStatement[] = [];
        let hasWrites = false;

        // 1) 로그 푸시 (LWW 조건부 삽입 / 묘비명 부활 방지)
        for (const log of pushLogs) {
          if (!log || typeof log.id !== 'string') continue;
          const clientUpdatedAt = Number(log.updatedAt || log.timestamp) || serverTime;
          const rawJson = JSON.stringify(log);

          writeStatements.push(
            env.DB.prepare(
              `INSERT INTO logs (family_id, log_id, client_updated_at, updated_at, deleted_at, raw_json)
               VALUES (?1, ?2, ?3, ?4, NULL, ?5)
               ON CONFLICT(family_id, log_id) DO UPDATE SET
                 client_updated_at = excluded.client_updated_at,
                 updated_at = excluded.updated_at,
                 raw_json = excluded.raw_json
               WHERE logs.deleted_at IS NULL 
                 AND excluded.client_updated_at >= logs.client_updated_at`
            ).bind(familyId, log.id, clientUpdatedAt, serverTime, rawJson)
          );
          hasWrites = true;
        }

        // 2) 삭제 표식 (Tombstone)
        for (const delId of pushDeletedIds) {
          if (typeof delId !== 'string') continue;
          writeStatements.push(
            env.DB.prepare(
              `UPDATE logs SET deleted_at = ?1, updated_at = ?1
               WHERE family_id = ?2 AND log_id = ?3`
            ).bind(serverTime, familyId, delId)
          );
          hasWrites = true;
        }

        // 3) 프로필 갱신
        let targetProfile = {
          name: family.shared_name || undefined,
          birthDate: family.shared_birth_date || undefined,
          birthWeight: family.shared_birth_weight || undefined,
          targetFormula: family.shared_target_formula !== null ? family.shared_target_formula : undefined,
          sharedUpdatedAt: family.profile_updated_at || 0,
        };

        if (pushProfile && typeof pushProfile.sharedUpdatedAt === 'number') {
          if (pushProfile.sharedUpdatedAt > (family.profile_updated_at || 0)) {
            const nextName = pushProfile.name ?? family.shared_name;
            const nextBirthDate = pushProfile.birthDate ?? family.shared_birth_date;
            const nextBirthWeight = pushProfile.birthWeight ?? family.shared_birth_weight;
            const nextTargetFormula = pushProfile.targetFormula ?? family.shared_target_formula;

            writeStatements.push(
              env.DB.prepare(
                `UPDATE families SET
                   shared_name = ?1,
                   shared_birth_date = ?2,
                   shared_birth_weight = ?3,
                   shared_target_formula = ?4,
                   profile_updated_at = ?5
                 WHERE id = ?6`
              ).bind(
                nextName ?? null,
                nextBirthDate ?? null,
                nextBirthWeight ?? null,
                nextTargetFormula !== undefined ? nextTargetFormula : null,
                pushProfile.sharedUpdatedAt,
                familyId
              )
            );

            targetProfile = {
              name: nextName || undefined,
              birthDate: nextBirthDate || undefined,
              birthWeight: nextBirthWeight || undefined,
              targetFormula: nextTargetFormula !== undefined ? nextTargetFormula : undefined,
              sharedUpdatedAt: pushProfile.sharedUpdatedAt,
            };
            hasWrites = true;
          }
        }

        // 4) 변경 발생 시 family updated_at 및 last_client_id 갱신
        if (hasWrites) {
          writeStatements.push(
            env.DB.prepare(
              `UPDATE families SET updated_at = ?1, last_client_id = ?2 WHERE id = ?3`
            ).bind(serverTime, clientId, familyId)
          );
          await env.DB.batch(writeStatements);
        }

        // 5) 증분 풀 (Pull)
        let queryStr = '';
        let queryParams: any[] = [];

        if (lastSyncedAt === 0) {
          // 전체 풀: 활성 로그만 조회
          queryStr = 'SELECT raw_json, deleted_at FROM logs WHERE family_id = ?1 AND deleted_at IS NULL ORDER BY client_updated_at ASC';
          queryParams = [familyId];
        } else {
          // 증분 풀: lastSyncedAt 이후 갱신된 행 조회
          queryStr = 'SELECT raw_json, deleted_at, log_id FROM logs WHERE family_id = ?1 AND updated_at > ?2 ORDER BY updated_at ASC';
          queryParams = [familyId, lastSyncedAt];
        }

        const pullResults = await env.DB.prepare(queryStr)
          .bind(...queryParams)
          .all<{ raw_json: string; deleted_at: number | null; log_id?: string }>();

        const remoteLogs: any[] = [];
        const remoteDeletedIds: string[] = [];

        for (const row of pullResults.results || []) {
          if (row.deleted_at !== null) {
            if (row.log_id) {
              remoteDeletedIds.push(row.log_id);
            } else {
              try {
                const parsed = JSON.parse(row.raw_json);
                if (parsed.id) remoteDeletedIds.push(parsed.id);
              } catch {}
            }
          } else {
            try {
              remoteLogs.push(JSON.parse(row.raw_json));
            } catch {}
          }
        }

        return jsonResponse({
          ok: true,
          serverTime,
          remoteLogs,
          remoteDeletedIds,
          remoteProfile: targetProfile,
        });
      }

      return errorResponse('not_found', 404);
    } catch (err: any) {
      return errorResponse(err?.message || 'internal_server_error', 500);
    }
  },
};
