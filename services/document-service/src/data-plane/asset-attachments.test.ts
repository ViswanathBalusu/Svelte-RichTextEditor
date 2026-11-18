// The assets a commit names (invariant I4; BE-044), including the image of a signature or initials
// field, whose value is `{ asset, mode }` (FRW-046).
import { describe, expect, it } from 'vitest';
import { assetRefsIn } from './asset-attachments.ts';

const A = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01';
const B = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02';

describe('assetRefsIn', () => {
  it('names the image of a step that sets a signature value', () => {
    const steps = [{ stepType: 'attr', pos: 4, attr: 'value', value: { asset: A, mode: 'drawn' } }];
    expect([...assetRefsIn(steps)]).toEqual([A]);
  });

  it('names the image of a signature field in a node or a slice', () => {
    const slice = {
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'form_field', attrs: { id: 'f', value: { asset: B, mode: 'typed' } } }],
        },
      ],
    };
    expect([...assetRefsIn(slice)]).toEqual([B]);
  });

  it('names nothing for other values', () => {
    for (const value of ['x', 3, null, ['a'], { mode: 'typed' }, { asset: 5 }])
      expect([...assetRefsIn([{ stepType: 'attr', pos: 1, attr: 'value', value }])]).toEqual([]);
    expect([
      ...assetRefsIn({ type: 'form_field', attrs: { id: 'f', value: { note: A } } }),
    ]).toEqual([]);
  });
});
