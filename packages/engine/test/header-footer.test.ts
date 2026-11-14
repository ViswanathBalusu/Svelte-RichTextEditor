/**
 * Header and footer variants and the page-number field in the headless core (FE-057 criteria 1 to
 * 3; 03 §4.1, §4.4). The panel's tabs, focus and keyboard are the view's and are not tested here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { StepMap } from 'prosemirror-transform';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import {
  createVariantStory,
  insertPageNumber,
  storyOfVariant,
  variantsInUse,
} from '../src/header-footer.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { editorAccess, ownerAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

const NEW_STORY = 'stHdrFirst000001';

function core(access = ownerAccess()): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
}

/** Sets an attribute of the page setup 'ps1' through the core (the guard decides). */
function setupAttr(c: DocumentCore, name: string, value: unknown): void {
  const i = internals(c);
  i.dispatch(i.state.tr.setNodeAttribute(posOf(i.state.doc, 'ps1'), name, value));
}

/** The page setup 'ps1' as it stands in the core's document. */
function pageSetup(c: DocumentCore): PMNode {
  let found: PMNode | null = null;
  internals(c).state.doc.descendants((n) => {
    if (n.type.name === 'page_setup' && n.attrs['id'] === 'ps1') found = n;
    return found === null;
  });
  return found!;
}

/** Number of page fields in the document. */
function pageFields(c: DocumentCore): number {
  let n = 0;
  internals(c).state.doc.descendants((node) => {
    if (node.type.name === 'field' && node.attrs['kind'] === 'page') n++;
    return true;
  });
  return n;
}

describe('the variants a page setup uses (FE-057 criterion 1)', () => {
  it('offers the default variant, and the first-page and even variants when their flags are on', () => {
    const c = core();
    expect(variantsInUse(pageSetup(c))).toEqual(['default']);
    const doc = internals(c).state.doc;
    expect(storyOfVariant(doc, 'ps1', 'header', 'default')).toBe(SPIKE_IDS.header);
    expect(storyOfVariant(doc, 'ps1', 'header', 'first')).toBeNull();

    setupAttr(c, 'differentFirstPage', true);
    setupAttr(c, 'differentOddEven', true);
    expect(variantsInUse(pageSetup(c))).toEqual(['default', 'first', 'even']);
  });

  it('the panel opens the story the variant names', () => {
    const c = core();
    const id = storyOfVariant(internals(c).state.doc, 'ps1', 'header', 'default')!;
    c.openStory(id);
    expect(c.panel.get()).toEqual({ kind: 'story', id: SPIKE_IDS.header, label: 'Header' });
  });
});

describe('a variant without a story gets one through the guard (FE-057 criterion 2)', () => {
  it('creates a header story before the body, with one paragraph, and names it in the page setup', () => {
    const c = core();
    setupAttr(c, 'differentFirstPage', true);
    const i = internals(c);
    const tr = createVariantStory(i.state, 'ps1', 'header', 'first', NEW_STORY);
    expect(tr).not.toBeNull();
    i.dispatch(tr!);

    const doc = internals(c).state.doc;
    expect(storyOfVariant(doc, 'ps1', 'header', 'first')).toBe(NEW_STORY);
    const order: string[] = [];
    doc.forEach((child) => order.push(child.type.name));
    expect(order.indexOf('story')).toBeLessThan(order.indexOf('body'));
    const paragraphIds: unknown[] = [];
    doc.descendants((n) => {
      if (n.type.name === 'story' && n.attrs['id'] === NEW_STORY)
        n.forEach((p) => paragraphIds.push(p.attrs['id']));
      return true;
    });
    // One paragraph, and the identifier plugin filled its identifier in the same transaction.
    expect(paragraphIds).toHaveLength(1);
    expect(typeof paragraphIds[0]).toBe('string');
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('refuses the creation when the user may not change the structure', () => {
    const c = core(editorAccess());
    const i = internals(c);
    const before = i.state.doc;
    const tr = createVariantStory(i.state, 'ps1', 'header', 'first', NEW_STORY);
    expect(tr).not.toBeNull();
    i.dispatch(tr!);
    expect(internals(c).state.doc).toBe(before);
    expect(c.refusal.get()).not.toBeNull();
  });

  it('does not create a story for a variant that already has one', () => {
    const c = core();
    expect(
      createVariantStory(internals(c).state, 'ps1', 'header', 'default', NEW_STORY),
    ).toBeNull();
  });
});

describe('a page-number field is stored in the story (FE-057 criterion 3)', () => {
  it('inserts a page field into the header story and refuses it in the body', () => {
    const c = core();
    const before = pageFields(c);
    const { schema } = internals(c);
    const doc = internals(c).state.doc;
    const storyAt = posOf(doc, SPIKE_IDS.header);
    const story = doc.nodeAt(storyAt)!;

    // The sub-editor's document is the story itself (subeditor.ts): its selection is at the end of
    // the paragraph, and the command inserts the field there.
    const sub = EditorState.create({ doc: story });
    const subAtEnd = sub.apply(
      sub.tr.setSelection(TextSelection.create(sub.doc, sub.doc.content.size - 1)),
    );
    let tr: Transaction | undefined;
    expect(insertPageNumber(schema)(subAtEnd, (t) => (tr = t))).toBe(true);

    // The sub-editor forwards its steps to the document, offset to the story's content (subeditor.ts).
    const outer = internals(c).state.tr;
    for (const step of tr!.steps) {
      const mapped = step.map(StepMap.offset(storyAt + 1));
      expect(mapped).not.toBeNull();
      expect(outer.maybeStep(mapped!).failed).toBeNull();
    }
    internals(c).dispatch(outer);
    expect(pageFields(c)).toBe(before + 1);
    expect(validate(c.getContent()).violations).toEqual([]);

    // In the body the command is refused.
    const i = internals(c);
    const intro = posOf(i.state.doc, SPIKE_IDS.intro);
    const inBody = i.state.apply(
      i.state.tr.setSelection(
        TextSelection.create(i.state.doc, intro + i.state.doc.nodeAt(intro)!.nodeSize - 1),
      ),
    );
    expect(insertPageNumber(schema)(inBody)).toBe(false);
    expect(pageFields(c)).toBe(before + 1);
  });
});
