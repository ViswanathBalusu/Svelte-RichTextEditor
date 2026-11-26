// SEC-068: what leaves the system for the public log is a root and nothing else (ADR 0409; 10 §4,
// §6). Every request the adapter makes is recorded, bytes and headers, and searched for canary
// identifiers, canary text, sequence numbers and chain heads. The salts keep two tenants' leaves
// apart, destroying a salt leaves the public entry linking to nothing, and a field added to the
// entry fails the test until it is listed with a reason.
import { createHash } from 'node:crypto';
import {
  PUBLIC_ROOT_FIELD_REASONS,
  PUBLIC_ROOT_MEMBERS,
  buildPublicRoot,
  parsePublicEntry,
  publicLeaf,
  publicEntryText,
  unlistedPublicEntryFields,
  verifyPublicRootProof,
} from '@docedit/history';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import { MemoryHeadAnchorFiles } from '../../src/control-plane/head-anchoring.ts';
import {
  MemoryPublicRootStore,
  MemoryTenantSaltStore,
  PublicRoots,
  PublicRootError,
  TenantSalts,
  type DocumentHead,
} from '../../src/control-plane/public-root.ts';
import { PublicRootAnchors } from '../../src/control-plane/public-root-submit.ts';
import { MemoryKeyService } from '../../src/storage/key-service.ts';
import { HttpTransparencyLog, LocalTransparencyLog } from '../../src/transparency/local-log.ts';
import { parseVerifierKey } from '../../src/transparency/tlog.ts';

const NOW = Date.UTC(2026, 10, 26, 1, 0, 0);
const HOUR = 60 * 60 * 1000;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

// Canaries: values that must never reach the log.
const CANARY_TENANT = 'a1b2c3d4-0000-4000-8000-00000000ca01';
const CANARY_DOC = 'a1b2c3d4-0000-4000-8000-00000000ca02';
const CANARY_USER = 'canary-user-ca03';
const CANARY_TEXT = 'canary text ca04: the merger closes on Friday';
const CANARY_SEQ = 4242424;

const logs: LocalTransparencyLog[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map((l) => l.close()));
});

/** One tenant, its documents, its salts, a local log, and a record of every request made to it. */
async function tenant(id: string, heads: DocumentHead[]) {
  const local = new LocalTransparencyLog('sec-068-log');
  logs.push(local);
  const url = await local.listen(0);
  const sent: Array<{ url: string; method: string; headers: string; body: Uint8Array }> = [];
  const recording: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body =
      init?.body === undefined || init.body === null
        ? new Uint8Array()
        : Uint8Array.from(init.body as Uint8Array);
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: JSON.stringify([...headers.entries()]),
      body,
    });
    return fetch(input, init);
  };
  const keys = new MemoryKeyService();
  const salts = new TenantSalts(new MemoryTenantSaltStore(), keys);
  const files = new MemoryHeadAnchorFiles();
  const audit = new MemoryAudit();
  const store = new MemoryPublicRootStore();
  const roots = new PublicRoots({
    heads: { latestHeads: async () => heads },
    salts,
    store,
    files,
    audit,
    retainMs: 365 * 24 * HOUR,
    now: () => NOW,
  });
  const anchors = new PublicRootAnchors({
    store,
    log: new HttpTransparencyLog({
      baseUrl: url,
      verifierKey: parseVerifierKey(local.verifierKey)!,
      timeoutMs: 1000,
      fetch: recording,
    }),
    files,
    audit,
    retainMs: 365 * 24 * HOUR,
    now: () => NOW,
  });
  return { id, local, sent, salts, files, audit, store, roots, anchors, heads };
}

const canaryHeads = (): DocumentHead[] => [
  { doc: CANARY_DOC, seq: CANARY_SEQ, chainHead: sha(CANARY_TEXT) },
  { doc: 'a1b2c3d4-0000-4000-8000-00000000ca05', seq: CANARY_SEQ + 1, chainHead: sha('other') },
];

