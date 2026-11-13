// 상대 기기 기록 알림의 설정 저장과 reconcilePartnerPush 단위 시험입니다.
// 가짜 의존성이 호출 횟수와 순서를 세며, 실제 expo 모듈이나 네트워크는 쓰지 않습니다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PARTNER_PUSH_REGISTERED_KEY,
  PARTNER_PUSH_SETTINGS_KEY,
  PARTNER_PUSH_UNREGISTER_PENDING_KEY,
  PARTNER_PUSH_TYPES,
  PARTNER_PUSH_DEFAULT_QUIET,
  formatMinuteOfDay,
  stepQuietTime,
  loadPartnerPushSettings,
  reconcilePartnerPush,
  savePartnerPushSettings,
} from '../src/utils/partnerPush.ts';

const sha = text => createHash('sha256').update(text).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));

const makeDeps = (overrides = {}) => {
  const store = new Map();
  const calls = [];
  const state = { permission: 'granted', tokenData: 'ExponentPushToken[aaa]', registerError: null, unregisterError: null };
  const deps = {
    storage: {
      getItem: async key => (store.has(key) ? store.get(key) : null),
      setItem: async (key, value) => void store.set(key, value),
      removeItem: async key => void store.delete(key),
    },
    getPermissionsAsync: async () => {
      calls.push({ name: 'permission' });
      return { status: state.permission };
    },
    setNotificationChannelAsync: async (id, spec) => {
      calls.push({ name: 'channel', id, spec });
      return null;
    },
    getExpoPushTokenAsync: async options => {
      calls.push({ name: 'token', options });
      if (state.tokenData instanceof Error) throw state.tokenData;
      return { data: state.tokenData };
    },
    sha256Hex: async text => sha(text),
    registerPushDevice: async (syncKey, clientId, body) => {
      calls.push({ name: 'register', syncKey, clientId, body });
      if (state.registerError) throw state.registerError;
      return { ok: true };
    },
    unregisterPushDevice: async (syncKey, clientId, options) => {
      calls.push({ name: 'unregister', syncKey, clientId, options });
      if (state.unregisterError) throw state.unregisterError;
      return { ok: true };
    },
    platformOS: 'android',
    getTimezoneOffset: () => -540,
    projectId: 'project-1',
    ...overrides,
  };
  const count = name => calls.filter(call => call.name === name).length;
  const names = () => calls.map(call => call.name);
  return { deps, store, calls, state, count, names };
};

const settings = (extra = {}) => ({ enabled: true, types: [...PARTNER_PUSH_TYPES], quiet: null, ...extra });
const args = (extra = {}) => ({ syncKey: 'key-A', clientId: 'client-1', settings: settings(), ...extra });
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });
const readRecord = store => JSON.parse(store.get(PARTNER_PUSH_REGISTERED_KEY));
const readPending = store =>
  store.has(PARTNER_PUSH_UNREGISTER_PENDING_KEY) ? JSON.parse(store.get(PARTNER_PUSH_UNREGISTER_PENDING_KEY)) : [];
const neverResolves = () => new Promise(() => {});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('혼자 쓰는 기기(가족 키 없음)는 푸시 관련 호출이 0회다', async () => {
  for (const syncKey of [undefined, null, '']) {
    const h = makeDeps();
    const status = await reconcilePartnerPush(args({ syncKey }), h.deps);
    assert.equal(status, 'no_family');
    assert.equal(h.calls.length, 0, `syncKey=${JSON.stringify(syncKey)}에서 호출 ${h.names()}`);
  }
});

test('다른 가족으로 옮기면 저장된 옛 값으로 해제한 뒤 새 가족으로 등록한다', async () => {
  const h = makeDeps();
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'registered');
  h.calls.length = 0;
  assert.equal(await reconcilePartnerPush(args({ syncKey: 'key-B', clientId: 'client-2' }), h.deps), 'registered');
  const unregister = h.calls.find(call => call.name === 'unregister');
  assert.equal(unregister.syncKey, 'key-A');
  assert.equal(unregister.clientId, 'client-1');
  const register = h.calls.find(call => call.name === 'register');
  assert.equal(register.syncKey, 'key-B');
  assert.equal(register.clientId, 'client-2');
  assert.ok(h.names().indexOf('unregister') < h.names().indexOf('register'));
  assert.equal(readRecord(h.store).syncKey, 'key-B');
});

