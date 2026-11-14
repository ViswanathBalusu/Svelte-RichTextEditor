// Verifying a log and its chain (08 §2, §12; HIS-033): the chain against a second implementation,
// the first seq that no longer verifies, rebuilds between checkpoints, thinned payloads, supplied
// chain heads, machine-readable output and exit codes, and no document text anywhere in a report.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdmSchema } from '@docedit/model/prosemirror';
import { describe, expect, it } from 'vitest';
import { EXIT, type LogBundle, chainHash, verifyBundle } from '../src/chain.ts';
import { DOC, bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

const schema = cdmSchema();

function log(n = 6): LogBuilder {
  const b = new LogBuilder();
  for (let i = 0; i < n; i++)
    b.add((d) => typeAt(d, i % 2 ? 'pSecret00000001B' : 'pIntro0000000001', 0, `${CANARY}${i} `), {
      user: i % 2 ? 'bob' : 'carol',
      ...(i === 3 ? { agent: 'agent-7' } : {}),
    });
  return b;
}

const clone = (b: LogBundle): LogBundle => JSON.parse(JSON.stringify(b)) as LogBundle;

describe('verifying the chain (HIS-033)', () => {
  it('finds the chain intact, computed the same way as the document service computes it', async () => {
    const b = log();
    const bundle = await bundleOf(b.log, [
      { seq: 0, doc: b.docs[0]! },
      { seq: 3, doc: b.docs[3]! },
      { seq: 6, doc: b.docs[6]! },
    ]);
    const r = await verifyBundle(bundle, { schema });
    expect(r).toMatchObject({
      status: 'intact',
      head: 6,
      commits: 6,
      payloadsChecked: 6,
      payloadsAbsent: 0,
      problems: [],
    });
    expect(r.checkpoints).toEqual([
      { seq: 0, result: 'match' },
      { seq: 3, result: 'match', from: 0, replayed: 3 },
      { seq: 6, result: 'match', from: 3, replayed: 3 },
    ]);
    // The universal hash equals Node.js's for every record.
    for (let i = 0; i < bundle.commits.length; i++) {
      const c = bundle.commits[i]!;
      expect(await chainHash(c.prevHash, c.meta, c.payloadHash)).toBe(c.hash);
    }
  });

  it('reports the first seq whose hash no longer matches when one metadata field is altered', async () => {
    const b = log();
    const bundle = await bundleOf(b.log);
    for (const [seq, field, value] of [
      [4, 'user', 'mallory'],
      [2, 'time', '2030-01-01T00:00:00.000Z'],
      [6, 'scopes', ['body', 'region:x']],
      [1, 'origin', 'restore'],
    ] as const) {
      const altered = clone(bundle);
      (altered.commits[seq - 1]!.meta as unknown as Record<string, unknown>)[field] = value;
      const r = await verifyBundle(altered);
      expect(r.status, field).toBe('altered');
      expect(r.firstBadSeq, field).toBe(seq);
    }
  });

  it('finds a payload altered in storage, a link spliced out and a head that does not match', async () => {
    const b = log();
    const bundle = await bundleOf(b.log);
    const payload = clone(bundle);
    (payload.commits[2]!.payload as { claimed: string[] }).claimed = ['x'];
    expect(await verifyBundle(payload)).toMatchObject({ status: 'altered', firstBadSeq: 3 });
    // A record missing from the stores: the log is incomplete from that seq on.
    const spliced = clone(bundle);
    spliced.commits.splice(3, 1);
    const r = await verifyBundle(spliced);
    expect(r).toMatchObject({ status: 'incomplete', firstBadSeq: 4 });
    expect(r.problems.map((p) => p.check)).toEqual(['gap']);
    const head = clone(bundle);
    head.head.chainHead = '0'.repeat(64);
    expect(await verifyBundle(head)).toMatchObject({ status: 'altered', firstBadSeq: 6 });
  });

  it('rebuilds from a checkpoint and reports a checkpoint the log does not reach', async () => {
    const b = log();
    const bundle = await bundleOf(b.log, [
      { seq: 0, doc: b.docs[0]! },
      { seq: 4, doc: b.docs[3]!, carry: false }, // the content of seq 3, recorded as seq 4
    ]);
    const r = await verifyBundle(bundle, { schema });
    expect(r.status).toBe('altered');
    expect(r.checkpoints).toEqual([
      { seq: 0, result: 'match' },
      { seq: 4, result: 'mismatch', from: 0, replayed: 4 },
    ]);
  });

  it('still verifies the chain from the stored payload hashes when payloads are thinned or moved', async () => {
    const b = log();
    const bundle = await bundleOf(b.log, [
      { seq: 0, doc: b.docs[0]! },
      { seq: 6, doc: b.docs[6]!, carry: false },
    ]);
    for (const c of bundle.commits.slice(0, 4)) delete c.payload;
    bundle.commits[4]!.payload = null; // a tombstone
    const r = await verifyBundle(bundle, { schema });
    expect(r).toMatchObject({ payloadsChecked: 1, payloadsAbsent: 5 });
    expect(r.problems).toEqual([]);
    // The chain is intact; the rebuild could not run, so the run as a whole is incomplete.
    expect(r.checkpoints[1]).toEqual({ seq: 6, result: 'unchecked', from: 0 });
    expect(r.status).toBe('incomplete');
    const chainOnly = await verifyBundle(bundle);
    expect(chainOnly.problems).toEqual([]);
  });

  it('compares chain heads a host supplied or an anchor recorded', async () => {
    const b = log();
    const bundle = await bundleOf(b.log);
    const at3 = bundle.commits[2]!.hash;
    expect(
      (await verifyBundle(bundle, { anchors: [{ seq: 3, hash: at3, source: 'webhook' }] })).anchors,
    ).toEqual([{ seq: 3, result: 'match', source: 'webhook' }]);
    const wrong = await verifyBundle(bundle, { anchors: [{ seq: 3, hash: 'f'.repeat(64) }] });
    expect(wrong).toMatchObject({
      status: 'altered',
      firstBadSeq: 3,
      anchors: [{ seq: 3, result: 'mismatch' }],
    });
    const outside = await verifyBundle(bundle, { anchors: [{ seq: 9, hash: at3 }] });
    expect(outside).toMatchObject({
      status: 'incomplete',
      anchors: [{ seq: 9, result: 'unknown' }],
    });
  });

  it('writes no document text into a report, even when a replay fails', async () => {
    const b = log();
    const bundle = await bundleOf(b.log, [
      { seq: 0, doc: b.docs[0]! },
      { seq: 6, doc: b.docs[6]!, carry: false },
    ]);
    // A step that does not apply: its slice holds the canary.
    const broken = clone(bundle);
    const steps = (broken.commits[1]!.payload as { steps: Array<Record<string, unknown>> }).steps;
    steps[0]!['from'] = 999_999;
    steps[0]!['to'] = 999_999;
    const r = await verifyBundle(broken, { schema });
    expect(r.status).toBe('altered');
    expect(JSON.stringify(r)).not.toContain('CANARY');
    expect(JSON.stringify(await verifyBundle(bundle, { schema }))).not.toContain('CANARY');
  });
});

describe('the command-line tool (HIS-033)', () => {
  const script = fileURLToPath(new URL('../scripts/verify-log.ts', import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('prints one JSON report and exits 0 intact, 1 altered, 2 incomplete, 3 unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docedit-verify-'));
    const b = log();
    const bundle = await bundleOf(b.log, [
      { seq: 0, doc: b.docs[0]! },
      { seq: 6, doc: b.docs[6]!, carry: false },
    ]);
    const write = (name: string, v: unknown) => {
      const f = join(dir, name);
      writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
      return f;
    };
    const intact = run(write('intact.json', bundle));
    expect(intact.status).toBe(EXIT.intact);
    expect(JSON.parse(intact.stdout)).toMatchObject({ status: 'intact', doc: DOC, head: 6 });
    const altered = clone(bundle);
    altered.commits[3]!.meta.user = 'mallory';
    const bad = run(write('altered.json', altered));
    expect(bad.status).toBe(EXIT.altered);
    expect(JSON.parse(bad.stdout)).toMatchObject({ status: 'altered', firstBadSeq: 4 });
    const head = bundle.commits[5]!.hash;
    expect(run(write('anchored.json', bundle), '--anchor', `6:${head}`).status).toBe(EXIT.intact);
    expect(run(write('anchored2.json', bundle), '--anchor', `6:${'0'.repeat(64)}`).status).toBe(
      EXIT.altered,
    );
    const thinned = clone(bundle);
    for (const c of thinned.commits) delete c.payload;
    expect(run(write('thinned.json', thinned)).status).toBe(EXIT.incomplete);
    expect(run(write('thinned2.json', thinned), '--no-replay').status).toBe(EXIT.incomplete);
    const unreadable = run(write('junk.json', 'not json'));
    expect(unreadable.status).toBe(EXIT.unreadable);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({ status: 'unreadable' });
    for (const r of [intact, bad, unreadable]) {
      expect(r.stdout + r.stderr).not.toContain('CANARY');
      expect(r.stdout.trim().split('\n')).toHaveLength(1);
    }
  });
});
