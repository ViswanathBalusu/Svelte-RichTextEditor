// HIS-041 (lane w7, 2026-11-17): per-document encryption keys on PostgreSQL, through the service
// (owner decision 43 in docs/owner-decisions-2026-11-15.md).
//
// The service is composed with a `documentKeyStore` (`PgDocumentKeyStore`, migration 0075) and a
// key service (`MemoryKeyService`, wrapped so that a test can make it unreachable). Commits are
// appended as a room does; the rows are read back from the database as an operator or a backup
// would see them.
//
// Criteria covered: 1 (commit payloads and checkpoints and segments of a document with a key are
// sealed), 2 (after the key is destroyed the content is unreadable in the database, in object
// storage and in a copy taken before, while the commit rows and the chain stay), 3 (with the key
// service unreachable the document is unavailable, and a write is refused, never made in the
// clear) and 4 (a tenant with the option off, and a document without a key, are unchanged).
// The database is made for this file and dropped afterwards. Test values only.
import { createHash } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { objectKeys } from '../../src/objects/store.ts';
import {
  DocumentKeyDestroyedError,
  DocumentKeyUnavailableError,
  isSealed,
  type DocumentKeys,
  type DocumentKeyStore,
} from '../../src/storage/document-keys.ts';
import { PgDocumentKeyStore } from '../../src/storage/document-keys-pg.ts';
import { MemoryKeyService, type KeyService } from '../../src/storage/key-service.ts';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LETTERS = ['A', 'B', 'C', 'D'];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