test('동기화가 가족 키를 지운 뒤(410)에는 저장된 값으로 해제하고 기록을 지운다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  h.calls.length = 0;
  const status = await reconcilePartnerPush(args({ syncKey: '' }), h.deps);
  assert.equal(status, 'no_family');
  assert.deepEqual(h.names(), ['unregister']);
  assert.equal(h.calls[0].syncKey, 'key-A');
  assert.equal(h.calls[0].clientId, 'client-1');
  assert.equal(h.calls[0].options.timeoutMs, 2000);
  assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
});

test('해제 요청이 실패하면 기록은 지우고 대기 목록에 넣는다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  h.state.unregisterError = new Error('timeout');
  await reconcilePartnerPush(args({ syncKey: '' }), h.deps);
  assert.equal(h.count('unregister'), 1);
  assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
  assert.deepEqual(readPending(h.store), [{ syncKey: 'key-A', clientId: 'client-1' }]);
});

test('대기 중인 해제는 다음 reconcile(가족 키가 없어도)에서 다시 보내고 성공하면 목록에서 뺀다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  h.state.unregisterError = new Error('offline');
  await reconcilePartnerPush(args({ syncKey: '' }), h.deps);
  h.state.unregisterError = null;
  h.calls.length = 0;
  assert.equal(await reconcilePartnerPush(args({ syncKey: '', clientId: '' }), h.deps), 'no_family');
  assert.deepEqual(h.names(), ['unregister']);
  assert.equal(h.calls[0].syncKey, 'key-A');
  assert.equal(h.calls[0].clientId, 'client-1');
  assert.equal(h.calls[0].options.timeoutMs, 2000);
  assert.deepEqual(readPending(h.store), []);
  assert.equal(h.store.has(PARTNER_PUSH_UNREGISTER_PENDING_KEY), false);
  h.calls.length = 0;
  await reconcilePartnerPush(args({ syncKey: '' }), h.deps);
  assert.equal(h.calls.length, 0, '목록이 비면 더 보내지 않는다');
});

test('대기 중인 해제는 404와 410이면 목록에서 빼고 500과 시간 초과면 남긴다', async () => {
  const cases = [
    { error: httpError(404), kept: false },
    { error: httpError(410), kept: false },
    { error: httpError(500), kept: true },
    { error: Object.assign(new Error('시간 초과'), { isTimeout: true }), kept: true },
  ];
  for (const { error, kept } of cases) {
    const h = makeDeps();
    await reconcilePartnerPush(args(), h.deps);
    h.state.unregisterError = new Error('offline');
    await reconcilePartnerPush(args({ syncKey: '' }), h.deps);
    h.state.unregisterError = error;
    await reconcilePartnerPush(args({ syncKey: '' }), h.deps);
    assert.equal(h.count('unregister'), 2);
    assert.equal(readPending(h.store).length, kept ? 1 : 0, `error=${error.message}`);
  }
});

test('해제 요청이 처음부터 404나 410이면 대기 목록에 넣지 않는다', async () => {
  for (const code of [404, 410]) {
    const h = makeDeps();
    await reconcilePartnerPush(args(), h.deps);
    h.state.unregisterError = httpError(code);
    await reconcilePartnerPush(args({ syncKey: '' }), h.deps);
    assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
    assert.deepEqual(readPending(h.store), []);
  }
});

test('오프라인에서 끈 뒤 다시 온라인이 되면 옛 값으로 해제가 결국 전달된다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  h.state.unregisterError = new TypeError('Network request failed');
  assert.equal(await reconcilePartnerPush(args({ settings: settings({ enabled: false }) }), h.deps), 'disabled');
  assert.equal(readPending(h.store).length, 1);
  h.state.unregisterError = null;
  h.calls.length = 0;
  assert.equal(await reconcilePartnerPush(args({ syncKey: 'key-B', clientId: 'client-2', settings: settings({ enabled: false }) }), h.deps), 'disabled');
  const unregisters = h.calls.filter(call => call.name === 'unregister');
  assert.equal(unregisters.length, 1);
  assert.equal(unregisters[0].syncKey, 'key-A');
  assert.equal(unregisters[0].clientId, 'client-1');
  assert.deepEqual(readPending(h.store), []);
});

