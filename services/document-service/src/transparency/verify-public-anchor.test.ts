// A relying party checks a head against the log (SEC-067; ADR 0409): the proof, the receipt's
// checkpoint and the chain, each reported; a rewritten chain; a head after the last root; and offline
// with a saved receipt, by running the command as a child process with the log stopped.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type LogBundle, type PublicAnchorEvidence } from '@docedit/history';
import { canonicalize } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { MemoryKeyService } from '../storage/key-service.ts';
import { MemoryHeadAnchorFiles } from '../control-plane/head-anchoring.ts';
import { PublicAnchorExport } from '../control-plane/public-anchor-export.ts';
import {
  MemoryPublicRootStore,
  MemoryTenantSaltStore,
  PublicRoots,
  TenantSalts,
  type DocumentHead,
} from '../control-plane/public-root.ts';
import { PublicRootAnchors } from '../control-plane/public-root-submit.ts';
import { HttpTransparencyLog, LocalTransparencyLog } from './local-log.ts';
import { parseVerifierKey } from './tlog.ts';
import { verifyPublicAnchor } from './verify-public-anchor.ts';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../../scripts/verify-public-anchor.ts', import.meta.url));
const T = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-000000000001';
const OTHER = '22222222-2222-4222-8222-000000000002';
const NOW = Date.UTC(2026, 10, 26, 1, 0, 0);
const HOUR = 60 * 60 * 1000;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** A log of `n` commits the way the service writes its rows; `variant` rewrites it from seq 3 on. */
function bundle(n: number, variant = 0): LogBundle {
  const commits: LogBundle['commits'] = [];
  let prev: Buffer | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const payload = { steps: [{ n: seq, v: seq >= 3 ? variant : 0 }], retired: [], claimed: [] };
    const bytes = Buffer.from(canonicalize(payload), 'utf8');
    const meta = {
      doc: D,
      seq,
      kind: 'steps',
      id: `0192f0c4-7b1e-7000-8000-${seq.toString(16).padStart(12, '0')}`,
      user: 'u-test',
      session: null,
      agent: null,
      time: new Date(NOW + seq * 1000).toISOString(),
      origin: 'input',
      scopes: ['body'],
      base: null,
      rebased: null,
      revision: 1,
      jti: null,
      cdm: 1,
      engine: 'pm-steps/1',
      size: bytes.length,
    };
    const payloadHash = sha(bytes);
    const hash = sha(
      Buffer.concat([
        prev ?? Buffer.alloc(32),
        Buffer.from(canonicalize(meta), 'utf8'),
        payloadHash,
      ]),
    );
    commits.push({
      meta: meta as LogBundle['commits'][number]['meta'],
      payloadHash: payloadHash.toString('hex'),
      prevHash: prev ? prev.toString('hex') : null,
      hash: hash.toString('hex'),
      payload,
    });
    prev = hash;
  }
  return {
    format: 'docedit-log-bundle/1',
    doc: D,
    head: { seq: n, chainHead: prev ? prev.toString('hex') : null },
    commits,
  };
}

