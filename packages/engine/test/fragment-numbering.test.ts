/**
 * A copied fragment carries the numbering definitions its content and its styles reference (FE-050
 * criterion 3; 03 §4.1, CDM-040, CDM-042). A numbering definition nothing references is not copied.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { fragmentFromHtml } from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };

const level = { format: 'decimal', text: '%1.', start: 1 };
const numberingDef = (id: string) => ({
  type: 'numbering_def',
  attrs: { id, levels: [level] },
});

/**
 * The styled fixture with two numbering definitions: `Num1` is referenced by the heading paragraph
 * (a block's `numbering`), `Num2` by the Heading 1 style (a style's `numbering`), and `Unused` by
 * nothing.
 */
function numberedDocument() {
  const env = structuredClone(styledDocument()) as unknown as {
    cdm: number;
    requires: string[];
    doc: Json;
  };
  const defs = env.doc.content!.find((c) => c.type === 'defs')!;
  // CDM-019 order: settings, styles, numbering, page setups, and the rest.
  const firstPageSetup = defs.content!.findIndex((c) => c.type === 'page_setup');
  defs.content!.splice(
    firstPageSetup,
    0,
    numberingDef('Num1'),
    numberingDef('Num2'),
    numberingDef('Unused'),
  );
  const heading1 = defs.content!.find((c) => c.attrs?.['id'] === 'Heading1')!;
  heading1.attrs!['numbering'] = { numberingId: 'Num2', level: 0, listId: 'LHead' };
  const body = env.doc.content!.find((c) => c.type === 'body')!;
  const para = body.content!.find((c) => c.attrs?.['id'] === STYLE_IDS.heading)!;
  para.attrs!['numbering'] = { numberingId: 'Num1', level: 0, listId: 'LNum1' };
  return env;
}

/** Selects the whole block id, so that the copied slice holds the paragraph and not only its text. */
function selectBlock(core: DocumentCore, id: string): void {
  const i = internals(core);
  const from = posOf(i.state.doc, id);
  const node = i.state.doc.nodeAt(from)!;
  i.dispatch(
    i.state.tr.setSelection(TextSelection.create(i.state.doc, from, from + node.nodeSize)),
  );
}

const numberingIds = (defs: readonly { type: string; attrs?: unknown }[]) =>
  defs
    .filter((d) => d.type === 'numbering_def')
    .map((d) => (d.attrs as { id: string }).id)
    .sort();

describe('a copied fragment carries its numbering definitions (FE-050 criterion 3)', () => {
  it('includes the numbering a copied block references and no unreferenced definition', () => {
    const core = new DocumentCore({ doc: numberedDocument(), schedule: microtask });
    selectBlock(core, STYLE_IDS.heading);
    const payload = core.copySelection();
    expect(payload).not.toBeNull();
    const fragment = fragmentFromHtml(payload!['text/html']);
    expect(fragment).not.toBeNull();
    const ids = numberingIds(fragment!.defs as { type: string; attrs?: unknown }[]);
    expect(ids).toContain('Num1');
    expect(ids).not.toContain('Unused');
  });

  it('includes the numbering a referenced style carries, as the style closure does', () => {
    const core = new DocumentCore({ doc: numberedDocument(), schedule: microtask });
    selectBlock(core, STYLE_IDS.heading);
    const fragment = fragmentFromHtml(core.copySelection()!['text/html']);
    const ids = numberingIds(fragment!.defs as { type: string; attrs?: unknown }[]);
    // The heading paragraph's Heading 1 style is copied with its numbering Num2.
    expect(ids).toContain('Num2');
  });

  it('copies the definition with its levels, not a reference to the live document', () => {
    const core = new DocumentCore({ doc: numberedDocument(), schedule: microtask });
    selectBlock(core, STYLE_IDS.heading);
    const fragment = fragmentFromHtml(core.copySelection()!['text/html']);
    const def = (
      fragment!.defs as { type: string; attrs: { id: string; levels: unknown[] } }[]
    ).find((d) => d.type === 'numbering_def' && d.attrs.id === 'Num1');
    expect(def?.attrs.levels).toEqual([level]);
  });
});
