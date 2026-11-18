/**
 * What the tests of the signing service (FRW-052, FRW-053) share: a service over the test chain,
 * the test time-stamp authority and a key service, with the credentials of the document service
 * and of another caller (the export worker), a controllable clock and an audit log in memory.
 */
import { createHash } from 'node:crypto';
import { HttpTimestampAuthority, type TimestampSource } from '../../src/cms.ts';
import type { KeyService } from '../../src/keyservice.ts';
import { MemoryAudit, type AuditSink } from '../../src/audit.ts';
import {
  SigningService,
  type KeyDirectory,
  type SealCommand,
  type SigningServiceConfig,
} from '../../src/service.ts';
import type { TestPki } from './pki.ts';

export const DOCUMENT_SERVICE_SECRET = 'document-service-secret-for-tests';
export const WORKER_SECRET = 'export-worker-secret-for-tests';

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** One key of the directory, with the test chain issued for its public key. */
export interface WorldKey {
  readonly id: string;
  readonly keyService: KeyService;
  readonly pki: TestPki;
}

export interface World {
  readonly service: SigningService;
  readonly audit: MemoryAudit;
  readonly clock: { now: Date };
  readonly config: SigningServiceConfig;
}

export function makeWorld(opts: {
  readonly operator: WorldKey;
  readonly tenants?: Readonly<Record<string, WorldKey>>;
  readonly tsaUrl: string;
  readonly timestamps?: TimestampSource;
  readonly audit?: AuditSink;
  readonly rateLimit?: { limit: number; windowMs: number };
  readonly clock?: { now: Date };
}): World {
  const all = [opts.operator, ...Object.values(opts.tenants ?? {})];
  const byId = new Map(all.map((k) => [k.id, k]));
  const directory: KeyDirectory = { get: (id) => byId.get(id)?.keyService };
  const audit = new MemoryAudit();
  const clock = opts.clock ?? { now: new Date('2026-01-02T03:04:05Z') };
  const config: SigningServiceConfig = {
    sealing: {
      operatorKeyId: opts.operator.id,
      tenantKeyIds: Object.fromEntries(
        Object.entries(opts.tenants ?? {}).map(([tenant, k]) => [tenant, k.id]),
      ),
    },
    keys: directory,
    certificates: {
      chainFor: (id) => {
        const k = byId.get(id);
        if (!k) return Promise.reject(new Error(`no certificate for ${id}`));
        return Promise.resolve([k.pki.seal, k.pki.intermediate]);
      },
    },
    timestamps: opts.timestamps ?? new HttpTimestampAuthority(opts.tsaUrl),
    validationData: (id) => {
      const k = byId.get(id)!;
      return {
        certificates: [k.pki.seal, k.pki.intermediate, k.pki.root, k.pki.tsa],
        crls: [k.pki.rootCrl, k.pki.intermediateCrl],
        ocsps: [],
      };
    },
    callers: {
      [sha256Hex(new TextEncoder().encode(DOCUMENT_SERVICE_SECRET))]: 'document-service',
      [sha256Hex(new TextEncoder().encode(WORKER_SECRET))]: 'export-worker',
    },
    allowedCaller: 'document-service',
    rateLimit: opts.rateLimit ?? { limit: 1000, windowMs: 60_000 },
    audit: opts.audit ?? audit,
    now: () => clock.now,
  };
  return { service: new SigningService(config), audit, clock, config };
}

/** A command for `pdf` as the document service would send it. */
export function command(pdf: Uint8Array, over: Partial<SealCommand> = {}): SealCommand {
  const h = sha256Hex(pdf);
  return {
    tenant: 'tenant-a',
    documentId: 'doc-1',
    seq: 7,
    pdfSha256: h,
    compileSha256: [h, h],
    pdf,
    ...over,
  };
}
