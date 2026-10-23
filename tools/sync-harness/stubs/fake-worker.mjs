// In-memory Cloudflare Worker & D1 mock for sync-harness tests

export const state = {
  docs: new Map(),
  commits: [],
  reads: [],
  beforeRead: null,
  beforeTransaction: null,
  beforeCommit: null,
  offline: false,
};

const originalFetch = globalThis.fetch;

function makeJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

globalThis.fetch = async function fakeFetch(url, options = {}) {
  if (state.offline) {
    throw new TypeError('Network request failed');
  }

  const urlStr = String(url);
  const parsedUrl = new URL(urlStr);
  const pathname = parsedUrl.pathname;
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});

  const authHeader = headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+([a-zA-Z0-9_-]+)$/i);
  const syncKey = match ? match[1] : '';
  const familyPath = `families/${syncKey}`;
  const clientId = headers.get('X-Client-Id') || 'test-client';

  // 1. POST /api/family/connect
  if (pathname === '/api/family/connect' && method === 'POST') {
    const body = options.body ? JSON.parse(options.body) : {};
    const exists = state.docs.has(familyPath);

    if (exists) {
      return makeJsonResponse({ ok: true, isNewFamily: false });
    }

    if (!body.allowCreate) {
      return makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);
    }

    state.docs.set(familyPath, {
      id: syncKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pendingDeletionAt: null,
      profile: {},
    });
    state.commits.push([{ ref: { path: familyPath }, type: 'family_create' }]);
    return makeJsonResponse({ ok: true, isNewFamily: true });
  }

  // 2. GET /api/family/token
  if (pathname === '/api/family/token' && method === 'GET') {
    if (state.beforeRead) await state.beforeRead();
    const fam = state.docs.get(familyPath);
    if (!fam) {
      return makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);
    }
    const changeToken = `${fam.updatedAt}:${fam.lastClientId || ''}`;
    return makeJsonResponse({
      ok: true,
      changeToken,
      profileUpdatedAt: fam.profile?.sharedUpdatedAt || 0,
      deletionReadyAt: fam.pendingDeletionAt || null,
    });
  }

  // 3. POST /api/family/sync
  if (pathname === '/api/family/sync' && method === 'POST') {
    if (state.beforeRead) {
      const hook = state.beforeRead;
      state.beforeRead = null;
      await hook();
    }
    if (!state.docs.has(familyPath)) {
      return makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);
    }
    if (state.beforeTransaction) await state.beforeTransaction();

    const body = options.body ? JSON.parse(options.body) : {};
    const serverTime = Date.now();
    const lastSyncedAt = Number(body.lastSyncedAt) || 0;
    const pushLogs = Array.isArray(body.pushLogs) ? body.pushLogs : [];
    const pushDeletedIds = Array.isArray(body.pushDeletedIds) ? body.pushDeletedIds : [];
    const pushProfile = body.pushProfile || null;

    const writes = [];
    const supersededIds = [];

    // Push logs
    for (const log of pushLogs) {
      const docKey = `${familyPath}/logs/${log.id}`;
      const existing = state.docs.get(docKey);
      const clientUpdated = log.updatedAt || log.timestamp || serverTime;

      if (existing) {
        if (existing.deleted) {
          supersededIds.push(log.id);
          continue;
        }
        const existingClientUpdated = existing.payload?.updatedAt || existing.payload?.timestamp || existing.updatedAt || 0;
        if (existingClientUpdated > clientUpdated) {
          supersededIds.push(log.id);
          continue;
        }
      }
      writes.push({ ref: { path: docKey }, type: 'log', log });
    }

    // Push deletions
    for (const delId of pushDeletedIds) {
      const docKey = `${familyPath}/logs/${delId}`;
      writes.push({ ref: { path: docKey }, type: 'delete', id: delId });
    }

    // Push profile
    if (pushProfile && typeof pushProfile.sharedUpdatedAt === 'number') {
      const fam = state.docs.get(familyPath);
      if (pushProfile.sharedUpdatedAt > (fam?.profile?.sharedUpdatedAt || 0) || (fam?.profile?.sharedUpdatedAt || 0) === 0) {
        writes.push({ ref: { path: familyPath }, type: 'profile', profile: pushProfile });
      }
    }

    if (writes.length > 0) {
      writes.unshift({ ref: { path: familyPath }, type: 'family_update' });
    }

    if (state.beforeCommit) {
      await state.beforeCommit(writes);
    }

    // Apply writes
    if (writes.length > 0) {
      const fam = state.docs.get(familyPath) || {};
      fam.updatedAt = serverTime;
      fam.lastClientId = clientId;

      for (const w of writes) {
        if (w.type === 'log') {
          state.docs.set(w.ref.path, {
            payload: w.log,
            deleted: false,
            updatedAt: serverTime,
          });
        } else if (w.type === 'delete') {
          const existing = state.docs.get(w.ref.path) || {};
          state.docs.set(w.ref.path, {
            ...existing,
            deleted: true,
            updatedAt: serverTime,
          });
        } else if (w.type === 'profile') {
          fam.profile = { ...(fam.profile || {}), ...w.profile };
        }
      }
      state.docs.set(familyPath, fam);
      state.commits.push(writes);
    }

    // Pull logs
    const prefix = `${familyPath}/logs/`;
    const remoteLogs = [];
    const remoteDeletedIds = [];
    let readDocsCount = 0;

    for (const [key, doc] of state.docs.entries()) {
      if (!key.startsWith(prefix)) continue;
      const docUpdated = doc.updatedAt || 0;
      if (lastSyncedAt === 0) {
        readDocsCount++;
        if (doc.deleted) {
          remoteDeletedIds.push(doc.payload?.id || key.split('/').at(-1));
        } else if (doc.payload) {
          remoteLogs.push(doc.payload);
        }
      } else {
        if (docUpdated > lastSyncedAt) {
          readDocsCount++;
          if (doc.deleted) {
            remoteDeletedIds.push(doc.payload?.id || key.split('/').at(-1));
          } else if (doc.payload) {
            remoteLogs.push(doc.payload);
          }
        }
      }
    }

    // Ensure pushed logs that match server tombstones are marked as superseded
    for (const log of pushLogs) {
      if (remoteDeletedIds.includes(log.id) && !supersededIds.includes(log.id)) {
        supersededIds.push(log.id);
      }
    }

    state.reads.push({
      path: `${familyPath}/logs`,
      constraints: lastSyncedAt > 0 ? [{ field: 'updatedAt', op: '>', value: lastSyncedAt }] : [],
      count: readDocsCount,
    });

    return makeJsonResponse({
      ok: true,
      serverTime,
      remoteLogs,
      remoteDeletedIds,
      remoteProfile: state.docs.get(familyPath)?.profile || {},
      supersededIds,
    });
  }

  // 4. POST /api/family/delete-schedule
  if (pathname === '/api/family/delete-schedule' && method === 'POST') {
    if (!state.docs.has(familyPath)) {
      return makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);
    }
    const readyAt = Date.now() + 60 * 60 * 1000;
    const fam = state.docs.get(familyPath);
    fam.pendingDeletionAt = readyAt;
    state.docs.set(familyPath, fam);
    return makeJsonResponse({ ok: true, readyAt });
  }

  // 5. POST /api/family/cancel-delete
  if (pathname === '/api/family/cancel-delete' && method === 'POST') {
    if (!state.docs.has(familyPath)) {
      return makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);
    }
    const fam = state.docs.get(familyPath);
    fam.pendingDeletionAt = null;
    state.docs.set(familyPath, fam);
    return makeJsonResponse({ ok: true });
  }

  // 6. POST /api/family/delete (냉각 기간 검증 강제)
  if (pathname === '/api/family/delete' && method === 'POST') {
    if (!state.docs.has(familyPath)) {
      return makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);
    }
    const fam = state.docs.get(familyPath);
    const now = Date.now();
    if (!fam.pendingDeletionAt || fam.pendingDeletionAt > now) {
      return makeJsonResponse({ ok: false, error: 'cooling_period_active' }, 400);
    }
    for (const key of [...state.docs.keys()]) {
      if (key === familyPath || key.startsWith(`${familyPath}/`)) {
        state.docs.delete(key);
      }
    }
    return makeJsonResponse({ ok: true });
  }

  // 7. GET /api/family/deletion-status
  if (pathname === '/api/family/deletion-status' && method === 'GET') {
    if (!state.docs.has(familyPath)) {
      return makeJsonResponse({ ok: false, error: 'family_not_found' }, 404);
    }
    const fam = state.docs.get(familyPath);
    const scheduled = !!fam.pendingDeletionAt;
    const readyAt = fam.pendingDeletionAt || undefined;
    const canDeleteNow = scheduled && (readyAt <= Date.now());
    return makeJsonResponse({ ok: true, scheduled, readyAt, canDeleteNow });
  }

  return originalFetch.apply(this, arguments);
};
