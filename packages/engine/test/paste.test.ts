/**
 * Plain-text paste (02 §5.2; FE-052), run on the headless core: the text is inserted at the
 * selection with the formatting at the caret, each line break starts a paragraph in the same scope
 * with a fresh identifier, and a selection the user may not change refuses the paste whole.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';

function core(doc = styledDocument()): DocumentCore {
  return new DocumentCore({ doc, access: styledEditorAccess() });
}

/** The position just after the content of the node with identifier `id`. */
function endOf(doc: PMNode, id: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.attrs['id'] === id) at = pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

/** Puts the caret at `pos` through the core's own state (the test instrumentation). */
function caretAt(c: DocumentCore, pos: number): void {
  const ic = internals(c);
  ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, pos)));
}

/** The paragraphs that are direct children of the body, in order, with their identifiers. */
function bodyParagraphs(doc: PMNode): Array<{ id: unknown; text: string }> {
  const body = doc.lastChild!;
  const out: Array<{ id: unknown; text: string }> = [];
  body.forEach((child) => {
    if (child.type.name === 'paragraph')
      out.push({ id: child.attrs['id'], text: child.textContent });
  });
  return out;
}

describe('plain-text paste (FE-052)', () => {
  it('the pasted text takes the formatting at the caret', () => {
    const env = styledDocument();
    const doc = structuredClone(env.doc) as {
      content: Array<{ content?: Array<{ content?: unknown[] }> }>;
    };
    const paragraph = doc.content[1]!.content![0] as { content: unknown[] };
    paragraph.content = [
      { type: 'text', text: 'Plain ' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold', attrs: { value: true } }] },
    ];
    const c = core({ ...env, doc: doc as never });
    const ic = internals(c);
    // The caret at the end of the heading paragraph follows the bold run that ends it.
    caretAt(c, endOf(ic.state.doc, STYLE_IDS.heading));
    expect(c.pastePlainText('more')).toBe(true);
    const more = [] as string[];
    ic.state.doc.descendants((node) => {
      if (node.isText && node.text!.includes('more'))
        more.push(...node.marks.map((m) => m.type.name));
    });
    expect(more).toContain('bold');
    expect(ic.state.doc.textContent).toContain('boldmore');
    c.destroy();
  });

  it('each line break starts a paragraph in the same scope, with a fresh identifier', () => {
    const c = core();
    const ic = internals(c);
    caretAt(c, endOf(ic.state.doc, STYLE_IDS.plain));
    expect(c.pastePlainText('one\ntwo\r\nthree')).toBe(true);
    const paragraphs = bodyParagraphs(internals(c).state.doc);
    const texts = paragraphs.map((p) => p.text);
    // The first line joins the paragraph at the caret; the next two are new body paragraphs.
    expect(texts).toEqual([
      'Introduction',
      'A quotation',
      'Plain textone',
      'two',
      'three',
      'After the region',
    ]);
    const ids = paragraphs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(3, 5).every((id) => id !== STYLE_IDS.plain && typeof id === 'string')).toBe(
      true,
    );
    // The new paragraphs are body paragraphs, and the region after them is unchanged.
    const body = internals(c).state.doc.lastChild!;
    const region = [...Array(body.childCount).keys()]
      .map((i) => body.child(i))
      .find((n) => n.type.name === 'region');
    expect(region?.textContent).toBe('Protected text');
    c.destroy();
  });

  it('an empty line in the middle makes an empty paragraph', () => {
    const c = core();
    const ic = internals(c);
    const plain = endOf(ic.state.doc, STYLE_IDS.plain);
    caretAt(c, plain);
    expect(c.pastePlainText('a\n\nb')).toBe(true);
    expect(bodyParagraphs(internals(c).state.doc).map((p) => p.text)).toEqual(
      expect.arrayContaining(['Plain texta', '', 'b']),
    );
    c.destroy();
  });

  it('a selection in a scope the user may not change refuses the whole paste', () => {
    const c = core();
    const ic = internals(c);
    caretAt(c, endOf(ic.state.doc, STYLE_IDS.inRegion));
    const before = c.getContent();
    expect(c.pastePlainText('x\ny')).toBe(false);
    expect(c.getContent()).toEqual(before);
    expect(c.refusal.get()).toEqual({
      n: 1,
      reason: 'scope',
      scopes: [`region:${STYLE_IDS.region}`],
    });
    c.destroy();
  });
});
