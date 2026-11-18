/**
 * Helpers for EXP-115 (Node.js only): the shared layout-semantics fixtures of `packages/model` run
 * against the LaTeX writer. A fixture case becomes a CDM document exactly as the `format` text of
 * its file says (the model's own test assembles it the same way), the converter writes it, the
 * house class compiles it with `lualatex` on this machine (`test/cdm-local-tex.ts`), and the text
 * or the layout of the PDF is compared with what the fixture expects.
 *
 * Every test name that uses these helpers starts with `[<fixture> x LaTeX]` so that a failure in CI
 * names the fixture and the writer (EXP-115 criterion 3).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CdmEnvelope } from '@docedit/model';

export type J = Record<string, unknown>;

/** The directory of the model's shared fixtures. */
export const SEMANTICS_DIR = fileURLToPath(
  new URL('../../model/fixtures/semantics/', import.meta.url),
);

/** A fixture file, parsed. */
export function loadSemantics<T>(name: string): T {
  return JSON.parse(readFileSync(join(SEMANTICS_DIR, `${name}.json`), 'utf8')) as T;
}

/** The names of the fixture files in the directory, without `.json`. */
export function semanticsFiles(): string[] {
  return readdirSync(SEMANTICS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

export interface DefsFile {
  settings?: J;
  styles?: J[];
  numberings?: J[];
}

export interface DocCase {
  id: string;
  description: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  stories?: J[];
  body?: J[];
}

function mergeById(base: readonly J[], extra: readonly J[]): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The document of a case, assembled as the `format` of the file says. */
export function documentOf(file: DefsFile, c: DocCase): CdmEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { ...file.settings, ...c.settings } },
            ...mergeById(file.styles ?? [], c.styles ?? []),
            ...mergeById(file.numberings ?? [], c.numberings ?? []),
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        ...(c.stories ?? []),
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: c.body ?? [] },
      ],
    },
  } as unknown as CdmEnvelope;
}

/** Every node of a tree, depth first, in document order. */
export function* nodesOf(n: unknown): Generator<J> {
  if (!n || typeof n !== 'object') return;
  const node = n as J;
  if (typeof node['type'] === 'string') yield node;
  const content = node['content'];
  if (Array.isArray(content)) for (const c of content) yield* nodesOf(c);
}

/** The node with the identifier `id` in the trees, or undefined. */
export function findById(trees: readonly unknown[], id: string): J | undefined {
  for (const t of trees)
    for (const n of nodesOf(t)) if ((n['attrs'] as J | undefined)?.['id'] === id) return n;
  return undefined;
}

/** The text nodes of a node, joined (fields and footnotes contribute nothing). */
export function plainText(n: unknown): string {
  const node = n as J;
  if (node['type'] === 'text') return String(node['text'] ?? '');
  if (node['type'] === 'footnote' || node['type'] === 'field') return '';
  const content = node['content'];
  return Array.isArray(content) ? content.map(plainText).join('') : '';
}

/** Collapses every run of white space (including no-break spaces) into one space. */
export function squash(s: string): string {
  return s.replace(/[\s\u00a0\u2007\u202f]+/g, ' ').trim();
}

/** The text of a PDF, from `pdftotext` (set `DOCEDIT_PDFTOTEXT` to its path when not on the PATH). */
export function pdfText(pdf: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-exp-115-text-'));
  const file = join(dir, 'in.pdf');
  writeFileSync(file, pdf);
  const bin = process.env['DOCEDIT_PDFTOTEXT'] ?? 'pdftotext';
  const r = spawnSync(bin, ['-raw', '-enc', 'UTF-8', '-nopgbrk', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext failed (set DOCEDIT_PDFTOTEXT)');
  return r.stdout;
}

/** Whether `pdftotext` starts here. */
export function pdftotextAvailable(): boolean {
  const r = spawnSync(process.env['DOCEDIT_PDFTOTEXT'] ?? 'pdftotext', ['-v'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return !r.error;
}

/**
 * Checks that every piece appears in the text, each after the one before. Returns the first piece
 * that does not, or null when all do. Both sides are squashed first.
 */
export function firstMissingInOrder(text: string, pieces: readonly string[]): string | null {
  const hay = squash(text);
  let from = 0;
  for (const piece of pieces) {
    const needle = squash(piece);
    if (needle === '') continue;
    const at = hay.indexOf(needle, from);
    if (at < 0) return piece;
    from = at + needle.length;
  }
  return null;
}

/** Runs `fn` over the items, at most `limit` at a time, and returns the results in item order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