test('대기 중인 (K,c)를 같은 값으로 다시 켜면 등록 성공 뒤 목록에서 빠지고 이후 해제를 보내지 않는다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  h.state.unregisterError = new Error('offline');
  await reconcilePartnerPush(args({ settings: settings({ enabled: false }) }), h.deps);
  assert.deepEqual(readPending(h.store), [{ syncKey: 'key-A', clientId: 'client-1' }]);
  // 다시 켤 때도 해제 재시도는 실패하지만 등록은 성공한다.
  h.calls.length = 0;
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'registered');
  assert.ok(h.names().indexOf('unregister') < h.names().indexOf('register'), '재시도는 등록보다 먼저 한다');
  assert.deepEqual(readPending(h.store), []);
  h.state.unregisterError = null;
  h.calls.length = 0;
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'unchanged');
  await reconcilePartnerPush(args({ settings: settings({ types: ['formula'] }) }), h.deps);
  assert.equal(h.count('unregister'), 0);
});

test('해제 대기 목록은 같은 쌍을 합치고 최대 5개까지만 둔다', async () => {
  const h = makeDeps();
  h.state.unregisterError = new Error('offline');
  for (let i = 1; i <= 7; i += 1) {
    await reconcilePartnerPush(args({ syncKey: `key-${i}`, clientId: `client-${i}` }), h.deps);
    await reconcilePartnerPush(args({ syncKey: `key-${i}`, clientId: `client-${i}`, settings: settings({ enabled: false }) }), h.deps);
  }
  const pending = readPending(h.store);
  assert.deepEqual(pending.map(item => item.syncKey), ['key-3', 'key-4', 'key-5', 'key-6', 'key-7']);

  // 같은 쌍이 다시 실패해도 중복되지 않는다.
  await reconcilePartnerPush(args({ syncKey: 'key-7', clientId: 'client-7' }), h.deps);
  await reconcilePartnerPush(args({ syncKey: 'key-7', clientId: 'client-7', settings: settings({ enabled: false }) }), h.deps);
  assert.equal(readPending(h.store).filter(item => item.syncKey === 'key-7').length, 1);
  assert.equal(readPending(h.store).length, 5);
});

test('권한이 거부되면 등록하지 않고, 기록이 있었다면 해제한다', async () => {
  const h = makeDeps();
  h.state.permission = 'denied';
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'permission_denied');
  assert.equal(h.count('register'), 0);
  assert.equal(h.count('unregister'), 0);
  assert.equal(h.count('token'), 0);

  h.state.permission = 'granted';
  await reconcilePartnerPush(args(), h.deps);
  assert.ok(h.store.has(PARTNER_PUSH_REGISTERED_KEY));
  h.state.permission = 'denied';
  h.calls.length = 0;
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'permission_denied');
  assert.equal(h.count('register'), 0);
  assert.equal(h.count('unregister'), 1);
  assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
});

test('설정을 끄면 기록이 있을 때만 해제한다', async () => {
  const h = makeDeps();
  assert.equal(await reconcilePartnerPush(args({ settings: settings({ enabled: false }) }), h.deps), 'disabled');
  assert.equal(h.calls.length, 0);
  await reconcilePartnerPush(args(), h.deps);
  h.calls.length = 0;
  assert.equal(await reconcilePartnerPush(args({ settings: settings({ types: [] }) }), h.deps), 'disabled');
  assert.deepEqual(h.names(), ['unregister']);
  assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
});

