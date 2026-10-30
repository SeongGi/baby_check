export interface Env {
  DB: D1Database;
  /** 시험 전용 서버 시계. 운영(wrangler.toml)에는 이 바인딩이 없어서 항상 Date.now()를 쓴다. */
  clock?: () => number;
  MAX_PUSH_ITEMS?: string;
  MAX_PAGE_ROWS?: string;
}

interface FamilyRow {
  id: string;
  created_at: number;
  updated_at: number;
  last_client_id: string | null;
  deletion_ready_at: number | null;
  shared_json: string | null;
  profile_updated_at: number;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Id',
};

const MAX_PAYLOAD_BYTES = 1_048_576; // 1MB (UTF-8 바이트)
const MAX_BATCH_ITEMS = 500;
const D1_BATCH_CHUNK_SIZE = 100; // 배치 하나의 문장 수 상한 (토큰 갱신 문장 포함)
const D1_MAX_BIND_PARAMS = 100;
const CLASSIFY_ID_CHUNK = D1_MAX_BIND_PARAMS - 1; // family_id 하나를 빼고 id 99개
const PULL_BYTE_BUDGET = 819_200; // 800KB
const CURSOR_MARGIN_MS = 120_000; // 2분
const MIN_PAGE_ROWS = 25;
const DEFAULT_MAX_PUSH_ITEMS = 400;
const DEFAULT_MAX_PAGE_ROWS = 500;

const textEncoder = new TextEncoder();

function now(env: Env): number {
  return env.clock ? env.clock() : Date.now();
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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

/**
 * canonical JSON: 키를 정렬하고 undefined 값을 뺀 JSON.stringify 결과.
 * 클라이언트 src/database/sync.ts의 canonical, storage.ts의 stableValue와 같은 알고리즘이다.
 * (서버는 앱 코드를 import하지 않으므로 여기에 그대로 옮겨 둔다.)
 */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((sorted, key) => {
            const field = (item as Record<string, unknown>)[key];
            if (field !== undefined) sorted[key] = field;
            return sorted;
          }, {})
      : item,
  );

async function sha256Hex(message: string): Promise<string> {
  const msgUint8 = textEncoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getAuthContext(request: Request): Promise<{ familyId: string; clientId: string } | null> {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+([a-zA-Z0-9_-]{16,64})$/i);
  if (!match) return null;

  const syncKey = match[1].toLowerCase();
  const familyId = await sha256Hex(`babycheck:family:v2:${syncKey}`);
  const rawClientId = request.headers.get('X-Client-Id')?.trim() || 'unknown-client';
  const clientId = rawClientId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown-client';

  return { familyId, clientId };
}

/**
 * 가족 행이 없을 때 모든 경로가 쓰는 공통 응답.
 * 삭제 기록이 있으면 410 family_deleted, 없으면 404 family_not_found.
 * 가족 읽기가 "없음"을 돌려준 경우에만 부른다.
 */
async function familyMissingResponse(env: Env, familyId: string): Promise<Response> {
  const deleted = await env.DB.prepare('SELECT 1 AS found FROM deleted_families WHERE id = ?1')
    .bind(familyId)
    .first<{ found: number }>();
  return deleted ? errorResponse('family_deleted', 410) : errorResponse('family_not_found', 404);
}

const changesOf = (result: D1Result | undefined): number => Number(result?.meta?.changes ?? 0);

