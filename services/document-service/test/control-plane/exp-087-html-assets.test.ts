// EXP-087 criterion 6, the control plane's part: an `html` export names the ready assets of its own
// document that the readable content uses, so that the worker can package the pictures with the
// page. Test values only.
import { uuid7 } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { MemoryAssetRegistry } from '../../src/control-plane/assets.ts';
import { exportAssets } from '../../src/control-plane/export-routes.ts';
import type { Kit } from '../../src/control-plane/kit.ts';

const TENANT = uuid7();
const DOC = uuid7();
const OTHER_DOC = uuid7();
const sha = (c: string) => c.repeat(64);

async function registry(): Promise<{ d: Kit['d']; ids: Record<string, string> }> {
  const r = new MemoryAssetRegistry();
  const ids: Record<string, string> = {};
  const make = async (name: string, doc: string, ready: boolean, type = 'image/png') => {
    const id = uuid7();
    ids[name] = id;
    await r.create(
      TENANT,
      { id, doc, filename: null, mime: type, declaredBytes: 3, createdBy: 'u', uploadExpiresAt: 9 },
      1,
    );
    if (ready)
      await r.settleReady(
        TENANT,
        id,
        {
          sha256: sha(name === 'ready' ? 'a' : name === 'pdf' ? 'c' : 'b'),
          bytes: 3,
          contentType: type,
          objectKey: `k/${id}`,
          width: 1,
          height: 1,
          frames: 1,
          renditions: [],
        },
        2,
      );
  };
  await make('ready', DOC, true);
  await make('pending', DOC, false);
  await make('foreign', OTHER_DOC, true);
  await make('pdf', DOC, true, 'application/pdf');
  return { d: { assetRegistry: r } as unknown as Kit['d'], ids };
}

const image = (asset: string) => ({ type: 'image', attrs: { id: 'iAAAAAAAAAAAAAAA', asset } });

describe('EXP-087 criterion 6: the assets an html export names', () => {
  it('names the ready assets of the document that the content uses, with hash and type', async () => {
    const { d, ids } = await registry();
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [image(ids['ready']!), image(ids['ready']!)] },
        { type: 'paragraph', content: [image(ids['pdf']!)] },
      ],
    };
    expect(await exportAssets(d, TENANT, DOC, content)).toEqual({
      [ids['ready']!]: { sha256: sha('a'), mediaType: 'image/png' },
      [ids['pdf']!]: { sha256: sha('c'), mediaType: 'application/pdf' },
    });
  });

  it('leaves out an asset that is not ready, one of another document and one nothing uses', async () => {
    const { d, ids } = await registry();
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [image(ids['pending']!), image(ids['foreign']!)] }],
    };
    expect(await exportAssets(d, TENANT, DOC, content)).toEqual({});
    expect(await exportAssets(d, TENANT, DOC, { type: 'doc', content: [] })).toEqual({});
  });

  it('names nothing when the service keeps no asset registry', async () => {
    expect(
      await exportAssets({} as Kit['d'], TENANT, DOC, { type: 'doc', content: [image('x')] }),
    ).toEqual({});
  });
});