test('지문이 같으면 다시 보내지 않고, 설정이 바뀌면 다시 보낸다', async () => {
  const h = makeDeps();
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'registered');
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'unchanged');
  assert.equal(h.count('register'), 1);
  assert.equal(
    await reconcilePartnerPush(args({ settings: settings({ types: ['formula', 'sleep'] }) }), h.deps),
    'registered'
  );
  assert.equal(h.count('register'), 2);
  assert.equal(
    await reconcilePartnerPush(args({ settings: settings({ types: ['formula', 'sleep'], quiet: { start: 1380, end: 360 } }) }), h.deps),
    'registered'
  );
  assert.equal(h.count('register'), 3);
  const body = h.calls.filter(call => call.name === 'register')[2].body;
  assert.deepEqual(body.types, ['formula', 'sleep']);
  assert.equal(body.quietStart, 1380);
  assert.equal(body.quietEnd, 360);
  // 토큰이 바뀌어도 다시 보낸다.
  h.state.tokenData = 'ExponentPushToken[bbb]';
  assert.equal(
    await reconcilePartnerPush(args({ settings: settings({ types: ['formula', 'sleep'], quiet: { start: 1380, end: 360 } }) }), h.deps),
    'registered'
  );
  assert.equal(h.count('register'), 4);
});

test('처음 상태는 권한을 따르고 두 번째 읽기에서는 다시 정하지 않는다', async () => {
  const granted = makeDeps();
  const first = await loadPartnerPushSettings(granted.deps);
  assert.deepEqual(first, { enabled: true, types: [...PARTNER_PUSH_TYPES], quiet: null });
  assert.equal(granted.count('permission'), 1);
  granted.state.permission = 'denied';
  const second = await loadPartnerPushSettings(granted.deps);
  assert.equal(second.enabled, true);
  assert.equal(granted.count('permission'), 1);

  const denied = makeDeps();
  denied.state.permission = 'denied';
  assert.equal((await loadPartnerPushSettings(denied.deps)).enabled, false);
  denied.state.permission = 'granted';
  assert.equal((await loadPartnerPushSettings(denied.deps)).enabled, false);
  assert.equal(denied.count('permission'), 1);
  // 권한 요청 창은 쓰지 않는다: 가짜 deps에는 요청 함수 자체가 없다.
  assert.equal(denied.deps.requestPermissionsAsync, undefined);
});

test('저장된 설정은 걸러서 읽고, 깨진 값은 저장된 값 없음으로 본다', async () => {
  const h = makeDeps();
  h.store.set(
    PARTNER_PUSH_SETTINGS_KEY,
    JSON.stringify({ enabled: false, types: ['sleep', 'bogus', 'formula', 'sleep'], quiet: { start: 5, end: 5 } })
  );
  assert.deepEqual(await loadPartnerPushSettings(h.deps), { enabled: false, types: ['formula', 'sleep'], quiet: null });
  assert.equal(h.count('permission'), 0);

  h.store.set(PARTNER_PUSH_SETTINGS_KEY, JSON.stringify({ enabled: true, quiet: { start: -1, end: 2000 } }));
  const loaded = await loadPartnerPushSettings(h.deps);
  assert.deepEqual(loaded.types, PARTNER_PUSH_TYPES);
  assert.equal(loaded.quiet, null);

  const corrupt = makeDeps();
  corrupt.store.set(PARTNER_PUSH_SETTINGS_KEY, '{not json');
  assert.equal((await loadPartnerPushSettings(corrupt.deps)).enabled, true);
  assert.equal(corrupt.count('permission'), 1);
  assert.equal(JSON.parse(corrupt.store.get(PARTNER_PUSH_SETTINGS_KEY)).enabled, true);

  const saved = makeDeps();
  await savePartnerPushSettings(saved.deps, { enabled: true, types: ['play', 'urine'], quiet: { start: 60, end: 120 } });
  assert.deepEqual(JSON.parse(saved.store.get(PARTNER_PUSH_SETTINGS_KEY)), {
    enabled: true,
    types: ['urine', 'play'],
    quiet: { start: 60, end: 120 },
  });
});

test('403은 기록을 지우고 다음 호출에서 다시 시도하지 않는다', async () => {
  const h = makeDeps();
  h.state.registerError = httpError(403);
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'rejected');
  assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
  assert.equal(h.count('register'), 1);
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'rejected');
  assert.equal(h.count('register'), 1);
  assert.equal(h.count('unregister'), 0);
  // 설정이 바뀌면 다시 시도한다.
  h.state.registerError = null;
  assert.equal(await reconcilePartnerPush(args({ settings: settings({ types: ['formula'] }) }), h.deps), 'registered');
});

