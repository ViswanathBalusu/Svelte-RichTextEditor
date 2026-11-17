// FE-067 criterion 3, the element's side: the lookup the web view draws pictures with asks the
// backend's assets port for a signed URL, keeps the answer until shortly before it expires, and
// answers `undefined` for anything it cannot resolve. Node.js, with a fake port.
import type { AssetsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { assetImageLookup } from '../src/assets.ts';

function port(answer: (ids: readonly string[]) => unknown) {
  const calls: Array<{ docId: string; ids: readonly string[] }> = [];
  const fake = {
    resolve: async (docId: string, ids: readonly string[]) => {
      calls.push({ docId, ids });
      const out = answer(ids);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as AssetsPort;
  return { fake, calls };
}

const resolved = (asset: string, expiresAt: string) => ({
  assets: [
    { asset, url: `https://a.example/${asset}.png?sig=1`, expiresAt, contentType: 'image/png' },
  ],
});

describe('assetImageLookup (FE-067 criterion 3)', () => {
  it('asks the port for the document and the asset, and gives the URL and type', async () => {
    const { fake, calls } = port((ids) => resolved(ids[0]!, '2030-01-01T00:00:00Z'));
    const lookup = assetImageLookup(fake, 'doc-1', () => Date.parse('2029-01-01T00:00:00Z'));
    expect(await lookup('a1')).toEqual({
      url: 'https://a.example/a1.png?sig=1',
      contentType: 'image/png',
    });
    expect(calls).toEqual([{ docId: 'doc-1', ids: ['a1'] }]);
  });

  it('keeps an answer until a minute before it expires, then asks again', async () => {
    let now = Date.parse('2029-01-01T00:00:00Z');
    const { fake, calls } = port((ids) => resolved(ids[0]!, '2029-01-01T01:00:00Z'));
    const lookup = assetImageLookup(fake, 'doc-1', () => now);
    await lookup('a1');
    await lookup('a1');
    expect(calls.length).toBe(1);
    now = Date.parse('2029-01-01T00:59:30Z');
    await lookup('a1');
    expect(calls.length).toBe(2);
  });

  it('answers undefined when the port fails or does not list the asset', async () => {
    const failing = port(() => new Error('offline'));
    expect(await assetImageLookup(failing.fake, 'doc-1')('a1')).toBeUndefined();
    const other = port(() => resolved('other', '2030-01-01T00:00:00Z'));
    expect(await assetImageLookup(other.fake, 'doc-1')('a1')).toBeUndefined();
  });

  it('does not keep an answer whose expiry cannot be read', async () => {
    const { fake, calls } = port((ids) => resolved(ids[0]!, 'soon'));
    const lookup = assetImageLookup(fake, 'doc-1');
    await lookup('a1');
    await lookup('a1');
    expect(calls.length).toBe(2);
  });
});
