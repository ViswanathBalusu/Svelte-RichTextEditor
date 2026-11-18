/**
 * EXP-097: the importer of `packages/export-docx` (the "build" option) on one file. Prints one JSON
 * line: ok, parse time, peak resident memory, counts of what it recovered, and the text.
 */
import { readFileSync } from 'node:fs';
import { importDocx } from '../../../packages/export-docx/src/index.ts';

interface N {
  type: string;
  text?: string;
  marks?: { type: string; attrs?: { id?: string } }[];
  content?: N[];
}

const file = process.argv[2]!;
const bytes = new Uint8Array(readFileSync(file));
const t0 = performance.now();
let line: Record<string, unknown>;
try {
  const r = await importDocx(bytes);
  const ms = performance.now() - t0;
  const types: Record<string, number> = {};
  const revisions = new Set<string>();
  const paragraphs: string[] = [];
  let inBody = false;
  const walk = (n: N): void => {
    types[n.type] = (types[n.type] ?? 0) + 1;
    for (const m of n.marks ?? [])
      if ((m.type === 'ins' || m.type === 'del') && m.attrs?.id) revisions.add(m.attrs.id);
    if (n.type === 'body') inBody = true;
    if (n.type === 'paragraph' && inBody) {
      const parts: string[] = [];
      const collect = (c: N): void => {
        if (c.type === 'text' && c.text) parts.push(c.text);
        for (const k of c.content ?? []) collect(k);
      };
      collect(n);
      paragraphs.push(parts.join(''));
    }
    for (const c of n.content ?? []) walk(c);
    if (n.type === 'body') inBody = false;
  };
  walk(r.envelope.doc as unknown as N);
  line = {
    ok: true,
    ms,
    peakMb: process.resourceUsage().maxRSS / 1024,
    counts: {
      tables: types['table'] ?? 0,
      images: types['image'] ?? 0,
      tracked: revisions.size,
      comments: 0,
      footnotes: 0,
      hyperlinks: 0,
    },
    preservedAtoms: (types['preserved_inline'] ?? 0) + (types['preserved_block'] ?? 0),
    warnings: r.warnings.length,
    text: paragraphs.join('\n'),
  };
} catch (e) {
  line = {
    ok: false,
    ms: performance.now() - t0,
    peakMb: process.resourceUsage().maxRSS / 1024,
    error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 200),
  };
}
console.log(JSON.stringify(line));