test('404와 410도 거절로 다루고 기록을 지운다', async () => {
  for (const code of [404, 410]) {
    const h = makeDeps();
    await reconcilePartnerPush(args(), h.deps);
    h.state.registerError = httpError(code);
    h.state.tokenData = 'ExponentPushToken[new]';
    assert.equal(await reconcilePartnerPush(args(), h.deps), 'rejected');
    assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
  }
});

test('네트워크 오류는 기록을 그대로 두고 다음 호출에서 다시 시도한다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  const before = h.store.get(PARTNER_PUSH_REGISTERED_KEY);
  h.state.registerError = new TypeError('Network request failed');
  const changed = args({ settings: settings({ types: ['formula'] }) });
  assert.equal(await reconcilePartnerPush(changed, h.deps), 'network_error');
  assert.equal(h.store.get(PARTNER_PUSH_REGISTERED_KEY), before);
  h.state.registerError = null;
  assert.equal(await reconcilePartnerPush(changed, h.deps), 'registered');
  assert.equal(h.count('register'), 3);

  // 처음 등록이 네트워크 오류로 실패해도 다음 호출이 다시 시도한다.
  const fresh = makeDeps();
  fresh.state.registerError = httpError(500);
  assert.equal(await reconcilePartnerPush(args(), fresh.deps), 'network_error');
  assert.equal(fresh.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
  fresh.state.registerError = null;
  assert.equal(await reconcilePartnerPush(args(), fresh.deps), 'registered');
});

test('토큰 조회가 실패하면 등록하지 않고 token_error를 돌려준다', async () => {
  const h = makeDeps();
  h.state.tokenData = new Error('FCM unavailable');
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'token_error');
  assert.equal(h.count('register'), 0);
  assert.equal(h.store.has(PARTNER_PUSH_REGISTERED_KEY), false);
});

test('등록 기록의 지문에 가족 키 원문이 없고 해시가 들어 있다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args({ syncKey: 'super-secret-family-key' }), h.deps);
  const record = readRecord(h.store);
  assert.ok(!record.fingerprint.includes('super-secret-family-key'));
  assert.ok(record.fingerprint.startsWith(`${sha('super-secret-family-key')}|client-1|ExponentPushToken[aaa]|`));
  assert.equal(record.syncKey, 'super-secret-family-key');
  assert.equal(record.clientId, 'client-1');
});

test('시간대 부호를 뒤집어 보낸다(getTimezoneOffset -540 -> 540)', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  assert.equal(h.calls.find(call => call.name === 'register').body.tzOffsetMinutes, 540);

  const utc = makeDeps({ getTimezoneOffset: () => 0 });
  await reconcilePartnerPush(args(), utc.deps);
  assert.ok(Object.is(utc.calls.find(call => call.name === 'register').body.tzOffsetMinutes, 0));

  const west = makeDeps({ getTimezoneOffset: () => 300 });
  await reconcilePartnerPush(args(), west.deps);
  assert.equal(west.calls.find(call => call.name === 'register').body.tzOffsetMinutes, -300);
});

test('요청 본문 필드와 projectId가 서버 계약과 같다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args({ settings: settings({ quiet: { start: 1320, end: 420 } }) }), h.deps);
  const register = h.calls.find(call => call.name === 'register');
  assert.deepEqual(register.body, {
    token: 'ExponentPushToken[aaa]',
    types: PARTNER_PUSH_TYPES,
    quietStart: 1320,
    quietEnd: 420,
    tzOffsetMinutes: 540,
  });
  assert.deepEqual(h.calls.find(call => call.name === 'token').options, { projectId: 'project-1' });
});

