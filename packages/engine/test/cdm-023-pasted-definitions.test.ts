/**
 * Pasted definitions map onto the target's (CDM-023; 03 §4.1; review M-16). The paste of the editing
 * core goes through `buildFragment`, which calls the model's `mapPastedDefinitions`: these tests
 * paste through the clipboard path (`pasteFromClipboard`) and read the document that results.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmFragment } from '../src/api.ts';
import { clipboardPayload } from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };

const level = { format: 'decimal', text: '%1.', start: 1 };

/** The styled fixture with one numbering definition, `Num1`. */
function target(): CdmEnvelope {
  const env = structuredClone(styledDocument()) as unknown as { doc: Json };
  const defs = env.doc.content!.find((c) => c.type === 'defs')!;
  const at = defs.content!.findIndex((c) => c.type === 'page_setup');
  defs.content!.splice(at, 0, { type: 'numbering_def', attrs: { id: 'Num1', levels: [level] } });
  return env as unknown as CdmEnvelope;
}

function caretAt(core: DocumentCore, id: string): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at)));
}

/** The validator's findings as `code:nodeId`. */
const problems = (core: DocumentCore): string[] =>
  validate(core.getContent()).violations.map((v) => `${v.code}:${String(v.nodeId)}`);

/**
 * What the validator finds in the fixture before any paste: its `Quote` and `Emphasis` styles use
 * reserved identifiers without `builtIn` (I11). A paste must add nothing to this.
 */
const FIXTURE_PROBLEMS = ['reserved_style_id:Quote', 'reserved_style_id:Emphasis'];

const defsJson = (doc: PMNode): Json[] => (doc.firstChild!.toJSON() as Json).content ?? [];

/** The pasted paragraph with the given text. */
function paragraphWith(doc: PMNode, text: string): PMNode {
  let found: PMNode | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'paragraph' && n.textContent === text) found = n;
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

const fragment = (defs: Json[], content: Json[]): CdmFragment =>
  ({ cdm: 1, requires: [], defs, content, openStart: 0, openEnd: 0 }) as CdmFragment;

const paste = (core: DocumentCore, f: CdmFragment) =>
  core.pasteFromClipboard({ html: clipboardPayload(f)['text/html'] });