describe('what is sent to the log', () => {
  it('holds no identifier, no canary text, no sequence number and no chain head', async () => {
    const t = await tenant(CANARY_TENANT, canaryHeads());
    const run = await t.roots.run(CANARY_TENANT, NOW);
    expect(run.built).toBe(true);
    expect((await t.anchors.submitPending(CANARY_TENANT, NOW)).submitted).toBe(1);

    // Every request: its URL, headers and body, as text and as hexadecimal.
    expect(t.sent.length).toBeGreaterThan(0);
    const wire = t.sent
      .map((r) => `${r.method} ${r.url} ${r.headers} ${Buffer.from(r.body).toString('utf8')}`)
      .join('\n');
    const hex = t.sent.map((r) => Buffer.from(r.body).toString('hex')).join('');
    const forbidden = [
      CANARY_TENANT,
      CANARY_DOC,
      CANARY_USER,
      CANARY_TEXT,
      String(CANARY_SEQ),
      String(CANARY_SEQ + 1),
      ...canaryHeads().map((h) => h.chainHead),
      ...canaryHeads().map((h) => h.doc),
    ];
    for (const needle of forbidden) {
      expect(wire).not.toContain(needle);
      expect(hex).not.toContain(Buffer.from(needle, 'utf8').toString('hex'));
    }
    // What the log holds is the public entry and nothing else.
    expect(t.local.entries.map((e) => e.toString('utf8'))).toEqual([
      (run as { entry: string }).entry,
    ]);
    // The entry has only the listed members, with no "seq" member among them.
    const entry = (run as { entry: string }).entry;
    expect(unlistedPublicEntryFields(entry)).toEqual([]);
    expect(entry).not.toMatch(/seq/i);
    // And the body of the one POST is exactly the entry.
    const posts = t.sent.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(Buffer.from(posts[0]!.body).toString('utf8')).toBe(entry);
  });

  it('holds only members that are listed with a reason, and each member has one', () => {
    const text = publicEntryText({
      from: null,
      to: '2026-11-26T11:00:00.000Z',
      root: 'ab'.repeat(32),
      leaves: 2,
    });
    if (!text.ok) throw new Error(text.reason);
    expect(Object.keys(JSON.parse(text.text)).sort()).toEqual([...PUBLIC_ROOT_MEMBERS].sort());
    expect(Object.keys(PUBLIC_ROOT_FIELD_REASONS).sort()).toEqual([...PUBLIC_ROOT_MEMBERS].sort());
    for (const reason of Object.values(PUBLIC_ROOT_FIELD_REASONS))
      expect(reason.trim().length).toBeGreaterThan(10);
    expect(unlistedPublicEntryFields(text.text)).toEqual([]);
  });

  it('fails, naming the field, when a code change adds one to the submission', async () => {
    const t = await tenant(CANARY_TENANT, canaryHeads());
    const run = await t.roots.run(CANARY_TENANT, NOW);
    if (!run.built) throw new Error('not built');
    // A change that adds the tenant to the entry: the check names it, and a reader refuses it.
    const widened = run.entry.replace('{', `{"tenant":"${CANARY_TENANT}",`);
    expect(unlistedPublicEntryFields(widened)).toEqual(['tenant']);
    expect(parsePublicEntry(widened).ok).toBe(false);
    // A log adapter sent the widened entry would be caught by the same search as above.
    const wire = new TextEncoder().encode(widened);
    expect(Buffer.from(wire).toString('utf8')).toContain(CANARY_TENANT);
  });
});

describe('salts keep tenants apart', () => {
  it('gives different leaves and roots to the same head in two tenants', async () => {
    const same: DocumentHead[] = [{ doc: CANARY_DOC, seq: 7, chainHead: sha('shared head') }];
    const a = await tenant('11111111-1111-4111-8111-111111111111', same);
    const b = await tenant('22222222-2222-4222-8222-222222222222', same);
    const ra = await a.roots.run(a.id, NOW);
    const rb = await b.roots.run(b.id, NOW);
    if (!ra.built || !rb.built) throw new Error('not built');
    const saltA = await a.salts.get(a.id, 1);
    const saltB = await b.salts.get(b.id, 1);
    expect(Buffer.from(saltA).equals(Buffer.from(saltB))).toBe(false);
    const head = { chainHead: same[0]!.chainHead, seq: same[0]!.seq };
    const la = await publicLeaf(saltA, head);
    const lb = await publicLeaf(saltB, head);
    expect(la.ok && lb.ok && la.leaf !== lb.leaf).toBe(true);
    expect(ra.root).not.toBe(rb.root);
    // One tenant's salt does not open the other's root.
    expect(await verifyPublicRootProof(rb.root, { salt: saltA, head, path: [] })).toEqual({
      ok: true,
      covered: false,
    });
  });
});

describe('a destroyed salt', () => {
  it('leaves the public entry in place and linking to nothing', async () => {
    const t = await tenant(CANARY_TENANT, canaryHeads());
    const run = await t.roots.run(CANARY_TENANT, NOW);
    if (!run.built) throw new Error('not built');
    await t.anchors.submitPending(CANARY_TENANT, NOW);
    const salt = await t.salts.get(CANARY_TENANT, 1);
    const head = { chainHead: canaryHeads()[0]!.chainHead, seq: CANARY_SEQ };
    // Before: the proof can be built and verifies.
    const before = await t.roots.proof(CANARY_TENANT, run.to, CANARY_DOC);
    expect(before.head).toEqual(head);

    await t.salts.destroy(CANARY_TENANT);

    // After: the proof cannot be built, whoever asks.
    await expect(t.roots.proof(CANARY_TENANT, run.to, CANARY_DOC)).rejects.toBeInstanceOf(
      PublicRootError,
    );
    await expect(t.salts.get(CANARY_TENANT, 1)).rejects.toThrow();
    // A new salt cannot be made under the destroyed key either: the old roots stay unlinkable.
    await expect(t.salts.rotate(CANARY_TENANT)).rejects.toThrow();
    // The public entry stays, in the log and in write-once storage.
    expect(t.local.entries.map((e) => e.toString('utf8'))).toEqual([run.entry]);
    expect(t.files.keys().some((k) => k.endsWith('.json') && !k.includes('heads'))).toBe(true);
    // Without the salt the entry gives nothing to test a head against: a guess of the salt, or the
    // root's own bytes in its place, does not cover the head.
    const root = parsePublicEntry(run.entry);
    if (!root.ok) throw new Error(root.reason);
    for (const guess of [new Uint8Array(32), new Uint8Array(32).fill(255)])
      expect(await verifyPublicRootProof(root.entry.root, { salt: guess, head, path: [] })).toEqual(
        { ok: true, covered: false },
      );
    // And the entry does not hold the head: the leaf is a function of the salt, which is gone.
    expect(run.entry).not.toContain(head.chainHead);
    const withSalt = await buildPublicRoot(salt, [head]);
    expect(withSalt.ok && withSalt.root !== root.entry.root).toBe(true);
  });
});