test('Android는 토큰 조회 전에 채널 두 개를 만들고 iOS는 만들지 않는다', async () => {
  const android = makeDeps();
  await reconcilePartnerPush(args(), android.deps);
  const order = android.names();
  assert.equal(android.count('channel'), 2);
  assert.ok(order.lastIndexOf('channel') < order.indexOf('token'));
  const channels = Object.fromEntries(android.calls.filter(c => c.name === 'channel').map(c => [c.id, c.spec]));
  assert.deepEqual(channels['partner-records'], { name: '가족 기록 알림', importance: 'high', sound: true, vibrate: true });
  assert.deepEqual(channels['partner-records-quiet'], {
    name: '가족 기록 알림(조용히)',
    importance: 'low',
    sound: false,
    vibrate: false,
  });

  const ios = makeDeps({ platformOS: 'ios' });
  await reconcilePartnerPush(args(), ios.deps);
  assert.equal(ios.count('channel'), 0);
  assert.equal(ios.count('register'), 1);
});

test('동시에 불린 호출은 직렬로 실행되고 중간 호출은 하나로 합쳐진다', async () => {
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const h = makeDeps();
  const originalToken = h.deps.getExpoPushTokenAsync;
  let tokenCalls = 0;
  h.deps.getExpoPushTokenAsync = async options => {
    tokenCalls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (tokenCalls === 1) await gate;
    const result = await originalToken(options);
    active -= 1;
    return result;
  };
  const first = reconcilePartnerPush(args({ settings: settings({ types: ['formula'] }) }), h.deps);
  await tick();
  const second = reconcilePartnerPush(args({ settings: settings({ types: ['urine'] }) }), h.deps);
  const third = reconcilePartnerPush(args({ settings: settings({ types: ['stool'] }) }), h.deps);
  await tick();
  assert.equal(tokenCalls, 1, '첫 호출이 끝나기 전에 둘째가 시작되면 안 된다');
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(maxActive, 1);
  assert.equal(tokenCalls, 2, '중간 호출은 합쳐져서 한 번만 더 실행된다');
  const registers = h.calls.filter(call => call.name === 'register');
  assert.deepEqual(registers.map(call => call.body.types), [['formula'], ['stool']]);
  assert.deepEqual(results, ['registered', 'registered', 'registered']);
});

test('앞 호출이 실패해도 대기 중인 호출은 실행된다', async () => {
  const h = makeDeps();
  // 첫 등록 호출만 500으로 실패시키고, 그 직후부터는 성공시킨다.
  const originalRegister = h.deps.registerPushDevice;
  h.deps.registerPushDevice = async (...rest) => {
    h.deps.registerPushDevice = originalRegister;
    throw httpError(500);
  };
  const first = reconcilePartnerPush(args(), h.deps);
  const second = reconcilePartnerPush(args(), h.deps);
  assert.equal(await first, 'network_error');
  assert.equal(await second, 'registered');
});

test('권한 조회가 끝나지 않으면 제한 시간 안에 token_error를 돌려주고 다음 호출은 다시 실행된다', async () => {
  const h = makeDeps({ permissionTimeoutMs: 20 });
  const working = h.deps.getPermissionsAsync;
  h.deps.getPermissionsAsync = neverResolves;
  const startedAt = Date.now();
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'token_error');
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(h.count('register'), 0);
  h.deps.getPermissionsAsync = working;
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'registered');
});

test('토큰 조회가 끝나지 않으면 제한 시간 안에 token_error를 돌려주고 다음 호출은 다시 실행된다', async () => {
  const h = makeDeps({ tokenTimeoutMs: 20 });
  const working = h.deps.getExpoPushTokenAsync;
  h.deps.getExpoPushTokenAsync = neverResolves;
  const startedAt = Date.now();
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'token_error');
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(h.count('register'), 0);
  h.deps.getExpoPushTokenAsync = working;
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'registered');
});

test('처음 읽을 때 권한 조회가 던지면 꺼진 상태로 돌려주되 저장하지 않고 다음에 다시 조회한다', async () => {
  const h = makeDeps();
  const working = h.deps.getPermissionsAsync;
  h.deps.getPermissionsAsync = async () => {
    h.calls.push({ name: 'permission' });
    throw new Error('permission unavailable');
  };
  assert.equal((await loadPartnerPushSettings(h.deps)).enabled, false);
  assert.equal(h.store.has(PARTNER_PUSH_SETTINGS_KEY), false);
  h.deps.getPermissionsAsync = working;
  assert.equal((await loadPartnerPushSettings(h.deps)).enabled, true);
  assert.equal(h.count('permission'), 2);
  assert.equal(h.store.has(PARTNER_PUSH_SETTINGS_KEY), true);
});

