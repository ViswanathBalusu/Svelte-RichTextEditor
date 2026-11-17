// FE-062 criterion 1, the element's side (lane U-FE-049-064): the family lookup the engine draws
// with is read from the backend's font manifest. A family the manifest serves gives its hash alias;
// an unknown family gives nothing; a manifest that cannot be read gives a lookup that knows nothing.
import type { FontsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { manifestFamilyLookup } from '../src/font-loader.ts';
import { fontAlias } from '../src/font-registration.ts';

const HASH = 'b'.repeat(64);

const port = (manifest: unknown): FontsPort =>
  ({ manifest: async () => manifest }) as unknown as FontsPort;

const manifest = {
  version: '0'.repeat(64),
  defaultFamily: 'Noto Serif',
  families: [
    {
      family: 'Noto Serif',
      role: 'text',
      licence: 'OFL-1.1',
      lineHeight: null,
      faces: [
        { style: 'regular', weight: 400, italic: false, url: '/fonts/serif.ttf', sha256: HASH },
      ],
    },
  ],
};

describe('the manifest family lookup (FE-062 criterion 1)', () => {
  it('gives the hash alias of the file that serves a family, and nothing for another family', async () => {
    const lookup = await manifestFamilyLookup(port(manifest));
    expect(lookup('Noto Serif')).toBe(fontAlias(HASH));
    // A family with no entry takes the manifest's default family (FE-062 criterion 3).
    expect(lookup('Aptos')).toBe(fontAlias(HASH));
  });

  it('gives nothing for an unknown family when the manifest has no default family', async () => {
    const lookup = await manifestFamilyLookup(port({ ...manifest, defaultFamily: null }));
    expect(lookup('Noto Serif')).toBe(fontAlias(HASH));
    expect(lookup('Aptos')).toBeUndefined();
  });

  it('gives a lookup that knows no family when the manifest cannot be read', async () => {
    const failing = {
      manifest: async () => Promise.reject(new Error('offline')),
    } as unknown as FontsPort;
    const lookup = await manifestFamilyLookup(failing);
    expect(lookup('Noto Serif')).toBeUndefined();
  });
});
