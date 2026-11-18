// BE-044 (lane w5): a document references only assets that were uploaded for it. The real data
// plane over the memory stores, with the registry of assets: a commit that references an asset the
// submitter uploaded for the document is stored and attaches it (a `doc_assets` row whose
// `first_seq` is the commit's seq); one that references another user's upload, another document's
// asset or another tenant's asset is refused `invalid_op`; and the row stays when the figure is
// removed. The row written in the persist transaction itself is
// test/data-plane/be-044-doc-assets.pg.test.ts.
import { uuid7, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryAssetRegistry } from '../../src/control-plane/assets.ts';
import { RegistryAssetAttachments, assetRefsIn } from '../../src/data-plane/asset-attachments.ts';
import { BASE_JSON, REQUIRES, memoryStores, startPlane, type Plane } from './support.ts';

const registry = new MemoryAssetRegistry();
let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** The position after the intro paragraph: a place for a block, outside every region. */
function afterIntro(): number {
  const doc = cdmSchema().nodeFromJSON(baseDoc().toJSON());
  let at = -1;
  doc.descendants((n, pos) => {
    if (n.attrs['id'] === 'pIntro0000000001') at = pos + n.nodeSize;
  });
  return at;
}

const figure = (asset: string, id = 'fFigure000000001') => ({
  type: 'figure',
  attrs: { id, asset, width: 2400, height: 1800 },
});
const insertFigure = (asset: string, at = afterIntro(), id?: string) => ({
  stepType: 'replace',
  from: at,
  to: at,
  slice: { content: [figure(asset, id)] },
});

/** A ready asset uploaded for `doc` of `tenant` by `user`. */
async function uploaded(tenant: string, doc: string, user: string): Promise<string> {
  const id = uuid7();
  await registry.create(
    tenant,
    {
      id,
      doc,
      filename: 'a.png',
      mime: 'image/png',
      declaredBytes: 10,
      createdBy: user,
      uploadExpiresAt: Date.now() + 60_000,
    },
    Date.now(),
  );
  await registry.settleReady(
    tenant,
    id,
    {
      sha256: 'a'.repeat(64),
      bytes: 10,
      contentType: 'image/png',
      objectKey: `k/${id}`,
      width: 10,
      height: 10,
      frames: null,
      renditions: [],
    },
    Date.now(),
  );
  return id;
}

async function plane() {
  const stores = memoryStores();
  const p = await startPlane({
    stores,
    deps: { assets: new RegistryAssetAttachments(stores.logs, registry) },
  });
  planes.push(p);
  return p;
}

describe('assetRefsIn', () => {
  it('names the assets of figures in slices and of attribute steps, and nothing else', () => {
    const a = uuid7();
    const b = uuid7();
    expect(
      [
        ...assetRefsIn([
          insertFigure(a),
          { stepType: 'attr', pos: 4, attr: 'asset', value: b },
          { stepType: 'attr', pos: 4, attr: 'width', value: 'not an asset' },
        ]),
      ].sort(),
    ).toEqual([a, b].sort());
  });
});

