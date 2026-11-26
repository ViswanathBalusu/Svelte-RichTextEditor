/**
 * UX-057: inline custom content through the extension document API (`insertExtensionInline`;
 * src/extension-api.ts). Criterion 1 (the node is created with the extension, the payload and
 * mandatory fallback text; one without text is refused), 2 (the node is an atom: stepped over and
 * removed as one unit) and 3 (the view shows the fallback text of an extension that is not
 * registered). The writers' half of criterion 4 is in the export packages' ux-057 tests.
 */
import { validate } from '@docedit/model/validate';
import { deleteSelection } from 'prosemirror-commands';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentCore, type ExtInlineDraft } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';
import { loadParts } from '../src/parts.ts';

beforeAll(() => loadParts(['extension']));

const DRAFT: ExtInlineDraft = {
  extension: 'com.example.mention',
  payload: { user: 'u-17' },
  fallbackText: '@Ada Lovelace',
};

function setup() {
  const core = new DocumentCore({
    doc: { ...spikeDocument(), requires: [...spikeDocument().requires] },
    schedule: microtask,
  });
  const api = core.extensionApi({ maxRanges: 8, later: () => undefined });
  const state = () => internals(core).state;
  /** A caret after "Alpha" in the first paragraph. */
  const caret = () => {
    const at = posOf(state().doc, SPIKE_IDS.intro) + 1 + 5;
    return api.range(at, at);
  };
  const inlines = () => {
    const found: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
    state().doc.descendants((n, pos) => {
      if (n.type.name === 'extension_inline') found.push({ pos, attrs: n.attrs });
      return true;
    });
    return found;
  };
  return { core, api, state, caret, inlines };
}

describe('UX-057 criterion 1: inserting creates an extension_inline with mandatory fallback text', () => {
  it('creates the node with the extension, the payload and the fallback text, and the document stays valid', () => {
    const { core, api, caret, inlines } = setup();
    const result = api.insertExtensionInline(caret(), DRAFT);
    expect(result).toEqual({ ok: true });
    const [node] = inlines();
    expect(node!.attrs).toMatchObject({
      extension: 'com.example.mention',
      payload: { user: 'u-17' },
      fallbackText: '@Ada Lovelace',
    });
    expect(core.requires).toContain('extensions');
    expect(validate(core.getContent()).violations).toEqual([]);
  });

  it.each([
    ['no fallback text', { extension: 'x.y', payload: {} }],
    ['an empty fallback text', { extension: 'x.y', payload: {}, fallbackText: '' }],
    ['a blank fallback text', { extension: 'x.y', payload: {}, fallbackText: '   ' }],
    ['a null fallback text', { extension: 'x.y', payload: {}, fallbackText: null }],
  ])('refuses %s before anything is sent', (_name, draft) => {
    const { api, state, caret, inlines } = setup();
    const doc = state().doc;
    expect(api.insertExtensionInline(caret(), draft as unknown as ExtInlineDraft)).toMatchObject({
      ok: false,
      reason: 'no_fallback',
    });
    expect(state().doc).toBe(doc);
    expect(inlines()).toHaveLength(0);
  });

  it('refuses content without an extension name or with a payload that is not JSON', () => {
    const { api, caret } = setup();
    expect(api.insertExtensionInline(caret(), { ...DRAFT, extension: ' ' })).toMatchObject({
      ok: false,
      reason: 'no_extension',
    });
    expect(api.insertExtensionInline(caret(), { ...DRAFT, payload: 1n })).toMatchObject({
      ok: false,
      reason: 'payload_not_json',
    });
  });

  it("applies the model's 4 KiB limit before sending (the owner has set no other: decision 176)", () => {
    const { api, state, caret, inlines } = setup();
    // The JSON text of a string adds two quotes.
    expect(api.insertExtensionInline(caret(), { ...DRAFT, payload: 'a'.repeat(4094) }).ok).toBe(
      true,
    );
    const doc = state().doc;
    expect(
      api.insertExtensionInline(caret(), { ...DRAFT, payload: 'a'.repeat(4095) }),
    ).toMatchObject({ ok: false, reason: 'payload_too_large' });
    expect(state().doc).toBe(doc);
    expect(inlines()).toHaveLength(1);
  });
});

describe('UX-057 criterion 2: the node is an atom, stepped over and removed as one unit', () => {
  it('is an inline leaf of size one with no editable content', () => {
    const { api, state, caret, inlines } = setup();
    api.insertExtensionInline(caret(), DRAFT);
    const node = state().doc.nodeAt(inlines()[0]!.pos)!;
    expect(node.isInline).toBe(true);
    expect(node.isAtom).toBe(true);
    expect(node.isLeaf).toBe(true);
    expect(node.nodeSize).toBe(1);
  });

  it('is one position of the text: the caret sits before or after it, never inside, and it can be selected whole', () => {
    const { core, api, state, caret, inlines } = setup();
    api.insertExtensionInline(caret(), DRAFT);
    const pos = inlines()[0]!.pos;
    const doc = state().doc;
    expect(doc.resolve(pos).nodeAfter?.type.name).toBe('extension_inline');
    expect(doc.resolve(pos + 1).nodeBefore?.type.name).toBe('extension_inline');
    expect(NodeSelection.isSelectable(doc.nodeAt(pos)!)).toBe(true);
    // A text selection can stand on each side of it; the position between does not exist.
    for (const at of [pos, pos + 1]) {
      internals(core).dispatch(state().tr.setSelection(TextSelection.create(state().doc, at)));
      expect(state().selection.empty).toBe(true);
    }
    expect(core.selection.get().empty).toBe(true);
  });

  it('is removed as one unit when it is selected and deleted, and the text beside it stays', () => {
    const { core, api, state, caret, inlines } = setup();
    api.insertExtensionInline(caret(), DRAFT);
    const pos = inlines()[0]!.pos;
    internals(core).dispatch(state().tr.setSelection(NodeSelection.create(state().doc, pos)));
    expect(core.selection.get().empty).toBe(false);
    const dispatch = (tr: ReturnType<typeof state>['tr']) => internals(core).dispatch(tr);
    expect(deleteSelection(state(), dispatch)).toBe(true);
    expect(inlines()).toHaveLength(0);
    expect(state().doc.textContent).toContain('Alpha bravo charlie');
  });

  it('removes with a range delete that covers it, as one unit', () => {
    const { api, state, caret, inlines } = setup();
    api.insertExtensionInline(caret(), DRAFT);
    const pos = inlines()[0]!.pos;
    expect(api.deleteRange(api.range(pos - 2, pos + 3))).toEqual({ ok: true });
    expect(inlines()).toHaveLength(0);
    expect(state().doc.textContent).toContain('Alp');
  });
});

describe('UX-057 criterion 3: the fallback text is shown when the extension is not registered', () => {
  it('draws the fallback text as the node, with no payload', () => {
    const { api, state, caret, inlines } = setup();
    api.insertExtensionInline(caret(), DRAFT);
    const node = state().doc.nodeAt(inlines()[0]!.pos)!;
    const spec = node.type.spec.toDOM!(node) as unknown as [
      string,
      Record<string, string>,
      ...unknown[],
    ];
    expect(spec[0]).toBe('span');
    expect(spec[1]).toMatchObject({
      class: 'de-extension de-extension-inline',
      'data-extension': 'com.example.mention',
    });
    expect(spec[1]).not.toHaveProperty('role');
    expect(spec[1]).not.toHaveProperty('aria-hidden');
    expect(spec.slice(2)).toEqual(['@Ada Lovelace']);
    expect(JSON.stringify(spec)).not.toContain('u-17');
  });
});
