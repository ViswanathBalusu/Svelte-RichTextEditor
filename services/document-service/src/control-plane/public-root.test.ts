// The salted periodic root of a tenant's chain heads (SEC-065; ADR 0409) over heads, salts, roots and
// write-once files in memory and the in-process key service.
import { createHash } from 'node:crypto';
import {
  buildPublicRoot,
  parsePublicEntry,
  verifyPublicRootProof,
  type SaltedHead,
} from '@docedit/history';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { MemoryKeyService } from '../storage/key-service.ts';
import { MemoryHeadAnchorFiles } from './head-anchoring.ts';
import {
  MemoryPublicRootStore,
  MemoryTenantSaltStore,
  PublicRoots,
  PublicRootError,
  TenantSalts,
  type DocumentHead,
  type PublicRootHeads,
} from './public-root.ts';

const T = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 26, 1, 0, 0);
const HOUR = 60 * 60 * 1000;
const doc = (n: number) => `22222222-2222-4222-8222-${n.toString(16).padStart(12, '0')}`;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

class Heads implements PublicRootHeads {
  readonly heads = new Map<string, DocumentHead>();
  commit(n: number, seq: number): void {
    this.heads.set(doc(n), { doc: doc(n), seq, chainHead: sha(`head ${n} at ${seq}`) });
  }
  async latestHeads(): Promise<DocumentHead[]> {
    return [...this.heads.values()];
  }
}

function setup() {
  const heads = new Heads();
  const keys = new MemoryKeyService();
  const salts = new TenantSalts(new MemoryTenantSaltStore(), keys);
  const files = new MemoryHeadAnchorFiles();
  const audit = new MemoryAudit();
  const store = new MemoryPublicRootStore();
  const roots = new PublicRoots({
    heads,
    salts,
    store,
    files,
    audit,
    retainMs: 365 * 24 * HOUR,
    now: () => NOW,
  });
  return { heads, keys, salts, files, audit, store, roots };
}

const asHead = (h: DocumentHead): SaltedHead => ({ chainHead: h.chainHead, seq: h.seq });

describe('PublicRoots', () => {
  it('builds a root over the latest heads and records the root, the period and the leaf count', async () => {
    const s = setup();
    s.heads.commit(1, 3);
    s.heads.commit(2, 5);
    s.heads.commit(3, 1);
    const run = await s.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    expect(run).toMatchObject({ leaves: 3, from: null, to: new Date(NOW).toISOString() });
    const stored = await s.store.latest(T);
    expect(stored).toMatchObject({ root: run.root, leaves: 3, to: run.to, from: null });
    const entry = parsePublicEntry(run.entry);
    expect(entry).toMatchObject({ ok: true, entry: { root: run.root, leaves: 3, to: run.to } });
  });

  it('builds nothing for a tenant without a head', async () => {
    const s = setup();
    expect(await s.roots.run(T, NOW)).toEqual({ built: false, reason: 'no-heads' });
    expect(await s.store.latest(T)).toBeNull();
  });

  it('keeps the head of a document that did not change as a leaf, and its proof verifies', async () => {
    const s = setup();
    s.heads.commit(1, 3);
    s.heads.commit(2, 5);
    const first = await s.roots.run(T, NOW);
    // Only document 1 changes in the next period.
    s.heads.commit(1, 4);
    const second = await s.roots.run(T, NOW + HOUR);
    if (!first.built || !second.built) throw new Error('not built');
    expect(second.leaves).toBe(2);
    expect(second.from).toBe(first.to);
    expect(second.root).not.toBe(first.root);
    const unchanged = await s.roots.proof(T, second.to, doc(2));
    expect(unchanged.head).toEqual(asHead(s.heads.heads.get(doc(2))!));
    const checked = await verifyPublicRootProof(second.root, {
      salt: Uint8Array.from(Buffer.from(unchanged.salt, 'hex')),
      head: unchanged.head,
      path: unchanged.path,
    });
    expect(checked).toEqual({ ok: true, covered: true });
    // The earlier period's proof for the changed document is still there.
    const old = await s.roots.proof(T, first.to, doc(1));
    expect(old.head.seq).toBe(3);
    expect(
      await verifyPublicRootProof(first.root, {
        salt: Uint8Array.from(Buffer.from(old.salt, 'hex')),
        head: old.head,
        path: old.path,
      }),
    ).toEqual({ ok: true, covered: true });
  });

  it('does not verify with a wrong salt, a changed head or another sequence number', async () => {
    const s = setup();
    s.heads.commit(1, 3);
    s.heads.commit(2, 5);
    const run = await s.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    const p = await s.roots.proof(T, run.to, doc(1));
    const salt = Uint8Array.from(Buffer.from(p.salt, 'hex'));
    const ok = { salt, head: p.head, path: p.path };
    expect(await verifyPublicRootProof(run.root, ok)).toEqual({ ok: true, covered: true });
    expect(
      await verifyPublicRootProof(run.root, { ...ok, salt: new Uint8Array(32).fill(9) }),
    ).toEqual({ ok: true, covered: false });
    expect(
      await verifyPublicRootProof(run.root, {
        ...ok,
        head: { ...p.head, chainHead: sha('another head') },
      }),
    ).toEqual({ ok: true, covered: false });
    expect(
      await verifyPublicRootProof(run.root, { ...ok, head: { ...p.head, seq: p.head.seq + 1 } }),
    ).toEqual({ ok: true, covered: false });
  });

  it('gives the same root when the same heads are built twice, under the same salt', async () => {
    const s = setup();
    s.heads.commit(1, 3);
    s.heads.commit(2, 5);
    s.heads.commit(3, 2);
    const a = await s.roots.run(T, NOW);
    const b = await s.roots.run(T, NOW + HOUR);
    if (!a.built || !b.built) throw new Error('not built');
    expect(b.root).toBe(a.root);
    // And it is the root the pure function gives for the same salt and heads, in any order.
    const salt = await s.salts.get(T, 1);
    const again = await buildPublicRoot(salt, [...s.heads.heads.values()].reverse().map(asHead));
    expect(again).toMatchObject({ ok: true, root: a.root });
  });

  it('refuses a run that is not newer than the newest root', async () => {
    const s = setup();
    s.heads.commit(1, 1);
    await s.roots.run(T, NOW);
    await expect(s.roots.run(T, NOW)).rejects.toBeInstanceOf(PublicRootError);
  });
});

