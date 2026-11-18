/**
 * SEC-039 criterion 4, under owner decision A2 (ADR 0017) and 10 section 3.5 as edited (E22): an
 * embedded object is not dropped. It is kept as opaque preserved content, never parsed, run, rendered
 * or fetched, and the import report lists it as preserved. This file proves that behaviour on a real
 * Word file with an embedded document (the POI corpus file `EmbeddedDocument.docx`).
 *
 * The criterion as written ("dropped, with a warning") contradicts A2, so it stays unticked until the
 * owner confirms the reworded criterion proposed in docs/adr/0256 (item 1) and in the story's Notes.
 * The importer has no option that lets a tenant strip preserved objects (SR-M18), so that half of
 * the proposed wording is not built and not tested here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importDocx } from '../../../packages/export-docx/src/index.ts';

const FILE = fileURLToPath(
  new URL('../../../packages/export-docx/corpus/poi/EmbeddedDocument.docx', import.meta.url),
);

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}
const atoms = (n: Node, label: string, out: Node[] = []): Node[] => {
  if (n.type.startsWith('preserved') && n.attrs?.['label'] === label) out.push(n);
  for (const c of n.content ?? []) atoms(c, label, out);
  return out;
};

afterEach(() => vi.unstubAllGlobals());

describe('SEC-039 criterion 4 (A2 reading): embedded objects are preserved, not dropped', () => {
  it('keeps each embedded object as a preserved atom and reports it as preserved, never as dropped', async () => {
    const imported = await importDocx(new Uint8Array(readFileSync(FILE)));
    expect(
      atoms(imported.envelope.doc as unknown as Node, 'embedded object').length,
    ).toBeGreaterThan(0);
    const lines = imported.report.filter((r) => r.kind === 'embedded object');
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ action: 'preserved', message: 'preserved, not editable' });
    expect(lines[0]!.count).toBeGreaterThan(0);
    expect(
      imported.report.some((r) => r.action === 'dropped' && r.kind === 'embedded object'),
    ).toBe(false);
  });

  it('makes no network request while importing a file with an embedded object', async () => {
    const calls: string[] = [];
    const refuse = (name: string) =>
      vi.fn(() => {
        calls.push(name);
        throw new Error(`${name} must not be used by the importer`);
      });
    vi.stubGlobal('fetch', refuse('fetch'));
    vi.stubGlobal('XMLHttpRequest', refuse('XMLHttpRequest'));
    vi.stubGlobal('WebSocket', refuse('WebSocket'));
    await importDocx(new Uint8Array(readFileSync(FILE)));
    expect(calls).toEqual([]);
  });
});
