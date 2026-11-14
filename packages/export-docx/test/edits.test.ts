/**
 * SPK-028, R1 of ADR 0017 on every corpus file, with the scripted edits: typing in a paragraph,
 * splitting it, deleting a block, changing a paragraph's style and moving a preserved atom. Parts
 * no edit reaches stay byte-identical, blocks and gaps outside the edit stay canonically equal and
 * in place, and edited blocks keep their unmodelled properties and content (src/conformance.ts).
 *
 * The stress test regenerates every paragraph of the body from the model and its preserved data,
 * as if every one had been edited, and checks R1 (c) and (d) for all of them.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '@docedit/model/validate';
import { checkR1, everyParagraph, exportDocx, importDocx, scriptedEdits } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const files = corpusFiles();
const EDITS = ['type', 'split', 'delete', 'restyle', 'move atom'] as const;

describe.each(files)('$name', (file) => {
  it.for(EDITS)(
    'passes R1 after the edit "%s" (or records why it does not apply)',
    async (name, { annotate }) => {
      const bytes = readFile(file);
      const imported = await importDocx(bytes);
      const edit = scriptedEdits(imported.envelope, imported.sourceMap, imported.assets).find(
        (e) => e.name === name,
      )!;
      if ('skipped' in edit) {
        await annotate(`not applicable: ${edit.skipped}`);
        return;
      }
      // The edited document is still a valid CDM document.
      expect(validate(edit.envelope, { attachedAssets: imported.assets.ids() }).violations).toEqual(
        [],
      );
      const out = await exportDocx(edit.envelope, bytes, imported.sourceMap, imported.assets);
      const r1 = checkR1(bytes, out.bytes, imported.sourceMap, edit.edit);
      expect(r1.violations).toEqual([]);
    },
  );

  it('passes R1 (c) and (d) when every paragraph is regenerated', async () => {
    const bytes = readFile(file);
    const imported = await importDocx(bytes);
    const edit = everyParagraph(imported.envelope, imported.sourceMap);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets, {
      regenerate: new Set(edit.edited),
    });
    expect(out.regenerated.length).toBeGreaterThanOrEqual(edit.edited.length);
    expect(checkR1(bytes, out.bytes, imported.sourceMap, edit).violations).toEqual([]);
  });
});
