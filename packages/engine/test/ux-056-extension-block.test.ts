/**
 * UX-056: custom blocks through the extension document API (`insertExtensionBlock`,
 * `updateExtensionBlock`; src/extension-api.ts). Criteria 1 and 2 (the editor's half: refused before
 * anything is sent), 5 (an edit through the extension's own interface is an ordinary commit, under
 * the permissions of the scope) and 6 (the block is an atom with an accessible name). The authority's
 * half of criteria 2 and 3 is in packages/model/src/validate/blocks.test.ts and
 * packages/authority/test/room-scenarios.test.ts. The service here is the mock, which runs the real
 * room of @docedit/authority.
 */
import { validate } from '@docedit/model/validate';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore, type ExtBlockDraft } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, SPIKE_IDS, contractDocument, regionOnlyAccess, spikeDocument } from './fixtures.ts';
import { join, microtask, newService, posOf, until } from './support.ts';

const DRAFT: ExtBlockDraft = {
  extension: 'com.example.chart',
  payload: { kind: 'chart', series: [1, 2, 3] },
  fallbackText: 'A chart of three values',
};

function setup() {
  const core = new DocumentCore({
    doc: { ...spikeDocument(), requires: [...spikeDocument().requires] },
    schedule: microtask,
  });
  const api = core.extensionApi({ maxRanges: 8, later: () => undefined });
  const state = () => internals(core).state;
  const before = () => {
    const at = posOf(state().doc, SPIKE_IDS.intro);
    return api.range(at, at);
  };
  const blocks = () => {
    const found: Array<{ id: string; attrs: Record<string, unknown> }> = [];
    state().doc.descendants((n) => {
      if (n.type.name === 'extension_block')
        found.push({ id: String(n.attrs['id']), attrs: n.attrs });
      return true;
    });
    return found;
  };
  return { core, api, state, before, blocks };
}