/** 2.2의 둘째 문장: 가족이 있을 때만 회원을 넣거나 갱신한다. */
function memberUpsertStatement(env: Env, familyId: string, t: number, clientId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO members (family_id, client_id, created_at, last_active_at)
     SELECT ?1, ?3, ?2, ?2
     WHERE EXISTS (SELECT 1 FROM families WHERE id = ?1)
     ON CONFLICT(family_id, client_id) DO UPDATE SET last_active_at = excluded.last_active_at`,
  ).bind(familyId, t, clientId);
}

interface PushLog {
  id: string;
  clientUpdatedAt: number;
  raw: string;
}

interface WriteItem {
  isProfile: boolean;
  build: (t: number) => D1PreparedStatement;
}

interface ServerRow {
  log_id: string;
  client_updated_at?: number;
  updated_at?: number;
  deleted_at: number | null;
  raw_json: string;
}

const utf8Bytes = (text: string): number => textEncoder.encode(text).length;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const contentLength = Number(request.headers.get('content-length')) || 0;
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return errorResponse('payload_too_large', 413);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const auth = await getAuthContext(request);
    if (!auth) {
      return errorResponse('invalid_or_missing_sync_key', 401);
    }
    const { familyId, clientId } = auth;

    try {
      // content-length 헤더가 없을 수 있으므로 본문을 읽은 뒤 UTF-8 바이트 수로도 검사한다.
      let body: any = {};
      if (request.method === 'POST') {
        const text = await request.text();
        if (utf8Bytes(text) > MAX_PAYLOAD_BYTES) {
          return errorResponse('payload_too_large', 413);
        }
        try {
          const parsed = JSON.parse(text);
          body = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          body = {};
        }
      }

      // 1. POST /api/family/connect
      if (request.method === 'POST' && path === '/api/family/connect') {
        const allowCreate = Boolean(body.allowCreate);
        const t = now(env);

        const family = await env.DB.prepare('SELECT id FROM families WHERE id = ?1')
          .bind(familyId)
          .first<{ id: string }>();

        if (family) {
          const result = await memberUpsertStatement(env, familyId, t, clientId).run();
          if (changesOf(result) === 0) {
            return familyMissingResponse(env, familyId);
          }
          return jsonResponse({ ok: true, isNewFamily: false });
        }

        if (!allowCreate) {
          return familyMissingResponse(env, familyId);
        }

        // 새 가족 생성: deleted_families를 미리 읽지 않고, 삭제 기록 판정은 첫 문장의 WHERE NOT EXISTS 한 곳에서만 한다.
        const results = await env.DB.batch([
          env.DB.prepare(
            `INSERT OR IGNORE INTO families (id, created_at, updated_at, last_client_id)
             SELECT ?1, ?2, ?2, ?3
             WHERE NOT EXISTS (SELECT 1 FROM deleted_families WHERE id = ?1)`,
          ).bind(familyId, t, clientId),
          memberUpsertStatement(env, familyId, t, clientId),
        ]);

        if (changesOf(results[1]) === 0) {
          return familyMissingResponse(env, familyId);
        }
        return jsonResponse({ ok: true, isNewFamily: changesOf(results[0]) === 1 });
      }

      // 2. GET /api/family/token
      if (request.method === 'GET' && path === '/api/family/token') {
        const family = await env.DB.prepare(
          'SELECT updated_at, last_client_id, profile_updated_at, deletion_ready_at FROM families WHERE id = ?1',
        )
          .bind(familyId)
          .first<FamilyRow>();

        if (!family) {
          return familyMissingResponse(env, familyId);
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
        const family = await env.DB.prepare('SELECT deletion_ready_at FROM families WHERE id = ?1')
          .bind(familyId)
          .first<FamilyRow>();

        if (!family) {
          return familyMissingResponse(env, familyId);
        }

        const t = now(env);
        const scheduled = family.deletion_ready_at !== null;
        const readyAt = family.deletion_ready_at || undefined;
        const canDeleteNow = scheduled && family.deletion_ready_at! <= t;

        return jsonResponse({
          ok: true,
          scheduled,
          readyAt,
          canDeleteNow,
        });
      }

      // 4. POST /api/family/delete-schedule (1시간 냉각)
      if (request.method === 'POST' && path === '/api/family/delete-schedule') {
        const family = await env.DB.prepare('SELECT id FROM families WHERE id = ?1')
          .bind(familyId)
          .first();

        if (!family) {
          return familyMissingResponse(env, familyId);
        }

        const readyAt = now(env) + 60 * 60 * 1000; // 1시간 뒤

        await env.DB.prepare('UPDATE families SET deletion_ready_at = ?1 WHERE id = ?2')
          .bind(readyAt, familyId)
          .run();

        return jsonResponse({ ok: true, readyAt });
      }

      // 5. POST /api/family/cancel-delete
      if (request.method === 'POST' && path === '/api/family/cancel-delete') {
        const family = await env.DB.prepare('SELECT id FROM families WHERE id = ?1')
          .bind(familyId)
          .first();

        if (!family) {
          return familyMissingResponse(env, familyId);
        }

        await env.DB.prepare('UPDATE families SET deletion_ready_at = NULL WHERE id = ?1')
          .bind(familyId)
          .run();

        return jsonResponse({ ok: true });
      }

      // 6. POST /api/family/delete (영구 삭제: 냉각 기간 검증 강제)
      if (request.method === 'POST' && path === '/api/family/delete') {
        const family = await env.DB.prepare('SELECT deletion_ready_at FROM families WHERE id = ?1')
          .bind(familyId)
          .first<FamilyRow>();

        if (!family) {
          return familyMissingResponse(env, familyId);
        }

        const t = now(env);
        if (!family.deletion_ready_at || family.deletion_ready_at > t) {
          return errorResponse('cooling_period_active', 400);
        }

        // 배치로 완전 삭제. 삭제 기록을 맨 앞에 넣어 같은 배치로 함께 확정한다.
        // 위의 확인과 배치 사이에 삭제 취소가 끼어들 수 있으므로, 냉각 기간 조건을 첫 문장에서 다시 확인하고
        // 나머지 문장은 이 배치가 삭제 기록을 남겼을 때만 지운다.
        const deleteGuard = 'EXISTS (SELECT 1 FROM deleted_families WHERE id = ?1 AND deleted_at = ?2)';
        const results = await env.DB.batch([
          env.DB.prepare(
            `INSERT OR IGNORE INTO deleted_families (id, deleted_at)
             SELECT ?1, ?2
             WHERE EXISTS (SELECT 1 FROM families
                           WHERE id = ?1 AND deletion_ready_at IS NOT NULL AND deletion_ready_at <= ?2)`,
          ).bind(familyId, t),
          env.DB.prepare(`DELETE FROM logs WHERE family_id = ?1 AND ${deleteGuard}`).bind(familyId, t),
          env.DB.prepare(`DELETE FROM members WHERE family_id = ?1 AND ${deleteGuard}`).bind(familyId, t),
          env.DB.prepare(`DELETE FROM families WHERE id = ?1 AND ${deleteGuard}`).bind(familyId, t),
        ]);

        if (changesOf(results[0]) === 0) {
          return errorResponse('cooling_period_active', 400);
        }
        return jsonResponse({ ok: true });
      }

      // 7. POST /api/family/sync (올리기 + 선택적 당겨 받기)
      if (request.method === 'POST' && path === '/api/family/sync') {
        const maxPushItems = positiveIntOr(env.MAX_PUSH_ITEMS, DEFAULT_MAX_PUSH_ITEMS);
        const maxPageRows = positiveIntOr(env.MAX_PAGE_ROWS, DEFAULT_MAX_PAGE_ROWS);

        const rawPushLogs: any[] = Array.isArray(body.pushLogs) ? body.pushLogs : [];
        const rawPushDeletedIds: any[] = Array.isArray(body.pushDeletedIds) ? body.pushDeletedIds : [];

        if (rawPushLogs.length + rawPushDeletedIds.length > MAX_BATCH_ITEMS) {
          return errorResponse('batch_size_exceeded', 413);
        }

        const family = await env.DB.prepare('SELECT id FROM families WHERE id = ?1')
          .bind(familyId)
          .first<{ id: string }>();

        if (!family) {
          return familyMissingResponse(env, familyId);
        }

        const pushLogs: PushLog[] = [];
        for (const log of rawPushLogs) {
          if (!log || typeof log !== 'object' || typeof log.id !== 'string') continue;
          let clientUpdatedAt = Number(log.updatedAt || log.timestamp);
          if (!Number.isFinite(clientUpdatedAt)) clientUpdatedAt = 0;
          pushLogs.push({ id: log.id, clientUpdatedAt, raw: canonicalJson(log) });
        }
        const pushDeletedIds = Array.from(
          new Set(rawPushDeletedIds.filter((id): id is string => typeof id === 'string')),
        );

        // 아기 정보: 공유 항목 4개가 모두 있고 형식이 맞을 때만 쓴다.
        const pushProfile = body.pushProfile;
        let profileJson: string | null = null;
        let profileTs = 0;
        let profileRejected = false;
        if (pushProfile !== undefined && pushProfile !== null) {
          const complete =
            typeof pushProfile === 'object' &&
            typeof pushProfile.name === 'string' &&
            typeof pushProfile.birthDate === 'string' &&
            typeof pushProfile.birthWeight === 'string' &&
            typeof pushProfile.targetFormula === 'number' &&
            Number.isFinite(pushProfile.targetFormula) &&
            typeof pushProfile.sharedUpdatedAt === 'number' &&
            Number.isFinite(pushProfile.sharedUpdatedAt);
          if (complete) {
            profileJson = canonicalJson({
              name: pushProfile.name,
              birthDate: pushProfile.birthDate,
              birthWeight: pushProfile.birthWeight,
              targetFormula: pushProfile.targetFormula,
            });
            profileTs = pushProfile.sharedUpdatedAt;
          } else {
            profileRejected = true;
          }
        }

        // 쓰기 항목: 아기 정보(첫 배치), 기록, 삭제 표식 순서. 시각은 배치마다 찍는다.
        const items: WriteItem[] = [];
        if (profileJson !== null) {
          const j = profileJson;
          const ts = profileTs;
          items.push({
            isProfile: true,
            build: t =>
              env.DB.prepare(
                `UPDATE families SET shared_json = ?1, profile_updated_at = ?2,
                   updated_at = ?3, last_client_id = ?4
                 WHERE id = ?5
                   AND (profile_updated_at < ?2
                     OR (profile_updated_at = ?2 AND COALESCE(shared_json, '') < ?1))`,
              ).bind(j, ts, t, clientId, familyId),
          });
        }
        for (const log of pushLogs) {
          items.push({
            isProfile: false,
            build: t =>
              env.DB.prepare(
                `INSERT INTO logs (family_id, log_id, client_updated_at, updated_at, deleted_at, raw_json)
                 SELECT ?1, ?2, ?3, ?4, NULL, ?5
                 WHERE EXISTS (SELECT 1 FROM families WHERE id = ?1)
                 ON CONFLICT(family_id, log_id) DO UPDATE SET
                   client_updated_at = excluded.client_updated_at,
                   updated_at = excluded.updated_at,
                   raw_json = excluded.raw_json
                 WHERE logs.deleted_at IS NULL
                   AND (excluded.client_updated_at > logs.client_updated_at
                     OR (excluded.client_updated_at = logs.client_updated_at
                         AND excluded.raw_json > logs.raw_json))`,
              ).bind(familyId, log.id, log.clientUpdatedAt, t, log.raw),
          });
        }
        for (const delId of pushDeletedIds) {
          items.push({
            isProfile: false,
            build: t =>
              env.DB.prepare(
                `INSERT INTO logs (family_id, log_id, client_updated_at, updated_at, deleted_at, raw_json)
                 SELECT ?1, ?2, 0, ?3, ?3, ?4
                 WHERE EXISTS (SELECT 1 FROM families WHERE id = ?1)
                 ON CONFLICT(family_id, log_id) DO UPDATE SET
                   deleted_at = excluded.deleted_at, updated_at = excluded.updated_at
                 WHERE logs.deleted_at IS NULL`,
              ).bind(familyId, delId, t, canonicalJson({ deleted: true, id: delId })),
          });
        }

        // 쓰기 배치(100문장 이하): 배치마다 새 시각을 찍고, 행이 있으면 마지막 문장으로 조건부 토큰 갱신.
        const chunkSize = D1_BATCH_CHUNK_SIZE - 1;
        for (let i = 0; i < items.length; i += chunkSize) {
          const chunk = items.slice(i, i + chunkSize);
          const t = now(env);
          const statements = chunk.map(item => item.build(t));
          if (chunk.some(item => !item.isProfile)) {
            statements.push(
              env.DB.prepare(
                `UPDATE families SET updated_at = ?1, last_client_id = ?2
                 WHERE id = ?3
                   AND EXISTS (SELECT 1 FROM logs WHERE family_id = ?3 AND updated_at = ?1)`,
              ).bind(t, clientId, familyId),
            );
          }
          await env.DB.batch(statements);
        }

        // 읽기 배치 하나: 아기 정보, 올리기 분류(id 99개씩 IN), 당겨 받기 페이지(요청했을 때만).
        const reads: D1PreparedStatement[] = [
          env.DB.prepare('SELECT shared_json, profile_updated_at FROM families WHERE id = ?1').bind(familyId),
        ];
        const classifyIds = Array.from(new Set(pushLogs.map(log => log.id)));
        const classifyStatementCount = Math.ceil(classifyIds.length / CLASSIFY_ID_CHUNK);
        for (let i = 0; i < classifyIds.length; i += CLASSIFY_ID_CHUNK) {
          const ids = classifyIds.slice(i, i + CLASSIFY_ID_CHUNK);
          const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(',');
          reads.push(
            env.DB.prepare(
              `SELECT log_id, client_updated_at, deleted_at, raw_json FROM logs
               WHERE family_id = ?1 AND log_id IN (${placeholders})`,
            ).bind(familyId, ...ids),
          );
        }

        const pullRequest = body.pull && typeof body.pull === 'object' ? body.pull : null;
        let pullLimit = 0;
        let pullAfterUpdatedAt = 0;
        let pullAfterLogId = '';
        let cursorCandidate: number | undefined;
        if (pullRequest) {
          const requestedLimit = Number(pullRequest.limit);
          pullLimit = Math.floor(
            Math.min(maxPageRows, Math.max(MIN_PAGE_ROWS, Number.isFinite(requestedLimit) ? requestedLimit : maxPageRows)),
          );
          const afterUpdatedAt = Number(pullRequest.afterUpdatedAt);
          pullAfterUpdatedAt = Number.isFinite(afterUpdatedAt) ? afterUpdatedAt : 0;
          pullAfterLogId = typeof pullRequest.afterLogId === 'string' ? pullRequest.afterLogId : '';
          cursorCandidate = now(env) - CURSOR_MARGIN_MS;
          reads.push(
            env.DB.prepare(
              `SELECT log_id, updated_at, deleted_at, raw_json FROM logs
               WHERE family_id = ?1 AND (updated_at, log_id) > (?2, ?3)
               ORDER BY updated_at, log_id
               LIMIT ?4`,
            ).bind(familyId, pullAfterUpdatedAt, pullAfterLogId, pullLimit + 1),
          );
        }

        const readResults = await env.DB.batch(reads);

        const profileRow = (readResults[0].results?.[0] ?? null) as Pick<FamilyRow, 'shared_json' | 'profile_updated_at'> | null;
        if (!profileRow) {
          // 읽기 전에 영구 삭제가 확정된 경우
          return familyMissingResponse(env, familyId);
        }

        // 올리기 분류
        const serverRows = new Map<string, ServerRow>();
        for (let i = 0; i < classifyStatementCount; i += 1) {
          for (const row of (readResults[1 + i].results ?? []) as ServerRow[]) {
            serverRows.set(row.log_id, row);
          }
        }
        const acceptedIds: string[] = [];
        const remoteDeletedIds: string[] = [];
        const remoteDeletedSet = new Set<string>();
        const remoteRawParts: string[] = [];
        const remoteLogIdSet = new Set<string>();
        for (const log of pushLogs) {
          const row = serverRows.get(log.id);
          if (!row) continue;
          if (row.deleted_at !== null) {
            if (!remoteDeletedSet.has(log.id)) {
              remoteDeletedSet.add(log.id);
              remoteDeletedIds.push(log.id);
            }
          } else if (row.raw_json === log.raw) {
            acceptedIds.push(log.id);
          } else if (!remoteLogIdSet.has(log.id)) {
            remoteLogIdSet.add(log.id);
            remoteRawParts.push(row.raw_json);
          }
        }

        // 당겨 받기 페이지
        let hasMore: boolean | undefined;
        let nextAfter: { updatedAt: number; logId: string } | undefined;
        if (pullRequest) {
          const pageRows = (readResults[readResults.length - 1].results ?? []) as ServerRow[];
          let rows = pageRows;
          let more = false;
          if (rows.length > pullLimit) {
            rows = rows.slice(0, pullLimit);
            more = true;
          }
          let bytes = 0;
          let included = rows.length;
          for (let i = 0; i < rows.length; i += 1) {
            bytes += utf8Bytes(rows[i].raw_json);
            if (bytes >= PULL_BYTE_BUDGET) {
              included = i + 1;
              if (included < rows.length) more = true;
              break;
            }
          }
          rows = rows.slice(0, included);
          for (const row of rows) {
            if (row.deleted_at !== null) {
              if (!remoteDeletedSet.has(row.log_id)) {
                remoteDeletedSet.add(row.log_id);
                remoteDeletedIds.push(row.log_id);
              }
            } else if (!remoteLogIdSet.has(row.log_id)) {
              remoteLogIdSet.add(row.log_id);
              remoteRawParts.push(row.raw_json);
            }
          }
          hasMore = more;
          const last = rows[rows.length - 1];
          nextAfter = last
            ? { updatedAt: Number(last.updated_at), logId: last.log_id }
            : { updatedAt: pullAfterUpdatedAt, logId: pullAfterLogId };
        }

        let remoteProfile: Record<string, unknown> | undefined;
        if (profileRow.shared_json !== null) {
          remoteProfile = {
            ...(JSON.parse(profileRow.shared_json) as Record<string, unknown>),
            sharedUpdatedAt: profileRow.profile_updated_at,
          };
        }

        const head = JSON.stringify({
          ok: true,
          serverTime: now(env),
          acceptedIds,
          remoteDeletedIds,
          remoteProfile,
          profileRejected: profileRejected ? true : undefined,
          hasMore,
          nextAfter,
          cursorCandidate,
          maxPushItems,
          maxPageRows,
        });
        // raw_json은 파싱하지 않고 저장된 canonical JSON 문자열을 그대로 이어 붙인다.
        const responseBody = `${head.slice(0, -1)},"remoteLogs":[${remoteRawParts.join(',')}]}`;
        return new Response(responseBody, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...CORS_HEADERS,
          },
        });
      }

      return errorResponse('not_found', 404);
    } catch (err: any) {
      // D1 오류 문구에는 SQL 일부가 들어 있으므로 응답에는 싣지 않고 로그에만 남긴다.
      console.error('Unhandled server error', err);
      return errorResponse('internal_server_error', 500);
    }
  },
};
