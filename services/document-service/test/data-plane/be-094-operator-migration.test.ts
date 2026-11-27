/**
 * BE-094 criteria 2 and 3 (lane w5): the operator's migration. A document moves to a newer model
 * version only when an operator runs `MigrationRunner`, with a dry run first; each document moves
 * through one snapshot commit with origin `migration`, with a checkpoint on each side, connected
 * clients receive `sync.reset`, and a run that stops leaves the rest at the version they had.
 *
 * Version 2 is the test-only one of `cdm2-test-only.ts` (owner decisions 75 and 76); nothing of it
 * ships. Everything runs over the in-memory stores and the real data plane; no PostgreSQL.
 */
import { isSnapshot } from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { BASE_JSON, baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { MigrationRunner } from '../../src/data-plane/migration.ts';
import { basePermissions, REQUIRES, startPlane, type Plane } from './support.ts';
import { EXT_KEY, MIGRATE_V1_TO_V2, serveCdm2, withKeepTogether } from './cdm2-test-only.ts';

const PARA = 'pIntro0000000001';
const intro = () => posInside(baseDoc(), PARA);

let unserve: () => void;
beforeAll(() => {
  unserve = serveCdm2();
});
afterAll(() => unserve());

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane({ settings: { cdm: { min: 1, max: 2 } } });
  planes.push(p);
  return p;
}

/** A document at CDM 1 whose first paragraph carries the `ext` value version 2 makes core. */
async function documentAtV1(p: Plane): Promise<string> {
  const id = uuid7();
  await p.stores.documents.create(p.tenant, {
    id,
    cdmVersion: 1,
    requires: [...REQUIRES],
    createdBy: 'alice',
    permissions: basePermissions(),
  });
  await p.checkpoints.put(p.ref(id), 0, {
    cdm: 1,
    requires: [...REQUIRES],
    doc: withKeepTogether(structuredClone(BASE_JSON), PARA, true),
  } as unknown as JsonEnvelope);
  return id;
}

const runner = (p: Plane): MigrationRunner =>
  new MigrationRunner({
    host: p.plane.host,
    documents: p.stores.documents,
    logs: p.stores.logs,
    migrations: [MIGRATE_V1_TO_V2],
  });

interface Node {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}
function paragraph(doc: unknown, id: string): Node | undefined {
  const walk = (n: Node): Node | undefined => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const f = walk(c);
      if (f) return f;
    }
    return undefined;
  };
  return walk(doc as Node);
}

