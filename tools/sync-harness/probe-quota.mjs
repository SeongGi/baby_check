import { randomUUID } from 'node:crypto';
import { Device, wait } from './client.mjs';
const A = new Device('QA');
try {
  await A.send('setProfile', { patch: { syncKey: `probe${randomUUID().replace(/-/g,'')}` } });
  await A.send('addLog', { log: { type: 'formula', amount: 10, timestamp: Date.now() } });
  const r = await Promise.race([
    A.send('sync'),
    wait(25000).then(() => ({ success: false, error: 'TIMEOUT (할당량 소진 시 나타나는 무한 재시도)' })),
  ]);
  console.log('RESULT:', JSON.stringify(r));
} catch (e) {
  console.log('ERROR:', e.message);
} finally {
  await A.send('quit').catch(() => undefined);
  await wait(200);
  process.exit(0);
}