const logs: LocalTransparencyLog[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map((l) => l.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A tenant whose document D has `anchoredSeq` commits at the time of the root. */
async function anchored(anchoredSeq: number, options: { submit?: boolean } = {}) {
  const local = new LocalTransparencyLog('test-local-log');
  logs.push(local);
  const url = await local.listen(0);
  const verifier = parseVerifierKey(local.verifierKey)!;
  const original = bundle(anchoredSeq);
  const heads: DocumentHead[] = [
    { doc: D, seq: anchoredSeq, chainHead: original.head.chainHead! },
    { doc: OTHER, seq: 1, chainHead: sha('other').toString('hex') },
  ];
  const files = new MemoryHeadAnchorFiles();
  const audit = new MemoryAudit();
  const store = new MemoryPublicRootStore();
  const roots = new PublicRoots({
    heads: { latestHeads: async () => heads },
    salts: new TenantSalts(new MemoryTenantSaltStore(), new MemoryKeyService()),
    store,
    files,
    audit,
    retainMs: 365 * 24 * HOUR,
    now: () => NOW,
  });
  const anchors = new PublicRootAnchors({
    store,
    log: new HttpTransparencyLog({ baseUrl: url, verifierKey: verifier, timeoutMs: 500 }),
    files,
    audit,
    retainMs: 365 * 24 * HOUR,
    now: () => NOW,
  });
  const built = await roots.run(T, NOW);
  if (!built.built) throw new Error('not built');
  if (options.submit !== false) await anchors.submitPending(T, NOW);
  const evidence = (
    await new PublicAnchorExport(roots, store).evidence(T, D, { from: 1, to: anchoredSeq })
  )[0]!;
  return { local, verifier, evidence, built, store };
}

describe('verifyPublicAnchor', () => {
  it('checks the proof, the receipt and the chain up to the head, and reports each', async () => {
    const s = await anchored(5);
    const report = await verifyPublicAnchor(s.evidence, {
      logKey: s.verifier,
      chain: bundle(5),
    });
    expect(report.status).toBe('verified');
    expect(report.entry).toMatchObject({ ok: true, leaves: 2 });
    expect(report.proof.covered).toBe(true);
    expect(report.receipt).toMatchObject({
      state: 'checked',
      check: { leaf: true, signature: true, checkpoint: true, inclusion: true, ok: true },
    });
    expect(report.chain).toMatchObject({ state: 'verified', anchoredHead: 'match' });
    expect(report.notYetAnchored).toBeNull();
    expect(report.problems).toEqual([]);
  });

  it('reports a chain rewritten after its root was published as a head that is not in the root', async () => {
    const s = await anchored(5);
    const report = await verifyPublicAnchor(s.evidence, {
      logKey: s.verifier,
      chain: bundle(5, 1),
    });
    expect(report.status).toBe('failed');
    expect(report.chain).toMatchObject({ state: 'verified', anchoredHead: 'mismatch' });
    expect(report.problems).toContain('the head of the log at seq 5 is not in the published root');
  });

  it('reports a head committed after the last root as not yet anchored, with the end of the period', async () => {
    const s = await anchored(3);
    const report = await verifyPublicAnchor(s.evidence, {
      logKey: s.verifier,
      chain: bundle(5),
    });
    expect(report.status).toBe('not-yet-anchored');
    expect(report.notYetAnchored).toEqual({
      afterSeq: 3,
      logHead: 5,
      periodEnd: new Date(NOW).toISOString(),
    });
    expect(report.problems).toEqual([]);
  });

  it('fails with another key for the log, a changed salt, a changed head or an entry that is not its own', async () => {
    const s = await anchored(5);
    const other = parseVerifierKey(new LocalTransparencyLog('test-local-log').verifierKey)!;
    const withOther = await verifyPublicAnchor(s.evidence, { logKey: other, chain: bundle(5) });
    expect(withOther.status).toBe('failed');
    expect(withOther.problems).toContain("the checkpoint is not signed by the log's key");
    const salted: PublicAnchorEvidence = { ...s.evidence, salt: '00'.repeat(32) };
    expect((await verifyPublicAnchor(salted, { logKey: s.verifier })).problems).toContain(
      'the head is not in the published root',
    );
    const moved: PublicAnchorEvidence = {
      ...s.evidence,
      head: { ...s.evidence.head, seq: s.evidence.head.seq + 1 },
    };
    expect((await verifyPublicAnchor(moved, { logKey: s.verifier })).status).toBe('failed');
    const swapped: PublicAnchorEvidence = {
      ...s.evidence,
      entry: s.evidence.entry.replace('"leaves":2', '"leaves":3'),
    };
    expect((await verifyPublicAnchor(swapped, { logKey: s.verifier })).status).toBe('failed');
  });

  it('is incomplete, not failed, when the root has no receipt yet, no key is given or no chain is given', async () => {
    const pending = await anchored(5, { submit: false });
    expect(pending.evidence.receipt).toBeNull();
    const a = await verifyPublicAnchor(pending.evidence, {
      logKey: pending.verifier,
      chain: bundle(5),
    });
    expect(a).toMatchObject({ status: 'incomplete', receipt: { state: 'missing' }, problems: [] });
    const s = await anchored(5);
    expect((await verifyPublicAnchor(s.evidence, { chain: bundle(5) })).receipt).toMatchObject({
      state: 'unchecked',
    });
    expect((await verifyPublicAnchor(s.evidence, { logKey: s.verifier })).status).toBe(
      'incomplete',
    );
  });
});

describe('the command, with the log stopped (no network)', () => {
  async function files(s: Awaited<ReturnType<typeof anchored>>, chain: LogBundle) {
    const dir = await mkdtemp(join(tmpdir(), 'sec-067-'));
    dirs.push(dir);
    const evidence = join(dir, 'evidence.json');
    const bundleFile = join(dir, 'bundle.json');
    const key = join(dir, 'log.key');
    await writeFile(evidence, JSON.stringify(s.evidence));
    await writeFile(bundleFile, JSON.stringify(chain));
    await writeFile(key, s.local.verifierKey);
    // The log is stopped: whatever the command does, it does not reach it.
    await s.local.close();
    return { evidence, bundleFile, key };
  }

  async function command(args: string[]) {
    try {
      const r = await run(process.execPath, [CLI, ...args], { timeout: 60_000 });
      return { code: 0, out: JSON.parse(r.stdout) as Record<string, unknown> };
    } catch (e) {
      const x = e as { code: number; stdout: string };
      return { code: x.code, out: JSON.parse(x.stdout) as Record<string, unknown> };
    }
  }

  it('verifies offline from a saved receipt and exits 0', async () => {
    const s = await anchored(5);
    const f = await files(s, bundle(5));
    const r = await command([f.evidence, '--log-key', f.key, '--bundle', f.bundleFile]);
    expect(r.out['status']).toBe('verified');
    expect(r.code).toBe(0);
  });

  it('exits 1 for a rewritten chain and says which head is not in the root', async () => {
    const s = await anchored(5);
    const f = await files(s, bundle(5, 1));
    const r = await command([f.evidence, '--log-key', f.key, '--bundle', f.bundleFile]);
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.out)).toContain('is not in the published root');
  });

  it('exits 4 and names the end of the period for a head after the last root', async () => {
    const s = await anchored(3);
    const f = await files(s, bundle(5));
    const r = await command([f.evidence, '--log-key', f.key, '--bundle', f.bundleFile]);
    expect(r.code).toBe(4);
    expect(JSON.stringify(r.out)).toContain(new Date(NOW).toISOString());
  });

  it('exits 3 for a file that is not evidence and for a key that is not a key', async () => {
    const s = await anchored(5);
    const f = await files(s, bundle(5));
    expect((await command([f.key, '--log-key', f.key])).code).toBe(3);
    expect((await command([f.evidence, '--log-key', 'not a key'])).code).toBe(3);
  });
});
