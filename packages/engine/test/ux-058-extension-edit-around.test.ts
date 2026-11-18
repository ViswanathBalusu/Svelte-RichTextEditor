/**
 * UX-058 criteria 1 and 2 through the core and the real room (the mock service): a document that
 * holds a custom block of an extension nobody registered opens, stays editable around the block, and
 * what the author saves leaves the block's payload, extension and fallback exactly as they were.
 */
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, join, newService, textOfNode, type, until } from './support.ts';

interface J {
  type: string;
  attrs?: Record<string, unknown>;
  content?: J[];
}

const BLOCK_ATTRS = {
  id: 'xBlock0000000001',
  extension: 'com.example.gone',
  payload: { kind: 'chart', series: [1, 2, 3], nested: { keep: true } },
  fallbackAsset: null,
  fallbackText: 'A chart of three values',
  ext: {},
};

function withBlock() {
  const env = contractDocument();
  env.requires = [...env.requires, 'extensions'];
  const body = (env.doc as unknown as J).content!.find((n) => n.type === 'body')!;
  body.content!.push({ type: 'extension_block', attrs: { ...BLOCK_ATTRS } });
  return env;
}

const serverBlock = (doc: J): J | undefined => {
  let found: J | undefined;
  const walk = (n: J) => {
    if (n.type === 'extension_block') found = n;
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return found;
};

describe('UX-058: a document with an extension that is not registered', () => {
  it('opens, lists the block, and stays valid', async () => {
    const service = newService();
    const docId = service.createDocument(withBlock());
    const { core, detach } = await join(service, docId, 'ann', 'editor');
    await until(() => core.permissions.get() !== null, 'access');
    expect(validate(core.getContent()).violations).toEqual([]);
    const block = serverBlock(core.getContent().doc as unknown as J);
    expect(block?.attrs).toMatchObject({
      extension: 'com.example.gone',
      fallbackText: 'A chart of three values',
    });
    detach();
    core.destroy();
  });

  it('lets the author edit around the block, and the saved block is unchanged', async () => {
    const service = newService();
    const docId = service.createDocument(withBlock());
    const { core, detach } = await join(service, docId, 'ann', 'editor');
    await until(() => core.permissions.get() !== null, 'access');
    caret(core, IDS.intro, 0);
    type(core, 'Before the chart. ');
    await core.flush();
    expect(core.saveState.get()).toBe('saved');
    expect(textOfNode(internals(core).state.doc, IDS.intro).startsWith('Before the chart. ')).toBe(
      true,
    );

    const onServer = service.document(docId)!.content().doc as unknown as J;
    const block = serverBlock(onServer)!;
    expect(block.attrs).toEqual(BLOCK_ATTRS);
    detach();
    core.destroy();
  });
});
