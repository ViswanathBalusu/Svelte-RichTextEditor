// HIS-002 criterion 2 (test vectors and independent implementations). The byte layout of a commit
// hash is `SHA-256(prev ‖ canonical(metadata) ‖ SHA-256(canonical payload))`, with 32 zero bytes as
// the previous hash of the first commit (08 §2; ADR 0020). Three implementations must agree on the
// vectors below: the service codec (`storage/codec.ts`), the history verifier (`packages/history`),
// and a third written here with `node:crypto` and its own canonical JSON for these simple values.
// The vectors are published in 08 §2.1 (docs/spec/08-history.md): the last test reads them from
// there, so the spec, the three implementations and this file cannot drift apart.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chainHash as historyChainHash } from '../../../../packages/history/src/chain.ts';
import {
  chainHash as codecChainHash,
  metadataBytes,
  type CommitMetadata,
} from '../../src/storage/codec.ts';

/** RFC 8785 for the values used here: sorted keys, no whitespace, ASCII strings, integers, null. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

const PAYLOAD = Buffer.from('{"claimed":[],"retired":[],"steps":[]}', 'utf8');

const meta1: CommitMetadata = {
  doc: 'doc-1',
  seq: 1,
  kind: 'steps',
  id: '0190f2a4-0000-7000-8000-000000000001',
  user: 'alice',
  session: 'sess-1',
  agent: null,
  time: '2026-11-06T09:00:00.000Z',
  origin: 'client',
  scopes: ['body', 'field:fTenantName00001'],
  base: 0,
  rebased: false,
  revision: 3,
  jti: 'jti-1',
  cdm: 1,
  engine: 'engine-1',
  size: 42,
};
const meta2: CommitMetadata = {
  ...meta1,
  seq: 2,
  id: '0190f2a4-0000-7000-8000-000000000002',
  base: 1,
};

// Vectors computed by the independent implementation below (node:crypto, canon()).
const H1 = '9b6ea6e0158d97a9ee6f6f270a8b8e1b510010ff20578b9731cf2b3b8b307a35';
const H2 = 'cdd687fde99148bec40c9fdc9970e47ac7a1e11be2b796c824aca86508ed5f1d';

describe('commit hash test vectors (HIS-002 criterion 2)', () => {
  it('the independent implementation reproduces the published vectors', () => {
    const h1 = sha256(Buffer.alloc(32), Buffer.from(canon(meta1), 'utf8'), sha256(PAYLOAD));
    const h2 = sha256(h1, Buffer.from(canon(meta2), 'utf8'), sha256(PAYLOAD));
    expect(h1.toString('hex')).toBe(H1);
    expect(h2.toString('hex')).toBe(H2);
  });

  it('the service codec produces the same hashes for the same commits', () => {
    const payloadHash = sha256(PAYLOAD);
    const h1 = codecChainHash(null, metadataBytes(meta1), payloadHash);
    expect(h1.toString('hex')).toBe(H1);
    const h2 = codecChainHash(h1, metadataBytes(meta2), payloadHash);
    expect(h2.toString('hex')).toBe(H2);
  });

  it('the history verifier produces the same hashes for the same commits', async () => {
    const payloadHex = sha256(PAYLOAD).toString('hex');
    const h1 = await historyChainHash(null, meta1, payloadHex);
    expect(h1).toBe(H1);
    const h2 = await historyChainHash(h1, meta2, payloadHex);
    expect(h2).toBe(H2);
  });

  it('08 §2.1 publishes the layout with these vectors, and they hash as it says', () => {
    const spec = readFileSync(
      new URL('../../../../docs/spec/08-history.md', import.meta.url),
      'utf8',
    );
    const section = spec.slice(
      spec.indexOf('### 2.1 The commit hash: byte layout'),
      spec.indexOf('## 3. Checkpoints'),
    );
    expect(section.length).toBeGreaterThan(0);
    // The layout: the join, the first commit's previous hash, and every metadata member.
    expect(section).toContain('no separator and no length prefix');
    expect(section).toContain('32 zero bytes');
    expect(section).toContain('RFC 8785');
    for (const member of Object.keys(meta1)) expect(section).toContain(`| \`${member}\` |`);
    // The vectors: the payload, the metadata bytes and the hashes, as printed in the spec.
    const blocks = [...section.matchAll(/```json\n([^\n]+)\n```/g)].map((m) => m[1]!);
    const hashes = [...section.matchAll(/^`hash` = `([0-9a-f]{64})`$/gm)].map((m) => m[1]!);
    const payload = /payload `([^`]+)` \((\d+) bytes\), whose SHA-256 is `([0-9a-f]{64})`/.exec(
      section,
    );
    expect(blocks).toEqual([canon(meta1), canon(meta2)]);
    expect(hashes).toEqual([H1, H2]);
    expect(payload?.[1]).toBe(PAYLOAD.toString('utf8'));
    expect(Number(payload?.[2])).toBe(PAYLOAD.length);
    expect(payload?.[3]).toBe(sha256(PAYLOAD).toString('hex'));
    // Recomputed from the spec's own text alone, by the independent implementation.
    const p = sha256(Buffer.from(payload![1]!, 'utf8'));
    const h1 = sha256(Buffer.alloc(32), Buffer.from(blocks[0]!, 'utf8'), p);
    const h2 = sha256(h1, Buffer.from(blocks[1]!, 'utf8'), p);
    expect([h1.toString('hex'), h2.toString('hex')]).toEqual(hashes);
    expect(section).toContain(`these ${Buffer.byteLength(blocks[0]!)} bytes`);
  });
});