test('reconcile 안에서 권한 조회가 던지면 token_error다', async () => {
  const h = makeDeps();
  h.deps.getPermissionsAsync = async () => {
    throw new Error('permission unavailable');
  };
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'token_error');
  assert.equal(h.count('register'), 0);
});

test('저장소가 던지면 network_error로 삼키고 다음 호출은 다시 실행된다', async () => {
  const h = makeDeps();
  const working = h.deps.storage.getItem;
  h.deps.storage.getItem = async () => {
    throw new Error('storage broken');
  };
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'network_error');
  h.deps.storage.getItem = working;
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'registered');
});

test('403 뒤에 새 deps 객체로 부르면 다시 시도한다(거절 기록은 deps마다 따로다)', async () => {
  const h = makeDeps();
  h.state.registerError = httpError(403);
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'rejected');
  assert.equal(await reconcilePartnerPush(args(), h.deps), 'rejected');
  assert.equal(h.count('register'), 1);
  const fresh = { ...h.deps };
  h.state.registerError = null;
  assert.equal(await reconcilePartnerPush(args(), fresh), 'registered');
  assert.equal(h.count('register'), 2);
});

test('400은 network_error로 다루고 기록을 그대로 둔다', async () => {
  const h = makeDeps();
  await reconcilePartnerPush(args(), h.deps);
  const before = h.store.get(PARTNER_PUSH_REGISTERED_KEY);
  h.state.registerError = httpError(400);
  assert.equal(await reconcilePartnerPush(args({ settings: settings({ types: ['formula'] }) }), h.deps), 'network_error');
  assert.equal(h.store.get(PARTNER_PUSH_REGISTERED_KEY), before);
  // 거절로 굳지 않으므로 다음 호출이 다시 시도한다.
  h.state.registerError = null;
  assert.equal(await reconcilePartnerPush(args({ settings: settings({ types: ['formula'] }) }), h.deps), 'registered');
});

test('방해 금지 시각은 HH:MM으로 보이고 30분씩 한 바퀴 돈다', () => {
  assert.deepEqual(PARTNER_PUSH_DEFAULT_QUIET, { start: 1380, end: 420 });
  assert.equal(formatMinuteOfDay(1380), '23:00');
  assert.equal(formatMinuteOfDay(420), '07:00');
  assert.equal(formatMinuteOfDay(0), '00:00');
  assert.equal(formatMinuteOfDay(1439), '23:59');
  assert.deepEqual(stepQuietTime({ start: 1380, end: 420 }, 'start', 1), { start: 1410, end: 420 });
  assert.deepEqual(stepQuietTime({ start: 1410, end: 420 }, 'start', 1), { start: 0, end: 420 });
  assert.deepEqual(stepQuietTime({ start: 0, end: 420 }, 'start', -1), { start: 1410, end: 420 });
  assert.deepEqual(stepQuietTime({ start: 1380, end: 420 }, 'end', -1), { start: 1380, end: 390 });
});

test('방해 금지 시각을 옮겨 시작과 끝이 같아지면 한 칸 더 옮긴다', () => {
  assert.deepEqual(stepQuietTime({ start: 390, end: 420 }, 'start', 1), { start: 450, end: 420 });
  assert.deepEqual(stepQuietTime({ start: 450, end: 420 }, 'start', -1), { start: 390, end: 420 });
  assert.deepEqual(stepQuietTime({ start: 420, end: 450 }, 'end', -1), { start: 420, end: 390 });
  assert.deepEqual(stepQuietTime({ start: 420, end: 390 }, 'end', 1), { start: 420, end: 450 });
});

// getPartnerPushDeps 싱글톤 시험은 partnerPushDeps.ts가 react-native와 expo 모듈을 가져와서 순수 node에서 불러올 수 없어 두지 않았습니다.

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}
if (failed > 0) {
  console.log(`${failed}/${tests.length} failed`);
  process.exit(1);
}
console.log(`partnerPush: ${tests.length} tests passed`);