describe('BE-094 criterion 2: a dry run first, then a snapshot commit per document', () => {
  it('writes nothing in a dry run and says what each document would do', async () => {
    const p = await plane();
    const doc = await documentAtV1(p);
    const before = await p.stores.logs.head(p.ref(doc));

    const report = await runner(p).dryRun({ tenant: p.tenant }, 2);

    expect(report).toMatchObject({ dryRun: true, target: 2, stopped: false });
    expect(report.items).toEqual([
      { doc, from: 1, outcome: 'would_migrate', steps: [MIGRATE_V1_TO_V2.name] },
    ]);
    expect((await p.stores.logs.head(p.ref(doc))).seq).toBe(before.seq);
    expect((await p.stores.documents.get(p.ref(doc)))!.cdmVersion).toBe(1);
    expect(await p.checkpoints.get(p.ref(doc), 1)).toBeNull();
  });

  it('stores one snapshot commit with origin migration, a checkpoint before and after, and sync.reset to the open channel', async () => {
    const p = await plane();
    const doc = await documentAtV1(p);
    const ref = p.ref(doc);
    // A stored step commit, so that the state before the migration is not yet a checkpoint.
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc, { cdm: 1 });
    await p.plane.host.apply(ref, {
      kind: 'author',
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(intro(), 'x')],
    });
    const headBefore = (await p.stores.logs.head(ref)).seq;
    expect(headBefore).toBe(1);

    const report = await runner(p).run({ tenant: p.tenant, documents: [doc] }, 2);

    expect(report.items, JSON.stringify(report.items)).toMatchObject([
      { doc, from: 1, outcome: 'migrated', seq: 2 },
    ]);
    // The commit: a snapshot, origin migration, stamped with the new version.
    const [commit] = await p.stores.logs.read(ref, 2, 2);
    expect(commit && isSnapshot(commit)).toBe(true);
    expect(commit).toMatchObject({ seq: 2, origin: 'migration', cdm: 2 });
    expect((commit as { snapshot: { reason: string } }).snapshot.reason).toBe('migration');
    // The stored version moved only now.
    expect((await p.stores.documents.get(ref))!.cdmVersion).toBe(2);
    // The checkpoint before (at the head the commit followed) and the one that holds the new
    // content (at the commit's own seq).
    // (The checkpoint before is written beside the commit, so it may land a moment after it.)
    let before = await p.checkpoints.get(ref, 1);
    for (let i = 0; i < 400 && !before; i++) {
      await new Promise((r) => setTimeout(r, 5));
      before = await p.checkpoints.get(ref, 1);
    }
    expect(before!.cdm).toBe(1);
    const after = await p.checkpoints.get(ref, 2);
    expect(after!.cdm).toBe(2);
    const migrated = paragraph(after!.doc, PARA)!;
    expect(migrated.attrs).toMatchObject({ keepTogether: true });
    expect(migrated.attrs?.['ext'] ?? {}).not.toHaveProperty([EXT_KEY]);
    // The open channel was told to reset, with the new content, and was closed.
    const reset = await alice.take((m) => m.t === 'sync.reset');
    expect(reset.d).toMatchObject({ seq: 2, reason: 'migration' });
    const closed = await alice.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expect(p.errors).toEqual([]);
  });

  it('opens a migrated document for a component at version 2 with the new attribute, and refuses a component at version 1', async () => {
    const p = await plane();
    const doc = await documentAtV1(p);
    await runner(p).run({ tenant: p.tenant }, 2);

    const old = await p.client('alice', { [doc]: 'owner' });
    const refused = await old.open(1, doc, { cdm: 1 });
    expect(refused).toMatchObject({ t: 'ch.rejected', d: { code: 'unsupported_cdm' } });

    const current = await p.client('alice', { [doc]: 'owner' });
    const opened = await current.open(1, doc, { cdm: 2 });
    expect(opened.t).toBe('ch.opened');
    expect(opened.d).toMatchObject({ head: 1 });
    // What the room serves is the migrated content, in the version 2 schema.
    const head = await p.plane.host.headContent(p.ref(doc));
    expect(head.envelope.cdm).toBe(2);
    expect(paragraph(head.envelope.doc, PARA)!.attrs).toMatchObject({ keepTogether: true });
    expect(p.errors).toEqual([]);
  });

  it('edits a migrated document at version 2 and keeps the new attribute through a checkpoint and a reload', async () => {
    const p = await plane();
    const doc = await documentAtV1(p);
    const ref = p.ref(doc);
    await runner(p).run({ tenant: p.tenant }, 2);
    await p.plane.host.apply(ref, {
      kind: 'author',
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 1,
      steps: [insertText(intro(), 'y')],
    });
    // A checkpoint of the room (version 2 schema), then a room loaded again from storage.
    await p.plane.host.get(ref)?.checkpointIfDirty('test');
    await p.plane.host.get(ref)?.shutdown('test', true);
    const head = await p.plane.host.headContent(ref);
    expect(head.envelope.cdm).toBe(2);
    expect(paragraph(head.envelope.doc, PARA)!.attrs).toMatchObject({ keepTogether: true });
    expect(p.errors).toEqual([]);
  });

  it('finishes a run that was cut off between the commit and the version change', async () => {
    const p = await plane();
    const doc = await documentAtV1(p);
    const ref = p.ref(doc);
    await runner(p).run({ tenant: p.tenant }, 2);
    // As if the process died before it moved the stored version.
    expect(await p.stores.documents.setCdmVersion(ref, 2, 1)).toBe(true);
    // Until the run is repeated the document does not open: its checkpoint is newer than its record.
    const c = await p.client('alice', { [doc]: 'owner' });
    expect(await c.open(1, doc, { cdm: 1 })).toMatchObject({
      t: 'ch.rejected',
      d: { code: 'unavailable' },
    });

    const report = await runner(p).run({ tenant: p.tenant }, 2);

    expect(report.items).toMatchObject([{ doc, from: 1, outcome: 'migrated', seq: 1 }]);
    expect((await p.stores.documents.get(ref))!.cdmVersion).toBe(2);
    expect((await p.stores.logs.head(ref)).seq).toBe(1);
  });

  it('leaves a document that is already at the target alone, and refuses a document it cannot migrate', async () => {
    const p = await plane();
    const doc = await documentAtV1(p);
    const r = runner(p);
    await r.run({ tenant: p.tenant }, 2);
    expect((await r.run({ tenant: p.tenant }, 2)).items).toMatchObject([
      { doc, from: 2, outcome: 'current' },
    ]);
    const missing = new MigrationRunner({
      host: p.plane.host,
      documents: p.stores.documents,
      logs: p.stores.logs,
      migrations: [],
    });
    const other = await documentAtV1(p);
    const report = await missing.run({ tenant: p.tenant, documents: [other] }, 2);
    expect(report.items[0]).toMatchObject({ doc: other, outcome: 'refused' });
    expect((await p.stores.documents.get(p.ref(other)))!.cdmVersion).toBe(1);
  });
});

describe('BE-094 criterion 3: a run that stops part-way leaves the rest at version N', () => {
  it('migrates the documents it reached and leaves the others unmigrated, still opening and editing at version 1', async () => {
    const p = await plane();
    const docs = [await documentAtV1(p), await documentAtV1(p), await documentAtV1(p)].sort();
    let reached = 0;

    const report = await runner(p).run({ tenant: p.tenant }, 2, {
      stop: () => reached >= 1,
      onItem: () => (reached += 1),
    });

    expect(report.stopped).toBe(true);
    expect(report.items.map((i) => i.outcome)).toEqual(['migrated', 'not_reached', 'not_reached']);
    expect((await p.stores.documents.get(p.ref(docs[0]!)))!.cdmVersion).toBe(2);
    for (const doc of docs.slice(1)) {
      const ref = p.ref(doc);
      expect((await p.stores.documents.get(ref))!.cdmVersion).toBe(1);
      expect((await p.stores.logs.head(ref)).seq).toBe(0);
      // It still opens at version 1 and takes an edit there.
      const c = await p.client('alice', { [doc]: 'owner' });
      expect((await c.open(1, doc, { cdm: 1 })).t).toBe('ch.opened');
      await p.plane.host.apply(ref, {
        kind: 'author',
        id: uuid7(),
        origin: 'prefill',
        actor: 'system',
        base: 0,
        steps: [insertText(intro(), 'z')],
      });
      expect((await p.stores.logs.head(ref)).seq).toBe(1);
    }
    expect(p.errors).toEqual([]);
  });
});
