/**
 * FE-128 criterion 3 (lane V-FE-113-128, round 6): a `lang` mark set through the engine reaches the
 * proofing request builder, which sends the mark's tag and falls back to the document default.
 *
 * This is the chain as far as the modules go: the engine's command (Node.js, no DOM), then the
 * block's `lang` read from the document, then `proofingRequest` (UX-041, `packages/ui/src/proofing/
 * request.ts`, imported by a relative path because this package does not depend on `ui`). The
 * request that reaches the port itself is tested in `ux-041-proofing.test.ts` ('sends the language
 * of the lang mark'), through `core.attachProofing`; that test, with this one, is the evidence for
 * criterion 3.
 */
import { loadProofing } from '../src/core.ts';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { proofingRequest, type ProofingBlock } from '../../ui/src/proofing/request.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

// The proofing controller is a chunk of its own (UX-070); load it so that attaching a port is synchronous.
await loadProofing();

const PARA = STYLE_IDS.plain;
const PLAIN_LENGTH = 'Plain text'.length;

function core(): DocumentCore {
  return new DocumentCore({
    doc: styledDocument(),
    access: styledEditorAccess(),
    schedule: microtask,
  });
}

/** Selects the whole text of the paragraph 'Plain text' of the styled fixture. */
function selectParagraph(c: DocumentCore): void {
  const i = internals(c);
  const start = posOf(i.state.doc, PARA) + 1;
  i.dispatch(
    i.state.tr.setSelection(TextSelection.create(i.state.doc, start, start + PLAIN_LENGTH)),
  );
}

/** The paragraph as a proofing block: its text and the `lang` mark value over that text, if any. */
function blockOf(doc: PMNode): ProofingBlock {
  let found: PMNode | null = null;
  doc.descendants((node) => {
    if (found === null && node.type.name === 'paragraph' && node.attrs['id'] === PARA) found = node;
    return found === null;
  });
  if (found === null) throw new Error('the fixture paragraph is missing');
  const paragraph: PMNode = found;
  let lang: string | null = null;
  paragraph.descendants((node) => {
    if (node.isText && lang === null) {
      const mark = node.marks.find((m) => m.type.name === 'lang');
      if (mark) lang = String(mark.attrs['value']);
    }
    return true;
  });
  return { id: PARA, scope: 'body', text: paragraph.textContent, lang };
}

describe('FE-128 criterion 3: the lang mark reaches the proofing request', () => {
  it('a language set on a paragraph is the tag the proofing request sends', () => {
    const c = core();
    selectParagraph(c);
    expect(c.run('lang', { lang: 'fr-FR' })).toBe(true);

    const block = blockOf(internals(c).state.doc);
    expect(block.lang).toBe('fr-FR');
    const request = proofingRequest([block], () => true, 'en-GB');
    expect(request.items).toEqual([{ id: PARA, lang: 'fr-FR', text: 'Plain text' }]);
  });

  it('a paragraph without a lang mark falls back to the document language', () => {
    const c = core();
    const block = blockOf(internals(c).state.doc);
    expect(block.lang).toBeNull();
    const request = proofingRequest([block], () => true, 'en-GB');
    expect(request.items[0]?.lang).toBe('en-GB');
  });
});
