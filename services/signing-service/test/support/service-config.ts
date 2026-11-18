/**
 * A deployment configuration for tests, loaded by `src/main.ts` through DOCEDIT_SIGNING_CONFIG
 * (frw-052-process.test.ts). It makes a key in this process, a test chain and a test time-stamp
 * authority, and cleans them up when the parent closes standard input. Tests only: a deployment
 * supplies its own key service adapter.
 */
import { HttpTimestampAuthority } from '../../src/cms.ts';
import { MemoryAudit } from '../../src/audit.ts';
import type { DeploymentConfig } from '../../src/main.ts';
import { makePki } from './pki.ts';
import { DOCUMENT_SERVICE_SECRET, sha256Hex, WORKER_SECRET } from './service-world.ts';
import { startTestTsa } from './tsa.ts';
import { InProcessKeyService } from './world.ts';

export default async function config(): Promise<DeploymentConfig> {
  const ks = new InProcessKeyService();
  const pki = makePki(await ks.publicKey());
  const tsa = await startTestTsa(pki);
  const audit = new MemoryAudit();
  process.stdin.resume();
  process.stdin.on('end', () => {
    void tsa.stop().finally(() => {
      pki.remove();
      process.exit(0);
    });
  });
  const enc = new TextEncoder();
  return {
    service: {
      sealing: { operatorKeyId: 'operator-key', tenantKeyIds: {} },
      keys: { get: (id) => (id === 'operator-key' ? ks : undefined) },
      certificates: { chainFor: () => Promise.resolve([pki.seal, pki.intermediate]) },
      timestamps: new HttpTimestampAuthority(tsa.url),
      validationData: () => ({
        certificates: [pki.seal, pki.intermediate, pki.root, pki.tsa],
        crls: [pki.rootCrl, pki.intermediateCrl],
        ocsps: [],
      }),
      callers: {
        [sha256Hex(enc.encode(DOCUMENT_SERVICE_SECRET))]: 'document-service',
        [sha256Hex(enc.encode(WORKER_SECRET))]: 'export-worker',
      },
      allowedCaller: 'document-service',
      rateLimit: { limit: 100, windowMs: 60_000 },
      audit,
    },
    http: { maxBodyBytes: 1_000_000 },
    listen: { host: '127.0.0.1', port: 0 },
  };
}