describe.skipIf(skip !== null)('per-document keys (HIS-041, PostgreSQL)', () => {
  let h: Harness;
  let keys: DocumentKeys;
  const service = new MemoryKeyService();
  let down = false;
  // A key service that can be made unreachable, as an outage would.
  const keyService: KeyService = {
    create: (...a) => service.create(...a),
    publicJwk: (...a) => service.publicJwk(...a),
    sign: (...a) => service.sign(...a),
    unwrap: async (...a) => {
      if (down) throw new Error('the key service is unreachable');
      return service.unwrap(...a);
    },
    enabled: (...a) => service.enabled(...a),
    disable: (...a) => service.disable(...a),
    destroy: (...a) => service.destroy(...a),
  };
  // The store needs the pool of the harness's database, which exists once the harness has started.
  let inner: PgDocumentKeyStore | null = null;
  const lazy: DocumentKeyStore = {
    tenantEnabled: (...a) => inner!.tenantEnabled(...a),
    setTenantEnabled: (...a) => inner!.setTenantEnabled(...a),
    get: (...a) => inner!.get(...a),
    insert: (...a) => inner!.insert(...a),
    markDestroyed: (...a) => inner!.markDestroyed(...a),
  };
  let keyed: string; // a document with its own key
  let plain: string; // a document of the same tenant with none
  let off: string; // a document made while the tenant option was off
  const contentOf: Record<number, unknown> = {};

  beforeAll(async () => {
    h = await startHarness('postgres', {
      parts: { documentKeyStore: lazy, keyService },
    });
    inner = new PgDocumentKeyStore(h.db!.service);
    keys = h.service.parts.documentKeys!;
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  const ref = (d: string): DocRef => ({ tenant: h.tenant, doc: d });
  const logs = () => h.parts.logs as PgLogStore;

  /** The document's first text block, to type into. */
  async function typingPosition(d: string): Promise<number> {
    const root = cdmSchema().nodeFromJSON(
      (await h.call('GET', `/v1/documents/${d}/content`, { token: h.apiKey })).json.doc,
    );
    let pos = -1;
    root.descendants((node, p) => {
      if (pos < 0 && node.isTextblock) pos = p + 1;
      return pos < 0;
    });
    return pos;
  }

  /** Appends `n` typing commits (the letters A, B, C, D) as a room does. */
  async function type(d: string, pos: number, n: number): Promise<void> {
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const r = ref(d);
    const epoch = await h.parts.ownership.claim(r, 'test-node');
    for (let i = 0; i < n; i++) {
      const head = await h.parts.logs.head(r);
      const perms = await h.parts.grants.current(r);
      const res = await h.parts.logs.append(r, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [
          {
            seq: head.seq + 1,
            id: uuid7(),
            kind: 'steps' as const,
            steps: [
              {
                stepType: 'replace',
                from: pos,
                to: pos,
                slice: { content: [{ type: 'text', text: LETTERS[head.seq]! }] },
              },
            ] as never,
            user: bob,
            session: 's',
            time: h.now(),
            origin: 'input',
            scopes: ['body'],
            revision: perms.revision,
            cdm: 1,
            engine: 'pm-steps/1',
            retired: [],
            claimed: [],
          },
        ],
      });
      if (res.status !== 'ok') throw new Error(`append refused: ${res.status}`);
    }
  }

  const payloads = async (d: string) =>
    (
      await h.db!.admin.query<{ seq: string; payload: Buffer }>(
        'SELECT seq, payload FROM doc_commit_payloads WHERE doc_id = $1 ORDER BY seq',
        [d],
      )
    ).rows;
  const startsWith = (b: Uint8Array, magic: readonly number[]) => magic.every((x, i) => b[i] === x);
  const rowsOf = async (d: string) =>
    (
      await h.db!.admin.query<{ t: string }>(
        'SELECT to_jsonb(c)::text AS t FROM doc_commits c WHERE doc_id = $1 ORDER BY seq',
        [d],
      )
    ).rows
      .map((x) => x.t)
      .join('\n');

  it('gives no key while the tenant option is off, and leaves the documents as they are (criterion 4)', async () => {
    off = await h.createDocument({ content: documentWithRegions(), title: 'No option' });
    await expect(keys.provision(ref(off))).rejects.toMatchObject({ reason: 'option-off' });
    await type(off, await typingPosition(off), 2);
    const rows = await payloads(off);
    expect(rows).toHaveLength(2);
    // Plain: a zstd frame, and no row of the key tables exists.
    for (const r of rows) expect(startsWith(r.payload, ZSTD_MAGIC)).toBe(true);
    expect((await h.db!.admin.query('SELECT 1 FROM document_keys')).rowCount).toBe(0);
    expect((await logs().read(ref(off), 1, 2)).map((c) => c.seq)).toEqual([1, 2]);
    expect(await logs().verify(ref(off), { payloads: true })).toMatchObject({ ok: true });
  }, 60_000);

  it('seals the commits, the checkpoints and the segments of a document with a key (criterion 1)', async () => {
    await keys.setTenantOption(h.tenant, true);
    plain = await h.createDocument({ content: documentWithRegions(), title: 'Plain twin' });
    keyed = await h.createDocument({ content: documentWithRegions(), title: 'Sensitive' });
    const pos = await typingPosition(keyed);
    const startRaw = await h.parts.objects.get(objectKeys.checkpoint(h.tenant, keyed, 0));
    await keys.provision(ref(keyed));
    // The content the document was created with is sealed at that moment, if it was stored as an object.
    const sealedStart = await h.parts.objects.get(objectKeys.checkpoint(h.tenant, keyed, 0));
    expect(startRaw).not.toBeNull();
    expect(isSealed(startRaw!)).toBe(false);
    expect(isSealed(sealedStart!)).toBe(true);
    // Read through the service it is the same content as before the key.
    expect(await h.service.parts.objects.get(objectKeys.checkpoint(h.tenant, keyed, 0))).toEqual(
      startRaw,
    );

    await type(keyed, pos, 4);
    await type(plain, await typingPosition(plain), 4);

    // The table holds sealed payloads for the keyed document and zstd frames for the other.
    const rows = await payloads(keyed);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4]);
    for (const r of rows) {
      expect(isSealed(r.payload)).toBe(true);
      expect(startsWith(r.payload, ZSTD_MAGIC)).toBe(false);
    }
    for (const r of await payloads(plain)) expect(startsWith(r.payload, ZSTD_MAGIC)).toBe(true);

    // The service reads them back: the letters are in the steps.
    const read = await logs().read(ref(keyed), 1, 4);
    expect(
      read.map(
        (c) =>
          (c.steps[0] as unknown as { slice: { content: [{ text: string }] } }).slice.content[0]
            .text,
      ),
    ).toEqual(LETTERS);
    expect(await logs().verify(ref(keyed), { payloads: true })).toMatchObject({ ok: true });

    // A checkpoint and a cold segment written through the service are sealed in object storage.
    const at2 = (await h.call('GET', `/v1/documents/${keyed}/content?seq=2`, { token: h.apiKey }))
      .json;
    contentOf[2] = at2.doc;
    const store = new ObjectCheckpointStore(h.service.parts.objects);
    await store.put(ref(keyed), 2, { cdm: at2.cdm, requires: at2.requires, doc: at2.doc });
    await h.parts.checkpointIndex!.record(ref(keyed), {
      seq: 2,
      key: objectKeys.checkpoint(h.tenant, keyed, 2),
      bytes: 1,
      hash: sha('cp2'),
    });
    const segKey = objectKeys.segment(h.tenant, keyed, 1, 2);
    await h.service.parts.objects.put(segKey, new TextEncoder().encode('cold payloads'));
    for (const k of [objectKeys.checkpoint(h.tenant, keyed, 2), segKey]) {
      expect(isSealed((await h.parts.objects.get(k))!), k).toBe(true);
    }
    const back = await store.get(ref(keyed), 2);
    expect(back?.doc).toEqual(at2.doc);
  }, 90_000);

  it('is unavailable, and writes nothing in the clear, while the key service is unreachable (criterion 3)', async () => {
    const before = (await payloads(keyed)).length;
    down = true;
    try {
      await expect(logs().read(ref(keyed), 1, 4)).rejects.toBeInstanceOf(
        DocumentKeyUnavailableError,
      );
      await expect(
        h.service.parts.objects.get(objectKeys.checkpoint(h.tenant, keyed, 2)),
      ).rejects.toBeInstanceOf(DocumentKeyUnavailableError);
      // Content over HTTP answers `unavailable`, never the content. So does the history list: it
      // projects with the head content (hidden regions), which cannot be read.
      const owner = h.userToken({ [keyed]: 'owner' }, { sub: 'olga' });
      const get = (path: string) =>
        h.call('GET', `/v1/documents/${keyed}${path}`, { token: owner });
      for (const path of ['/content?seq=1', '/history']) {
        const res = await get(path);
        expect(res.status, `${path}: ${res.text}`).toBe(503);
        expect(res.json.code).toBe('unavailable');
        expect(res.text).not.toContain('"doc"');
      }
      // The metadata of the log needs no key.
      expect(await logs().readMeta(ref(keyed), 1, 4)).toHaveLength(4);
    } finally {
      down = false;
    }
    expect((await payloads(keyed)).length).toBe(before);
    // Back up again: the same reads work, and the document was never exposed.
    expect(await logs().read(ref(keyed), 1, 4)).toHaveLength(4);
    const ok = await h.call('GET', `/v1/documents/${keyed}/content?seq=2`, {
      token: h.userToken({ [keyed]: 'owner' }, { sub: 'olga' }),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.doc).toEqual(contentOf[2]);
  }, 60_000);

  it('refuses a commit while the key service is unreachable, without writing it in the clear (criterion 3)', async () => {
    const r = ref(keyed);
    const head = await h.parts.logs.head(r);
    const perms = await h.parts.grants.current(r);
    const epoch = head.epoch;
    const commit = {
      seq: head.seq + 1,
      id: uuid7(),
      kind: 'steps' as const,
      steps: [] as never,
      user: (await h.parts.users.resolve(h.tenant, 'bob')).surrogate,
      session: 's',
      time: h.now(),
      origin: 'input',
      scopes: ['body'],
      revision: perms.revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [],
      claimed: [],
    };
    down = true;
    try {
      const res = await h.parts.logs.append(r, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [commit],
      });
      expect(res.status).toBe('failed');
    } finally {
      down = false;
    }
    expect((await h.parts.logs.head(r)).seq).toBe(head.seq);
    expect(await payloads(keyed)).toHaveLength(head.seq);
  }, 60_000);

  it('makes the content unreadable once the key is destroyed, and keeps the rows and the chain (criterion 2)', async () => {
    const r = ref(keyed);
    // A copy of the rows and the objects, as a backup would hold them.
    const backup = {
      payloads: await payloads(keyed),
      key: (
        await h.db!.admin.query<{ key_id: string; wrapped_dek: Buffer }>(
          'SELECT key_id, wrapped_dek FROM document_keys WHERE doc_id = $1',
          [keyed],
        )
      ).rows[0]!,
      objects: new Map<string, Uint8Array>(),
    };
    for (const k of await h.parts.objects.list(`tenants/${h.tenant}/docs/${keyed}/`))
      backup.objects.set(k, (await h.parts.objects.get(k))!);
    expect(backup.objects.size).toBeGreaterThanOrEqual(2);
    const rowsBefore = await rowsOf(keyed);
    const verdictBefore = await logs().verify(r);
    expect(verdictBefore).toMatchObject({ ok: true });

    await keys.destroy(r);

    // Nothing reads it: the log, the objects and the REST content.
    await expect(logs().read(r, 1, 4)).rejects.toBeInstanceOf(DocumentKeyDestroyedError);
    await expect(
      h.service.parts.objects.get(objectKeys.checkpoint(h.tenant, keyed, 2)),
    ).rejects.toBeInstanceOf(DocumentKeyDestroyedError);
    const owner = h.userToken({ [keyed]: 'owner' }, { sub: 'olga' });
    const get = (path: string) => h.call('GET', `/v1/documents/${keyed}${path}`, { token: owner });
    for (const path of ['/content?seq=3', '/diff?fromSeq=1&toSeq=4', '/commits?after=0']) {
      const res = await get(path);
      expect(res.status, `${path}: ${res.text}`).toBe(404);
      expect(res.json.detail, path).toContain('key of this document was destroyed');
    }
    expect(await logs().verify(r, { payloads: true })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('destroyed'),
    });

    // The metadata rows and the hash chain are as they were; the history list still lists them.
    expect(await rowsOf(keyed)).toBe(rowsBefore);
    expect(await logs().verify(r)).toEqual(verdictBefore);
    // The history list needs the head content to project, so it is refused like the content. The
    // metadata read of the store needs no key.
    expect((await get('/history')).status).toBe(404);
    expect((await logs().readMeta(r, 1, 4)).map((c) => c.seq)).toEqual([1, 2, 3, 4]);

    // The key row keeps no wrapped data key, and the copy taken before cannot be opened: the only
    // thing that could unwrap its data key is gone.
    const row = (
      await h.db!.admin.query<{ state: string; wrapped_dek: Buffer | null }>(
        'SELECT state, wrapped_dek FROM document_keys WHERE doc_id = $1',
        [keyed],
      )
    ).rows[0]!;
    expect(row).toEqual({ state: 'destroyed', wrapped_dek: null });
    await expect(
      service.unwrap(backup.key.key_id, new Uint8Array(backup.key.wrapped_dek)),
    ).rejects.toThrow(/destroyed/);
    for (const p of backup.payloads) expect(isSealed(p.payload)).toBe(true);
    for (const b of backup.objects.values()) expect(isSealed(b)).toBe(true);

    // Another document of the tenant, with or without a key, is unaffected.
    expect(await logs().read(ref(plain), 1, 4)).toHaveLength(4);
    expect(await logs().read(ref(off), 1, 2)).toHaveLength(2);
    // Destroying again is allowed, and a new key for the document is refused.
    await keys.destroy(r);
    await expect(keys.provision(r)).rejects.toMatchObject({ reason: 'has-key' });
  }, 90_000);
});
