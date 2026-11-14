// FE-061 criterion 5 in a real browser (lane U-FE-049-064): a family a tenant adds to the manifest
// is registered on the page like any other family, under its hash alias, and a run that uses it
// renders with that alias (FE-062 criterion 1). Runs only in the browser projects
// (`pnpm vitest run --project browser <this file>`).
import type { FontsPort } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import tenantFontUrl from '../../perf/fonts/files/NotoSans-Regular.ttf?url';
import { manifestFamilyLookup, pageFonts, registerManifestFonts } from './font-loader.ts';
import { FONT_ALIAS_PREFIX, fontAlias } from './font-registration.ts';

const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';
const TENANT_HASH = 'd'.repeat(64);
const TENANT_FAMILY = 'Acme Sans';

const port = {
  manifest: async () => ({
    version: '0'.repeat(64),
    defaultFamily: 'Noto Serif',
    families: [
      {
        family: TENANT_FAMILY,
        role: 'text',
        licence: 'OFL-1.1',
        lineHeight: null,
        faces: [
          { style: 'regular', weight: 400, italic: false, url: tenantFontUrl, sha256: TENANT_HASH },
        ],
      },
    ],
  }),
} as unknown as FontsPort;

const unquoted = (family: string) => family.replace(/^["']|["']$/g, '');

function measure(fontFamily: string): number {
  const span = document.createElement('span');
  span.textContent = 'Hamburgefonstiv 0123456789 abc WWW iii';
  span.style.cssText = `position:absolute;white-space:pre;font-size:40px;font-family:${fontFamily};`;
  document.body.append(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

describe.skipIf(!isBrowser)('a tenant font registers like any other (FE-061 criterion 5)', () => {
  afterEach(() => {
    for (const face of Array.from(document.fonts))
      if (unquoted(face.family).startsWith(FONT_ALIAS_PREFIX)) document.fonts.delete(face);
  });

  it('registers the tenant family under its hash alias, looks it up, and renders with the alias', async () => {
    const aliases = await registerManifestFonts(port, pageFonts());
    const alias = fontAlias(TENANT_HASH);
    expect(aliases).toEqual([alias]);

    const faces = Array.from(document.fonts).filter((f) => unquoted(f.family) === alias);
    expect(faces.length).toBe(1);
    // Never under the family name.
    expect(Array.from(document.fonts).some((f) => unquoted(f.family) === TENANT_FAMILY)).toBe(
      false,
    );

    // The lookup a document's run uses gives the alias for the tenant family.
    const lookup = await manifestFamilyLookup(port);
    expect(lookup(TENANT_FAMILY)).toBe(alias);

    await document.fonts.load(`40px "${alias}"`);
    await document.fonts.ready;
    expect(faces[0]!.status).toBe('loaded');
    // Non-vacuous: the alias renders at another width than the same text in an unregistered family.
    expect(measure(`"${alias}"`)).not.toBe(measure(`"${TENANT_FAMILY}"`));
  });
});