describe('pasted definitions map onto the target document (CDM-023)', () => {
  it('refers to the existing style and numbering definitions and inserts no second one', () => {
    const core = new DocumentCore({ doc: target(), schedule: microtask });
    const before = defsJson(internals(core).state.doc);
    caretAt(core, STYLE_IDS.after);
    const result = paste(
      core,
      fragment(
        [
          // The source's definitions differ from the target's under the same identifiers.
          {
            type: 'style_def',
            attrs: { id: 'Quote', kind: 'paragraph', name: 'Source quote', italic: true },
          },
          {
            type: 'numbering_def',
            attrs: { id: 'Num1', levels: [{ format: 'upperRoman', text: '(%1)', start: 5 }] },
          },
          // The same definition brought twice.
          {
            type: 'numbering_def',
            attrs: { id: 'Num1', levels: [{ format: 'lowerLetter', text: '%1)', start: 1 }] },
          },
        ],
        [
          {
            type: 'paragraph',
            attrs: {
              id: 'pSource000000001',
              style: 'Quote',
              numbering: { numberingId: 'Num1', level: 0, listId: 'LSrc000000000001' },
            },
            content: [{ type: 'text', text: 'Pasted quote' }],
          },
        ],
      ),
    );
    expect(result).toEqual({ ok: true });
    const doc = internals(core).state.doc;
    // The definitions are the target's own, each once, unchanged.
    expect(defsJson(doc)).toEqual(before);
    const pasted = paragraphWith(doc, 'Pasted quote');
    expect(pasted.attrs['style']).toBe('Quote');
    expect((pasted.attrs['numbering'] as { numberingId: string }).numberingId).toBe('Num1');
    expect(problems(core)).toEqual(FIXTURE_PROBLEMS);
  });

  it('keeps the target definition of a built-in identifier that differs in the source', () => {
    const core = new DocumentCore({ doc: target(), schedule: microtask });
    const heading = () =>
      defsJson(internals(core).state.doc).filter((d) => d.attrs?.['id'] === 'Heading1');
    const before = heading();
    expect(before).toHaveLength(1);
    caretAt(core, STYLE_IDS.after);
    const result = paste(
      core,
      fragment(
        [
          {
            type: 'style_def',
            attrs: {
              id: 'Heading1',
              kind: 'paragraph',
              name: 'Heading 1',
              builtIn: true,
              fontSize: 640,
              color: '#FF0000',
              outlineLevel: 3,
            },
          },
        ],
        [
          {
            type: 'paragraph',
            attrs: { id: 'pSource000000002', style: 'Heading1' },
            content: [{ type: 'text', text: 'Pasted title' }],
          },
        ],
      ),
    );
    expect(result).toEqual({ ok: true });
    const doc = internals(core).state.doc;
    // The pasted paragraph names Heading1, and the only Heading1 is the target's: its look applies.
    expect(heading()).toEqual(before);
    expect(paragraphWith(doc, 'Pasted title').attrs['style']).toBe('Heading1');
    expect(problems(core)).toEqual(FIXTURE_PROBLEMS);
  });

  it('leaves no unresolved reference and no duplicate identifier in the merged document', () => {
    const core = new DocumentCore({ doc: target(), schedule: microtask });
    caretAt(core, STYLE_IDS.after);
    const result = paste(
      core,
      fragment(
        [
          // A new definition whose basedOn and next resolve nowhere, and one that resolves.
          {
            type: 'style_def',
            attrs: {
              id: 'Brought',
              kind: 'paragraph',
              name: 'Brought',
              basedOn: 'Gone',
              next: 'Gone',
              numbering: { numberingId: 'NumGone', level: 0, listId: 'LGone00000000001' },
            },
          },
          {
            type: 'style_def',
            attrs: { id: 'BroughtChild', kind: 'paragraph', name: 'Child', basedOn: 'Brought' },
          },
        ],
        [
          {
            type: 'paragraph',
            attrs: {
              id: 'pSource000000003',
              style: 'Gone',
              numbering: { numberingId: 'NumGone', level: 0, listId: 'LGone00000000002' },
            },
            content: [
              {
                type: 'text',
                text: 'No style here',
                marks: [{ type: 'charStyle', attrs: { style: 'CharGone' } }],
              },
            ],
          },
          {
            type: 'paragraph',
            attrs: { id: 'pSource000000004', style: 'BroughtChild' },
            content: [{ type: 'text', text: 'Brought style' }],
          },
          // The identifier of a block the target has: the copy gets a fresh one (I2).
          {
            type: 'paragraph',
            attrs: { id: STYLE_IDS.plain, style: null },
            content: [{ type: 'text', text: 'Same identifier' }],
          },
        ],
      ),
    );
    expect(result).toEqual({ ok: true });
    const doc = internals(core).state.doc;
    const ids = defsJson(doc).map((d) => `${d.type}:${String(d.attrs?.['id'])}`);
    expect(ids).toContain('style_def:Brought');
    expect(ids).toContain('style_def:BroughtChild');
    expect(new Set(ids).size).toBe(ids.length);
    const brought = defsJson(doc).find((d) => d.attrs?.['id'] === 'Brought')!;
    expect(brought.attrs!['basedOn']).toBeNull();
    expect(brought.attrs!['next']).toBeNull();
    expect(brought.attrs!['numbering']).toBeNull();
    const unstyled = paragraphWith(doc, 'No style here');
    expect(unstyled.attrs['style']).toBeNull();
    expect(unstyled.attrs['numbering']).toBeNull();
    expect(unstyled.firstChild!.marks).toEqual([]);
    expect(paragraphWith(doc, 'Brought style').attrs['style']).toBe('BroughtChild');
    expect(paragraphWith(doc, 'Same identifier').attrs['id']).not.toBe(STYLE_IDS.plain);
    // I4 (no unresolved reference) and I2 (unique identifiers) hold: the validator finds nothing.
    expect(problems(core)).toEqual(FIXTURE_PROBLEMS);
  });
});
