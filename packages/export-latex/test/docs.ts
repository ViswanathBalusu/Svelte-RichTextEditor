/**
 * Documents and inputs for the converter's tests (Node.js only): a small builder for valid CDM
 * envelopes, a font manifest with made-up hashes, and helpers that read the bundle back.
 */
import type { CdmEnvelope } from '@docedit/model';
import type { Bundle, ConvertOptions, FontManifest } from '../src/index.ts';
import { convert } from '../src/index.ts';

const face = (c: string) => ({ file: `${c.repeat(64)}.ttf`, sha256: c.repeat(64) });

export const FONTS: FontManifest = {
  version: 1,
  families: [
    {
      name: 'Noto Serif',
      lineHeight: 1362,
      descent: 293,
      regular: face('a'),
      bold: face('b'),
      italic: face('c'),
      boldItalic: face('d'),
      licence: 'OFL-1.1',
    },
    {
      name: 'Noto Sans',
      lineHeight: 1362,
      regular: face('e'),
      bold: face('f'),
      italic: face('1'),
      boldItalic: face('2'),
      licence: 'OFL-1.1',
    },
  ],
  math: {
    name: 'STIX Two Math',
    file: `${'9'.repeat(64)}.otf`,
    sha256: '9'.repeat(64),
    licence: 'OFL-1.1',
  },
  defaultFamily: 'Noto Serif',
};

export const CLASS_FILES = { 'docedit.cls': '% class\n', 'docedit.lua': '-- lua\n' };

export type J = Record<string, unknown>;

export interface DocParts {
  settings?: J;
  styles?: J[];
  numberings?: J[];
  pageSetups?: J[];
  sources?: J[];
  stories?: J[];
  requires?: string[];
}

export const NORMAL: J = {
  type: 'style_def',
  attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
};

/** A document with the given body; `Normal` and page setup `ps1` are always defined. */
export function doc(body: unknown[], parts: DocParts = {}): CdmEnvelope {
  const styles = parts.styles ?? [];
  const hasNormal = styles.some((s) => (s['attrs'] as J | undefined)?.['id'] === 'Normal');
  return {
    cdm: 1,
    requires: parts.requires ?? [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal', ...parts.settings },
            },
            ...(hasNormal ? [] : [NORMAL]),
            ...styles,
            ...(parts.numberings ?? []),
            ...(parts.pageSetups ?? [{ type: 'page_setup', attrs: { id: 'ps1' } }]),
            ...(parts.sources ?? []),
          ],
        },
        ...(parts.stories ?? []),
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  } as unknown as CdmEnvelope;
}

let counter = 0;
/** A fresh node identifier (16 characters of the URL-safe alphabet). */
export function nid(prefix = 'n'): string {
  counter++;
  return `${prefix}${String(counter).padStart(15 - prefix.length + 1, '0')}`.slice(0, 16);
}

export function para(text: string, attrs: J = {}, extra: unknown[] = []): J {
  return {
    type: 'paragraph',
    attrs: { id: nid('p'), ...attrs },
    content: [...(text ? [{ type: 'text', text }] : []), ...extra],
  };
}

export function run(envelope: CdmEnvelope, options: Partial<ConvertOptions> = {}): Promise<Bundle> {
  return convert(envelope, { fonts: FONTS, classFiles: CLASS_FILES, ...options });
}

/** The lines of main.tex that belong to a block id, through map.json. */
export function blockLines(b: Bundle, id: string): string[] {
  const n = b.map.blocks.indexOf(id);
  if (n < 0) return [];
  const lines = b.files['main.tex']!.split('\n');
  const out: string[] = [];
  for (const r of b.map.lines)
    if (r.block === n) for (let l = r.from; l <= r.to; l++) out.push(lines[l - 1]!);
  return out;
}

export function codes(b: Bundle): string[] {
  return b.diagnostics.map((d) => d.code);
}

/** Decodes the hex of every `\DEstr{...}` in a string. */
export function decodeStrings(s: string): string {
  return s.replace(/\\DEstr\{([0-9A-F]*)\}/g, (_m, hex: string) =>
    new TextDecoder().decode(new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)))),
  );
}
