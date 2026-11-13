// 가짜 Expo 푸시 서버입니다(02 설계 5장). 127.0.0.1에서만 뜨고 외부 네트워크는 쓰지 않습니다.
// real-server.mjs가 이 서버를 띄우고 env.EXPO_PUSH_URL로 연결합니다. 시나리오는 /__harness/expo 제어로 조작합니다.
//
// 받은 요청을 모두 기록합니다. POST로 온 본문은 메시지 배열(또는 메시지 하나)이며 기록에는 배열로 풀어 넣습니다.
//
// 제어(control의 body, 모두 JSON):
//   {op:'mode', mode, delayMs?, tokens?}  응답 방식을 고릅니다. 바꾸지 않은 항목은 그대로 둡니다.
//       mode: 'ok'                  메시지마다 {status:'ok', id} ticket을 돌려줌(기본)
//             'deviceNotRegistered' 메시지마다 {status:'error', details:{error:'DeviceNotRegistered'}} ticket을 돌려줌.
//                                   tokens 배열이 있으면 그 토큰의 메시지만 오류 ticket이고 나머지는 ok
//             'error500'            HTTP 500
//             'refuse'              연결 거부(서버가 듣기를 멈춤)
//       delayMs: 응답을 이만큼 늦춤(기본 0). refuse에는 적용되지 않음
//   {op:'requests'}  -> {requests: [{seq, receivedAt, method, path, messages}], messages: [...받은 메시지 전체]}
//   {op:'reset'}     기록을 비우고 응답 방식을 처음(ok, 지연 0)으로 되돌림. 거부 중이면 다시 듣기 시작
import http from 'node:http';

export function createFakeExpo() {
  const state = { mode: 'ok', delayMs: 0, tokens: null };
  const requests = [];
  let server = null;
  let port = 0;
  let sequence = 0;
  let ticketId = 0;

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const makeServer = () => {
    const created = http.createServer(async (req, res) => {
      let messages = [];
      try {
        const parsed = JSON.parse(await readBody(req));
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch { messages = []; }
      requests.push({ seq: sequence += 1, receivedAt: Date.now(), method: req.method, path: req.url, messages });
      const respond = () => {
        if (res.destroyed) return;
        if (state.mode === 'error500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ code: 'INTERNAL_SERVER_ERROR', message: 'fake expo failure' }] }));
          return;
        }
        const data = messages.map((message) => {
          const failing = state.mode === 'deviceNotRegistered' && (!state.tokens || state.tokens.includes(message?.to));
          if (failing) {
            return {
              status: 'error',
              message: `"${message?.to}" is not a registered push notification recipient`,
              details: { error: 'DeviceNotRegistered' },
            };
          }
          return { status: 'ok', id: `fake-ticket-${ticketId += 1}` };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      };
      if (state.delayMs > 0) setTimeout(respond, state.delayMs).unref();
      else respond();
    });
    created.keepAliveTimeout = 5_000;
    return created;
  };

  const listen = () => new Promise((resolve, reject) => {
    server = makeServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  const stopListening = () => new Promise((resolve) => {
    if (!server) { resolve(); return; }
    const closing = server;
    server = null;
    closing.closeAllConnections?.();
    closing.close(() => resolve());
  });

  const control = async (body = {}) => {
    const op = body.op || 'requests';
    if (op === 'mode') {
      if (body.mode !== undefined) {
        if (!['ok', 'deviceNotRegistered', 'error500', 'refuse'].includes(body.mode)) throw new Error(`알 수 없는 expo mode: ${body.mode}`);
        state.mode = body.mode;
      }
      if (body.delayMs !== undefined) state.delayMs = Number(body.delayMs) || 0;
      if (body.tokens !== undefined) state.tokens = Array.isArray(body.tokens) ? body.tokens : null;
      if (state.mode === 'refuse' && server) await stopListening();
      if (state.mode !== 'refuse' && !server) await listen();
      return { mode: state.mode, delayMs: state.delayMs, tokens: state.tokens };
    }
    if (op === 'requests') {
      return { requests: requests.map((r) => ({ ...r })), messages: requests.flatMap((r) => r.messages) };
    }
    if (op === 'reset') {
      requests.length = 0;
      state.mode = 'ok';
      state.delayMs = 0;
      state.tokens = null;
      if (!server) await listen();
      return { reset: true };
    }
    throw new Error(`알 수 없는 expo op: ${op}`);
  };

  return {
    async start() {
      await listen();
      return this.url;
    },
    get url() { return `http://127.0.0.1:${port}/--/api/v2/push/send`; },
    control,
    async stop() { await stopListening(); },
  };
}
