// The character coverage of the fonts the document uses (FE-136 criterion 4; 09 §3.2). The export
// converter checks every character against the character map of the run's font; the editor says
// so earlier. The coverage is read from the font files of the manifest (`GET /fonts`, 05 §6.2), the
// files the page draws with, by the converter's own reader of the `cmap` table, so both sides see
// the same characters. The reader is the converter's file alone (`fonts/coverage.ts`), not the
// converter, which would bring KaTeX into the page.
//
// Only the families the document names are read when the editor opens, with the default family; a
// family used later is read the first time it is asked for, so its first symbol is not flagged
// and the ones after it are. A file that cannot be fetched or read leaves its family unknown, and
// an unknown family is never flagged. No file is read when there is no manifest.
import { type CodeRange, fontCoverage } from '@docedit/export-latex/fonts/coverage';
import type { GlyphCoverage } from '@docedit/engine';
import { resolveFamily } from './font-family-lookup.ts';
import type { ManifestSource } from './font-loader.ts';

/** Reads the bytes of a font file; the default is `fetch`. */
export type FontBytes = (url: string) => Promise<Uint8Array>;

const defaultBytes: FontBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`font file ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The family names a CDM document sets text in: `fontFamily` marks and style definitions. */
export function usedFamilies(doc: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!isObject(node)) return;
    const attrs = node['attrs'];
    if (node['type'] === 'style_def' && isObject(attrs) && typeof attrs['fontFamily'] === 'string')
      found.add(attrs['fontFamily']);
    if (Array.isArray(node['marks'])) {
      for (const mark of node['marks']) {
        if (!isObject(mark) || mark['type'] !== 'fontFamily') continue;
        const a = mark['attrs'];
        if (isObject(a) && typeof a['value'] === 'string') found.add(a['value']);
      }
    }
    if (Array.isArray(node['content'])) for (const child of node['content']) walk(child);
  };
  walk(doc);
  return [...found];
}

/**
 * The coverage function the core takes, over the manifest the port gives. The returned promise
 * settles once the files of `families` (and the default family) have been tried.
 */
export async function loadGlyphCoverage(
  port: ManifestSource,
  families: readonly string[],
  bytes: FontBytes = defaultBytes,
): Promise<GlyphCoverage> {
  const manifest = await port.manifest();
  const defaultFamily =
    isObject(manifest) && typeof manifest['defaultFamily'] === 'string'
      ? manifest['defaultFamily']
      : null;
  const byUrl = new Map<string, readonly CodeRange[] | null>();
  const pending = new Map<string, Promise<void>>();

  const read = (url: string): Promise<void> => {
    let p = pending.get(url);
    if (!p) {
      p = bytes(url)
        .then((data) => {
          byUrl.set(url, fontCoverage(data));
        })
        .catch(() => {
          byUrl.set(url, null);
        });
      pending.set(url, p);
    }
    return p;
  };
  const faceUrl = (family: string | null): string | null => {
    const name = family ?? defaultFamily;
    if (name === null) return null;
    return resolveFamily(manifest, name)?.face.url ?? null;
  };

  const wanted = new Set<string | null>([null, ...families]);
  await Promise.all(
    [...wanted].map((family) => {
      const url = faceUrl(family);
      return url === null ? undefined : read(url);
    }),
  );

  return (family) => {
    const url = faceUrl(family);
    if (url === null) return null;
    if (!byUrl.has(url)) {
      // A family nobody asked for before: read now, answer from the next call on.
      void read(url);
      return null;
    }
    return byUrl.get(url) ?? null;
  };
}
