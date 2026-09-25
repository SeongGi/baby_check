import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';

export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };

export async function digestStringAsync(algorithm, data) {
  const nodeAlg = algorithm === 'SHA-256' ? 'sha256' : algorithm.replace('-', '').toLowerCase();
  return createHash(nodeAlg).update(data, 'utf8').digest('hex');
}

export function randomUUID() {
  return nodeRandomUUID();
}