describe('tenant salt (criterion 5)', () => {
  it('is created under the tenant key, stored wrapped, and unwrapped through the key service', async () => {
    const s = setup();
    s.heads.commit(1, 1);
    await s.roots.run(T, NOW);
    expect(await s.keys.enabled(`tenant-salt-${T}`)).toBe(true);
    const a = await s.salts.get(T, 1);
    expect(a).toHaveLength(32);
    expect((await s.salts.current(T)).version).toBe(1);
  });

  it('is never written to a file, an audit event, a stored record or the public entry', async () => {
    const s = setup();
    s.heads.commit(1, 1);
    s.heads.commit(2, 2);
    const run = await s.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    const salt = await s.salts.get(T, 1);
    const needles = [
      Buffer.from(salt).toString('hex'),
      Buffer.from(salt).toString('base64'),
      Buffer.from(salt).toString('base64url'),
    ];
    const haystacks: string[] = [run.entry, JSON.stringify(await s.store.latest(T))];
    for (const key of s.files.keys())
      haystacks.push(Buffer.from((await s.files.get(key))!).toString('utf8'));
    haystacks.push(JSON.stringify(s.audit.events));
    expect(haystacks.length).toBeGreaterThan(4);
    for (const h of haystacks) for (const n of needles) expect(h).not.toContain(n);
  });

  it('rotates by version, and an old root can still be proved under its own salt', async () => {
    const s = setup();
    s.heads.commit(1, 1);
    const first = await s.roots.run(T, NOW);
    expect(await s.salts.rotate(T)).toEqual({ version: 2 });
    s.heads.commit(1, 2);
    const second = await s.roots.run(T, NOW + HOUR);
    if (!first.built || !second.built) throw new Error('not built');
    expect((await s.store.get(T, first.to))!.saltVersion).toBe(1);
    expect((await s.store.get(T, second.to))!.saltVersion).toBe(2);
    expect((await s.roots.proof(T, first.to, doc(1))).saltVersion).toBe(1);
    expect((await s.roots.proof(T, second.to, doc(1))).saltVersion).toBe(2);
    expect(await s.salts.get(T, 1)).not.toEqual(await s.salts.get(T, 2));
  });

  it('is unrecoverable when the tenant key is destroyed', async () => {
    const s = setup();
    s.heads.commit(1, 1);
    const run = await s.roots.run(T, NOW);
    if (!run.built) throw new Error('not built');
    await s.salts.destroy(T);
    await expect(s.roots.proof(T, run.to, doc(1))).rejects.toBeInstanceOf(PublicRootError);
    await expect(s.salts.get(T, 1)).rejects.toThrow();
  });
});