describe('UX-056 criterion 1: inserting a block creates an extension_block with its fallback', () => {
  it('creates a block with an identifier, the extension, the payload and the fallback, and the document stays valid', () => {
    const { core, api, before, blocks } = setup();
    const result = api.insertExtensionBlock(before(), DRAFT);
    expect(result.ok).toBe(true);
    const [block] = blocks();
    expect(block).toBeDefined();
    expect(result.ok && result.id).toBe(block!.id);
    expect(block!.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(block!.attrs).toMatchObject({
      extension: 'com.example.chart',
      payload: { kind: 'chart', series: [1, 2, 3] },
      fallbackText: 'A chart of three values',
      fallbackAsset: null,
    });
    expect(core.requires).toContain('extensions');
    expect(validate(core.getContent()).violations).toEqual([]);
  });

  it('accepts a fallback picture alone', () => {
    const { api, before, blocks } = setup();
    const result = api.insertExtensionBlock(before(), {
      extension: 'com.example.chart',
      payload: {},
      fallbackAsset: 'aFallback0000001',
    });
    expect(result.ok).toBe(true);
    expect(blocks()[0]!.attrs['fallbackAsset']).toBe('aFallback0000001');
  });

  it.each([
    ['no fallback at all', { extension: 'x.y', payload: {} }],
    ['an empty fallback text', { extension: 'x.y', payload: {}, fallbackText: '' }],
    [
      'a blank fallback text and no asset',
      { extension: 'x.y', payload: {}, fallbackText: '   ', fallbackAsset: null },
    ],
  ])('refuses %s before anything is sent', (_name, draft) => {
    const { api, state, before } = setup();
    const doc = state().doc;
    expect(api.insertExtensionBlock(before(), draft as ExtBlockDraft)).toMatchObject({
      ok: false,
      reason: 'no_fallback',
    });
    expect(state().doc).toBe(doc);
  });

  it('refuses a block without an extension name', () => {
    const { api, before } = setup();
    expect(api.insertExtensionBlock(before(), { ...DRAFT, extension: ' ' })).toMatchObject({
      ok: false,
      reason: 'no_extension',
    });
  });
});

describe('UX-056 criterion 2: a payload over 16 KiB is refused before sending', () => {
  const payloadOf = (bytes: number) => 'a'.repeat(bytes - 2); // the JSON text adds two quotes

  it('accepts exactly 16384 bytes and refuses one more', () => {
    const { api, state, before, blocks } = setup();
    expect(api.insertExtensionBlock(before(), { ...DRAFT, payload: payloadOf(16384) }).ok).toBe(
      true,
    );
    const doc = state().doc;
    expect(
      api.insertExtensionBlock(before(), { ...DRAFT, payload: payloadOf(16385) }),
    ).toMatchObject({
      ok: false,
      reason: 'payload_too_large',
    });
    expect(state().doc).toBe(doc);
    expect(blocks()).toHaveLength(1);
  });

  it('counts bytes, not characters', () => {
    const { api, before } = setup();
    // 5462 three-byte characters are 16386 bytes plus two quotes.
    expect(
      api.insertExtensionBlock(before(), { ...DRAFT, payload: '€'.repeat(5462) }),
    ).toMatchObject({ ok: false, reason: 'payload_too_large' });
    expect(api.insertExtensionBlock(before(), { ...DRAFT, payload: '€'.repeat(5400) }).ok).toBe(
      true,
    );
  });

  it('refuses a payload that has no JSON form', () => {
    const { api, before } = setup();
    expect(api.insertExtensionBlock(before(), { ...DRAFT, payload: 10n })).toMatchObject({
      ok: false,
      reason: 'payload_not_json',
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(api.insertExtensionBlock(before(), { ...DRAFT, payload: cyclic })).toMatchObject({
      ok: false,
      reason: 'payload_not_json',
    });
  });

  it('applies the same limit to an update', () => {
    const { api, before, blocks } = setup();
    const made = api.insertExtensionBlock(before(), DRAFT);
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : '';
    expect(api.updateExtensionBlock(id, { payload: payloadOf(16385) })).toMatchObject({
      ok: false,
      reason: 'payload_too_large',
    });
    expect(api.updateExtensionBlock(id, { fallbackText: null })).toMatchObject({
      ok: false,
      reason: 'no_fallback',
    });
    expect(blocks()[0]!.attrs['payload']).toEqual(DRAFT.payload);
  });
});

describe('UX-056 criterion 5: an edit through the extension is an ordinary commit', () => {
  it('refuses an insertion and an update in a scope the user may not change', () => {
    const { core, api, state, before } = setup();
    const made = api.insertExtensionBlock(before(), DRAFT);
    const id = made.ok ? made.id : '';
    core.setAccess(regionOnlyAccess());
    const doc = state().doc;
    expect(api.insertExtensionBlock(before(), DRAFT)).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    expect(api.updateExtensionBlock(id, { payload: { changed: true } })).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    expect(state().doc).toBe(doc);
  });

  it('inserts, then changes the payload, as commits the authority accepts', async () => {
    const service = newService();
    const content = contractDocument();
    content.requires = [...content.requires, 'extensions'];
    const docId = service.createDocument(content);
    const { core, detach } = await join(service, docId, 'ann', 'editor');
    await until(() => core.permissions.get() !== null, 'access');
    const api = core.extensionApi({ maxRanges: 4, later: () => undefined });
    const at = posOf(internals(core).state.doc, IDS.intro);
    const made = api.insertExtensionBlock(api.range(at, at), DRAFT);
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : '';
    await core.flush();
    const onServer = () => {
      const found: Array<Record<string, unknown>> = [];
      const walk = (n: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
        if (n.type === 'extension_block') found.push(n.attrs ?? {});
        for (const c of n.content ?? []) walk(c as never);
      };
      walk(service.document(docId)!.content().doc as never);
      return found;
    };
    expect(onServer()).toHaveLength(1);
    expect(onServer()[0]).toMatchObject({ id, payload: DRAFT.payload });

    expect(api.updateExtensionBlock(id, { payload: { kind: 'chart', series: [9] } }).ok).toBe(true);
    await core.flush();
    expect(onServer()[0]).toMatchObject({ id, payload: { kind: 'chart', series: [9] } });
    expect(core.saveState.get()).toBe('saved');
    expect(service.document(docId)!.content().requires).toContain('extensions');
    detach();
    core.destroy();
  });

  it('is refused for a viewer, and the server document does not change', async () => {
    const service = newService();
    const content = contractDocument();
    content.requires = [...content.requires, 'extensions'];
    const docId = service.createDocument(content);
    const { core, detach } = await join(service, docId, 'vic', 'viewer');
    await until(() => core.permissions.get() !== null, 'access');
    const api = core.extensionApi({ maxRanges: 4, later: () => undefined });
    const at = posOf(internals(core).state.doc, IDS.intro);
    expect(api.insertExtensionBlock(api.range(at, at), DRAFT)).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    detach();
    core.destroy();
  });
});

describe('UX-056 criterion 6: the block is an atom with an accessible name', () => {
  it('is a leaf the selection takes whole, and a delete removes it as one unit', () => {
    const { core, api, state, before, blocks } = setup();
    const made = api.insertExtensionBlock(before(), DRAFT);
    const id = made.ok ? made.id : '';
    const pos = posOf(state().doc, id);
    const node = state().doc.nodeAt(pos)!;
    expect(node.isAtom).toBe(true);
    expect(node.isLeaf).toBe(true);
    internals(core).dispatch(state().tr.setSelection(NodeSelection.create(state().doc, pos)));
    expect(core.selection.get().empty).toBe(false);
    internals(core).dispatch(state().tr.deleteSelection());
    expect(blocks()).toHaveLength(0);
  });

  it('moves by cut and paste with its payload and fallback, and the document stays valid', () => {
    const { core, api, state, before, blocks } = setup();
    const made = api.insertExtensionBlock(before(), DRAFT);
    const id = made.ok ? made.id : '';
    internals(core).dispatch(
      state().tr.setSelection(NodeSelection.create(state().doc, posOf(state().doc, id))),
    );
    const cut = core.cutSelection();
    expect(cut.deleted).toBe(true);
    expect(blocks()).toHaveLength(0);
    const last = posOf(state().doc, SPIKE_IDS.last) + 1;
    internals(core).dispatch(state().tr.setSelection(TextSelection.create(state().doc, last)));
    const html = cut.payload!['text/html'];
    expect(core.pasteFromClipboard({ html, text: cut.payload!['text/plain'] }).ok).toBe(true);
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]!.attrs).toMatchObject({
      extension: DRAFT.extension,
      payload: DRAFT.payload,
      fallbackText: DRAFT.fallbackText,
    });
    expect(validate(core.getContent()).violations).toEqual([]);
  });

  it('can be the target of a comment range, which follows it when text is inserted before', () => {
    const { core, api, state, before } = setup();
    const made = api.insertExtensionBlock(before(), DRAFT);
    const id = made.ok ? made.id : '';
    const pos = posOf(state().doc, id);
    core.setThreadRange('t1', { from: pos, to: pos + 1 }, 1);
    const intro = posOf(state().doc, SPIKE_IDS.intro) + 1;
    internals(core).dispatch(state().tr.insertText('Before ', intro));
    const range = core.threadRanges.get().find((r) => r.id === 't1')!;
    expect(range.detached).toBe(false);
    expect(state().doc.nodeAt(range.from)!.attrs['id']).toBe(id);
    expect(api.comments(api.range(range.from, range.to))).toEqual([{ id: 't1', detached: false }]);
  });

  it('names itself for assistive technology and keeps the fallback text as ordinary text', () => {
    const { api, state, before } = setup();
    const made = api.insertExtensionBlock(before(), DRAFT);
    const id = made.ok ? made.id : '';
    const node = state().doc.nodeAt(posOf(state().doc, id))!;
    const spec = node.type.spec.toDOM!(node) as unknown as [
      string,
      Record<string, string>,
      ...unknown[],
    ];
    expect(spec[0]).toBe('div');
    expect(spec[1]).toMatchObject({
      role: 'group',
      'aria-label': 'Content from extension com.example.chart',
    });
    expect(spec.slice(2)).toContainEqual([
      'p',
      { class: 'de-extension-text' },
      'A chart of three values',
    ]);
  });
});