describe('a commit that references an asset (BE-044)', () => {
  it('is stored when the submitter uploaded the asset for the document, and attaches it at the commit seq (criterion 1)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const asset = await uploaded(p.tenant, doc, 'alice');
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    expect(await p.stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map());
    const r = await alice.submit(1, { base: 0, steps: [insertFigure(asset)] });
    expect(r).toMatchObject({ t: 'sync.ack', d: { seq: 1 } });
    expect(await p.stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map([[asset, 1]]));
    expect(p.errors).toEqual([]);
  });

  it('is refused invalid_op when the submitter did not upload the asset and it is not attached (criterion 2)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bobs = await uploaded(p.tenant, doc, 'bob');
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const r = await alice.submit(1, { base: 0, steps: [insertFigure(bobs)] });
    expect(r).toMatchObject({ t: 'sync.reject', d: { code: 'invalid_op' } });
    expect(await p.stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map());
    expect((await p.stores.logs.head(p.ref(doc))).seq).toBe(0);
    // An identifier that names no asset at all is refused the same way.
    const nothing = await alice.submit(1, { base: 0, steps: [insertFigure(uuid7())] });
    expect(nothing).toMatchObject({ t: 'sync.reject', d: { code: 'invalid_op' } });
  });

  it('is refused when the asset was uploaded for another document of the tenant', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const other = await p.createDocument();
    const foreign = await uploaded(p.tenant, other, 'alice');
    const alice = await p.client('alice', { [doc]: 'owner', [other]: 'owner' });
    await alice.open(1, doc);
    expect(await alice.submit(1, { base: 0, steps: [insertFigure(foreign)] })).toMatchObject({
      t: 'sync.reject',
      d: { code: 'invalid_op' },
    });
  });

  it('is refused when the asset belongs to another tenant, because assets are scoped to a tenant (criterion 3)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const otherTenant = crypto.randomUUID();
    // The same user name and the same document identifier, in another tenant: still not visible.
    const theirs = await uploaded(otherTenant, doc, 'alice');
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    expect(await alice.submit(1, { base: 0, steps: [insertFigure(theirs)] })).toMatchObject({
      t: 'sync.reject',
      d: { code: 'invalid_op' },
    });
  });

  it('may be made by another editor once the asset is attached, and the row stays when the figure is removed (criterion 5)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const asset = await uploaded(p.tenant, doc, 'alice');
    const alice = await p.client('alice', { [doc]: 'owner' });
    const carol = await p.client('carol', { [doc]: 'editor' });
    await alice.open(1, doc);
    await carol.open(1, doc);
    const at = afterIntro();
    expect(await alice.submit(1, { base: 0, steps: [insertFigure(asset, at)] })).toMatchObject({
      t: 'sync.ack',
      d: { seq: 1 },
    });
    // Carol did not upload it, and it is attached now: she may reference it again.
    const second = await carol.submit(1, {
      base: 1,
      steps: [insertFigure(asset, at, 'fFigure000000002')],
    });
    expect(second).toMatchObject({ t: 'sync.ack', d: { seq: 2 } });
    // The first figure is removed again; the document no longer shows the asset once the second goes.
    const removeBoth = await alice.submit(1, {
      base: 2,
      steps: [{ stepType: 'replace', from: at, to: at + 2 * figureSize(), slice: { content: [] } }],
    });
    expect(removeBoth.t).toBe('sync.ack');
    expect(await p.stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map([[asset, 1]]));
    expect(p.errors).toEqual([]);
  });

  it('finds the attached assets in the store when the room opens again', async () => {
    // The attached set is read from the store when the room opens, so a second plane over the same
    // stores starts with the asset attached.
    const stores = memoryStores();
    const first = await startPlane({
      stores,
      deps: { assets: new RegistryAssetAttachments(stores.logs, registry) },
    });
    planes.push(first);
    const doc = await first.createDocument();
    const asset = await uploaded(first.tenant, doc, 'alice');
    const alice = await first.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    expect((await alice.submit(1, { base: 0, steps: [insertFigure(asset)] })).t).toBe('sync.ack');
    await first.close();
    planes = planes.filter((x) => x !== first);
    const second = await startPlane({
      stores,
      tenant: first.tenant,
      checkpoints: first.checkpoints,
      deps: { assets: new RegistryAssetAttachments(stores.logs, registry) },
    });
    planes.push(second);
    const carol = await second.client('carol', { [doc]: 'editor' });
    await carol.open(1, doc);
    const again = await carol.submit(1, {
      base: 1,
      steps: [insertFigure(asset, afterIntro(), 'fFigure000000003')],
    });
    expect(again.t).toBe('sync.ack');
  });
});

describe('the attachment is part of the write (BE-044 criterion 1)', () => {
  it('is not kept when the write fails after its inserts, and is made with the retried commit', async () => {
    const stores = memoryStores();
    const p = await startPlane({
      stores,
      settings: { testMode: true },
      deps: { assets: new RegistryAssetAttachments(stores.logs, registry) },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const asset = await uploaded(p.tenant, doc, 'alice');
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    p.plane.hooks!.failNextWrite(p.ref(doc), 'after-insert');
    const failed = await alice.submit(1, { base: 0, steps: [insertFigure(asset)] });
    expect(failed).toMatchObject({ t: 'sync.reject', d: { code: 'unavailable' } });
    expect(await stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map());
    const again = await alice.submit(1, { base: 0, steps: [insertFigure(asset)] });
    expect(again).toMatchObject({ t: 'sync.ack', d: { seq: 1 } });
    expect(await stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map([[asset, 1]]));
  });
});

describe('a snapshot commit that references an asset (BE-044)', () => {
  /** The fixture content with a figure of `asset` after the title paragraph. */
  const withFigure = (asset: string): JsonEnvelope => {
    const doc = structuredClone(BASE_JSON) as {
      content: Array<{ type: string; content?: unknown[] }>;
    };
    const body = doc.content.find((n) => n.type === 'body')!;
    body.content!.splice(1, 0, figure(asset));
    return { cdm: 1, requires: [...REQUIRES], doc } as unknown as JsonEnvelope;
  };

  it('attaches the assets uploaded for the document, at the snapshot seq, and refuses the others', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const mine = await uploaded(p.tenant, doc, 'bob');
    const stranger = await uploaded(p.tenant, await p.createDocument(), 'bob');
    await expect(
      p.plane.replaceContent(p.ref(doc), withFigure(stranger), 'alice'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await p.stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map());
    // An import or a restore is not made by the uploader alone: any upload for the document passes.
    const { seq } = await p.plane.replaceContent(p.ref(doc), withFigure(mine), 'alice');
    expect(seq).toBe(1);
    expect(await p.stores.logs.attachedAssets!(p.ref(doc))).toEqual(new Map([[mine, 1]]));
  });
});
/** The size of the figure node of these tests (a leaf block with no caption: 2). */
function figureSize(): number {
  const node = cdmSchema().nodeFromJSON({
    type: 'doc',
    content: [{ type: 'figure', attrs: { ...figure(uuid7()).attrs } }],
  } as unknown as JsonEnvelope['doc']);
  return node.child(0).nodeSize;
}
