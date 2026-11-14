// The audit export of a log segment (08 §12; HIS-037): the range and the gate, the records it holds
// and what it strips, verification offline from the segment alone, alterations found inside it, and
// the refusals of a range that the caller may not see or that does not exist.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LogBundle } from '../src/chain.ts';
import {
  SEGMENT_FORMAT,
  type AuditSegment,
  auditSegment,
  isAuditSegment,
  verifySegment,
} from '../src/audit-segment.ts';
import { bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

async function logOf(n = 6): Promise<LogBundle> {
  const b = new LogBuilder();
  for (let i = 0; i < n; i++)
    b.add((d) => typeAt(d, i % 2 ? 'pSecret00000001B' : 'pIntro0000000001', 0, `${CANARY}${i} `), {
      user: i % 2 ? 'bob' : 'carol',
      ...(i === 3 ? { agent: 'agent-7' } : {}),
    });
  return bundleOf(b.log, [{ seq: 0, doc: b.docs[0]! }]);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function segmentOf(r: ReturnType<typeof auditSegment>): AuditSegment {
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason}`);
  return r.segment;
}

describe('the audit export of a log segment (HIS-037)', () => {
  it('holds the metadata rows, the payload hashes, the anchors of the range and the verification steps', async () => {
    const bundle = await logOf();
    bundle.anchors = [
      { seq: 2, hash: bundle.commits[1]!.hash, source: 'webhook' },
      { seq: 5, hash: bundle.commits[4]!.hash, source: 'manifest' },
    ];
    const s = segmentOf(auditSegment(bundle, { fromSeq: 2, toSeq: 5 }));
    expect(s).toMatchObject({ format: SEGMENT_FORMAT, from: 2, to: 5, head: { seq: 5 } });
    expect(s.head.chainHead).toBe(bundle.commits[4]!.hash);
    expect(s.commits.map((c) => c.meta.seq)).toEqual([2, 3, 4, 5]);
    for (const c of s.commits) {
      const original = bundle.commits[c.meta.seq - 1]!;
      expect(c.payloadHash).toBe(original.payloadHash);
      expect(c.hash).toBe(original.hash);
      expect(c.meta).toEqual(original.meta);
      expect('payload' in c).toBe(false);
    }
    expect(s.anchors.map((a) => a.seq)).toEqual([2, 5]);
    expect(s.instructions).toContain('verify-log.ts');
    // No payload text leaves with the segment.
    expect(JSON.stringify(s)).not.toContain(CANARY);
  });

  it('is refused for a range that starts after it ends, ends above the head, or lies below the gate', async () => {
    const bundle = await logOf();
    expect(auditSegment(bundle, { fromSeq: 4, toSeq: 2 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(auditSegment(bundle, { fromSeq: 1, toSeq: 9 })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(auditSegment(bundle, { fromSeq: 1, toSeq: 2, minVisibleSeq: 4 })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('cuts the range at the caller gate: no record below it is included, and only the link hash of the record just below travels (HIS-024)', async () => {
    const bundle = await logOf();
    const s = segmentOf(auditSegment(bundle, { fromSeq: 1, minVisibleSeq: 4 }));
    expect(s.from).toBe(4);
    expect(s.commits.map((c) => c.meta.seq)).toEqual([4, 5, 6]);
    const json = JSON.stringify(s);
    // Records 1 to 3 are below the gate: none of their metadata or payload hashes is in the segment.
    for (const below of bundle.commits.slice(0, 3)) {
      expect(json).not.toContain(below.payloadHash);
      expect(json).not.toContain(JSON.stringify(below.meta));
    }
    // Records 1 and 2: not even their chain hashes.
    expect(json).not.toContain(bundle.commits[0]!.hash);
    expect(json).not.toContain(bundle.commits[1]!.hash);
    // Record 3 (gate − 1): its chain hash is revealed, once, as the first held record's `prevHash`,
    // because record 4's hash is computed over it (ADR 0145 §6).
    expect(s.commits[0]!.prevHash).toBe(bundle.commits[2]!.hash);
    expect(json.split(bundle.commits[2]!.hash).length - 1).toBe(1);
  });

  it('is reachable from the package entry, which is what the document service imports (HIS-037)', async () => {
    const entry = await import('../src/index.ts');
    expect(entry.auditSegment).toBe(auditSegment);
    expect(entry.verifySegment).toBe(verifySegment);
    expect(entry.isAuditSegment).toBe(isAuditSegment);
    expect(entry.SEGMENT_FORMAT).toBe(SEGMENT_FORMAT);
    const bundle = await logOf();
    const r = entry.auditSegment(bundle, { fromSeq: 2, toSeq: 4 });
    expect(r).toMatchObject({ ok: true, segment: { from: 2, to: 4 } });
    expect(await entry.verifySegment(segmentOf(r))).toMatchObject({ status: 'intact', head: 4 });
  });

  it('verifies offline from the segment alone, after a JSON round trip, with no payloads and no schema', async () => {
    const bundle = await logOf();
    const sent = clone(segmentOf(auditSegment(bundle, { fromSeq: 3, toSeq: 6 })));
    const r = await verifySegment(sent);
    expect(r).toMatchObject({
      status: 'intact',
      head: 6,
      commits: 4,
      payloadsChecked: 0,
      payloadsAbsent: 4,
      problems: [],
    });
    expect(isAuditSegment(sent)).toBe(true);
    expect(isAuditSegment(bundle)).toBe(false);
  });

  it('finds an altered record inside the segment, and an anchor that does not match it', async () => {
    const bundle = await logOf();
    const s = segmentOf(auditSegment(bundle, { fromSeq: 2, toSeq: 6 }));
    const altered = clone(s);
    (altered.commits[1]!.meta as unknown as Record<string, unknown>).user = 'mallory';
    expect(await verifySegment(altered)).toMatchObject({ status: 'altered', firstBadSeq: 3 });

    const wrongAnchor = clone(s);
    wrongAnchor.anchors = [{ seq: 4, hash: '0'.repeat(64), source: 'webhook' }];
    expect(await verifySegment(wrongAnchor)).toMatchObject({ status: 'altered' });
  });

  it('is checked by the command-line tool from the file alone, with the exit code of its status', async () => {
    const bundle = await logOf();
    const dir = mkdtempSync(join(tmpdir(), 'segment-'));
    const file = join(dir, 'segment.json');
    writeFileSync(file, JSON.stringify(segmentOf(auditSegment(bundle, { fromSeq: 2, toSeq: 5 }))));
    const script = fileURLToPath(new URL('../scripts/verify-log.ts', import.meta.url));
    const ok = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ status: 'intact', head: 5 });

    const altered = JSON.parse(readFileSync(file, 'utf8')) as AuditSegment;
    (altered.commits[0]!.meta as unknown as Record<string, unknown>).user = 'mallory';
    writeFileSync(file, JSON.stringify(altered));
    const bad = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ status: 'altered', firstBadSeq: 2 });
  });

  it('a segment from the gate verifies its own link and does not report the records before it as missing', async () => {
    const bundle = await logOf();
    const r = await verifySegment(segmentOf(auditSegment(bundle, { fromSeq: 4, toSeq: 4 })));
    expect(r.problems.filter((p) => p.check === 'gap')).toEqual([]);
    expect(r.status).toBe('intact');
  });

  it('keeps every record of the range, once and in order, under any range and gate (property)', async () => {
    const bundle = await logOf(8);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        async (a, b, gate) => {
          const fromSeq = Math.min(a, b);
          const toSeq = Math.max(a, b);
          const r = auditSegment(bundle, { fromSeq, toSeq, minVisibleSeq: gate });
          if (toSeq < gate) {
            expect(r).toMatchObject({ ok: false, code: 'forbidden' });
            return;
          }
          const s = segmentOf(r);
          const expected = Array.from(
            { length: toSeq - Math.max(fromSeq, gate) + 1 },
            (_, i) => Math.max(fromSeq, gate) + i,
          );
          expect(s.commits.map((c) => c.meta.seq)).toEqual(expected);
          expect(s.from).toBe(Math.max(fromSeq, gate));
          const v = await verifySegment(clone(s));
          expect(v.status).toBe('intact');
        },
      ),
      { numRuns: 60 },
    );
  });
});
