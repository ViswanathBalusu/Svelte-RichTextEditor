// Submitting public roots through the TransparencyLog port (SEC-066; ADR 0409) to a local log of the
// format of the proposed public log, on an ephemeral port: receipts, the failure path, the port off.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { objectKeys } from '../objects/store.ts';
import { MemoryKeyService } from '../storage/key-service.ts';
import {
  checkReceipt,
  parseReceipt,
  TransparencyLogUnavailableError,
} from '../transparency/log-port.ts';
import { HttpTransparencyLog, LocalTransparencyLog } from '../transparency/local-log.ts';
import { parseVerifierKey } from '../transparency/tlog.ts';
import { MemoryHeadAnchorFiles } from './head-anchoring.ts';
import {
  MemoryPublicRootStore,
  MemoryTenantSaltStore,
  PublicRoots,
  TenantSalts,
  type DocumentHead,
} from './public-root.ts';
import { PublicRootAnchors, publicRootSubmitTask } from './public-root-submit.ts';

const T = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 26, 1, 0, 0);
const HOUR = 60 * 60 * 1000;
const doc = (n: number) => `22222222-2222-4222-8222-${n.toString(16).padStart(12, '0')}`;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const logs: LocalTransparencyLog[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map((l) => l.close()));
});

async function setup(options: { off?: boolean; url?: string } = {}) {
  const local = new LocalTransparencyLog('test-local-log');
  logs.push(local);
  const url = options.url ?? (await local.listen(0));
  const verifier = parseVerifierKey(local.verifierKey)!;
  const log = options.off
    ? null
    : new HttpTransparencyLog({ baseUrl: url, verifierKey: verifier, timeoutMs: 500 });
  const heads: DocumentHead[] = [1, 2, 3].map((n) => ({
    doc: doc(n),
    seq: n,
    chainHead: sha(`head ${n}`),
  }));
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
    log,
    files,
    audit,
    retainMs: 365 * 24 * HOUR,
    now: () => NOW,
  });
  return { local, verifier, log, heads, files, audit, store, roots, anchors };
}

describe('PublicRootAnchors', () => {
  it('stores the receipt with the signed heads in write-once storage, and the checkpoint signature verifies against the log key', async () => {
    const s = await setup();
    const run = await s.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    expect(await s.anchors.submitPending(T, NOW)).toEqual({
      submitted: 1,
      pending: 0,
      off: false,
      failure: null,
    });
    const bytes = await s.files.get(objectKeys.publicRootReceipt(T, run.to));
    expect(bytes).not.toBeNull();
    const receipt = parseReceipt(new TextDecoder().decode(bytes!))!;
    expect(receipt.logId).toBe('test-local-log');
    const entry = new TextEncoder().encode(run.entry);
    expect(checkReceipt(entry, receipt, s.verifier)).toEqual({
      leaf: true,
      signature: true,
      checkpoint: true,
      inclusion: true,
      ok: true,
    });
    // Another key, a changed entry and a changed proof do not verify.
    const other = parseVerifierKey(new LocalTransparencyLog('test-local-log').verifierKey)!;
    expect(checkReceipt(entry, receipt, other)).toMatchObject({ signature: false, ok: false });
    expect(checkReceipt(new TextEncoder().encode('x'), receipt, s.verifier).ok).toBe(false);
    // The log holds exactly the public entry.
    expect(s.local.entries.map((e) => e.toString('utf8'))).toEqual([run.entry]);
    expect((await s.store.latest(T))!.receipt).not.toBeNull();
    expect(s.audit.events.map((e) => e.kind)).toContain('public-root.receipt');
  });

  it('keeps the root, retries, and asks nothing of the commit path when the log is not reachable', async () => {
    const dead = await setup({ url: 'http://127.0.0.1:1' });
    const run = await dead.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    const failed = await dead.anchors.submitPending(T, NOW);
    expect(failed).toMatchObject({
      submitted: 0,
      pending: 1,
      off: false,
      failure: { to: run.to, code: 'TransparencyLogUnavailableError' },
    });
    // The root is in write-once storage and recorded, without a receipt.
    expect(await dead.files.get(objectKeys.publicRoot(T, run.to))).not.toBeNull();
    expect((await dead.store.latest(T))!.receipt).toBeNull();
    expect(await dead.files.get(objectKeys.publicRootReceipt(T, run.to))).toBeNull();
    expect(dead.audit.events.map((e) => e.kind)).toContain('public-root.submit-failed');
    expect((await dead.anchors.report(T)).state).toBe('pending');
  });

  it('submits later, with the same index, when the log comes back', async () => {
    const s = await setup();
    const run = await s.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    // The first attempt fails because the adapter points at a dead address.
    const broken = new PublicRootAnchors({
      store: s.store,
      log: new HttpTransparencyLog({
        baseUrl: 'http://127.0.0.1:1',
        verifierKey: s.verifier,
        timeoutMs: 300,
      }),
      files: s.files,
      audit: s.audit,
      retainMs: HOUR,
      now: () => NOW,
    });
    expect((await broken.submitPending(T, NOW)).failure).not.toBeNull();
    expect(await s.anchors.submitPending(T, NOW + HOUR)).toMatchObject({
      submitted: 1,
      pending: 0,
    });
    expect(await s.anchors.submitPending(T, NOW + 2 * HOUR)).toMatchObject({ submitted: 0 });
    expect(s.local.entries).toHaveLength(1);
  });

  it('gives up on a log that does not answer within the timeout and does not hang', async () => {
    const s = await setup();
    const hanging = new HttpTransparencyLog({
      baseUrl: 'http://127.0.0.1:9',
      verifierKey: s.verifier,
      timeoutMs: 50,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(hanging.submit(new Uint8Array([1]))).rejects.toBeInstanceOf(
      TransparencyLogUnavailableError,
    );
  });

  it('works with the port turned off, and the report says that no public anchor exists', async () => {
    const s = await setup({ off: true });
    const run = await s.roots.run(T, NOW);
    expect(run.built).toBe(true);
    expect(await s.anchors.submitPending(T, NOW)).toEqual({
      submitted: 0,
      pending: 1,
      off: true,
      failure: null,
    });
    const report = await s.anchors.report(T);
    expect(report).toMatchObject({ state: 'off', log: null, roots: 1, withReceipt: 0 });
    expect(report.message).toContain('No public anchor exists');
    expect(s.local.entries).toHaveLength(0);
  });

  it('points at another log when asked, and reports its identifier', async () => {
    const s = await setup();
    const run = await s.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    expect((await s.anchors.report(T)).state).toBe('pending');
    await s.anchors.submitPending(T, NOW);
    const report = await s.anchors.report(T);
    expect(report).toMatchObject({ state: 'anchored', log: 'test-local-log', withReceipt: 1 });
    expect(report.newest?.receipt?.index).toBe(0);
  });

  it('the scheduled task counts receipts and rejects, after telling the operator, when it fails', async () => {
    const good = await setup();
    await good.roots.run(T, NOW);
    expect(
      await publicRootSubmitTask(good.anchors, HOUR).forTenant!(T, NOW, { held: new Set() }),
    ).toBe(1);
    const bad = await setup({ url: 'http://127.0.0.1:1' });
    await bad.roots.run(T, NOW);
    const told: string[] = [];
    const task = publicRootSubmitTask(bad.anchors, HOUR, (f) => void told.push(f.code));
    await expect(task.forTenant!(T, NOW, { held: new Set() })).rejects.toThrow(/submission failed/);
    expect(told).toEqual(['TransparencyLogUnavailableError']);
  });
});
