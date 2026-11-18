/**
 * The review tools at the core (UX-036 criteria 1 to 4; 08 §14; 07 §5.2). The contract document is
 * given suggestion marks by two suggesters; members join the mock service (the real authority room).
 * The core lists the suggestions, steps to one, accepts or rejects one by identifier, and each
 * accept or reject crosses the channel as one commit with origin `suggestion.accept` or
 * `suggestion.reject`. A suggester, who has `suggest` and not `edit`, may resolve none.
 */
import type { CdmEnvelope } from '@docedit/model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { join, newService, textOfNode, traffic, until, type Member } from './support.ts';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const ins = (id: string, user: string) => ({ type: 'ins', attrs: { id, user } });
const del = (id: string, user: string) => ({ type: 'del', attrs: { id, user } });

function suggestedDocument(): CdmEnvelope {
  const env = contractDocument();
  const root = env.doc as unknown as JsonNode;
  const find = (n: JsonNode, id: string): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c, id);
      if (r) return r;
    }
    return null;
  };
  find(root, IDS.intro)!.content = [
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'big ', marks: [ins('sSamInsert000001', 'sam')] },
    { type: 'text', text: 'world', marks: [del('sTessDelete00001', 'tess')] },
  ];
  find(root, IDS.openPara)!.content = [
    { type: 'text', text: 'Open ' },
    { type: 'text', text: 'region', marks: [ins('sTessInsert00001', 'tess')] },
  ];
  return env;
}

async function setUp(sub: string, role: 'editor' | 'suggester') {
  const service = newService();
  const docId = service.createDocument(suggestedDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const m: Member = await join(service, docId, sub, role, {}, {});
  await until(() => m.core.permissions.get() !== null, 'access');
  return { service, m };
}

const saved = (m: Member): Promise<void> =>
  until(() => m.core.saveState.get() === 'saved', 'saved', 5000);

describe('the suggestion list (UX-036, UX-037)', () => {
  it('lists the suggestions in document order with kind, author, words and what the user may do', async () => {
    const { service, m } = await setUp('grace', 'editor');
    const items = m.core.suggestionItems();
    expect(items.map((s) => [s.id, s.kind, s.user, s.text, s.block])).toEqual([
      ['sSamInsert000001', 'ins', 'sam', 'big ', false],
      ['sTessDelete00001', 'del', 'tess', 'world', false],
      ['sTessInsert00001', 'ins', 'tess', 'region', false],
    ]);
    // An editor may resolve each; the positions are increasing.
    expect(items.every((s) => s.canResolve && s.caps.includes('edit'))).toBe(true);
    expect(items.map((s) => s.from)).toEqual([...items.map((s) => s.from)].sort((a, b) => a - b));
    m.detach();
    await service.dispose();
  });

  it('a suggester may resolve none: no edit in the body, whoever wrote the suggestion', async () => {
    const { service, m } = await setUp('sam', 'suggester');
    const items = m.core.suggestionItems();
    expect(items).toHaveLength(3);
    // Neither other people's suggestions nor sam's own (P4: a suggester may not accept its own).
    expect(items.every((s) => !s.canResolve && !s.caps.includes('edit'))).toBe(true);
    expect(items.some((s) => s.caps.includes('suggest'))).toBe(true);
    const report = m.core.resolveSuggestions('accept', 'document', undefined, 'sSamInsert000001');
    expect(report.handled).toBe(0);
    m.detach();
    await service.dispose();
  });
});

describe('accepting and rejecting one suggestion (UX-036 criterion 1)', () => {
  it('accepts one by identifier: only that mark goes, as one commit with origin suggestion.accept', async () => {
    const { service, m } = await setUp('grace', 'editor');
    await saved(m);
    traffic.clear();
    const report = m.core.resolveSuggestions('accept', 'document', undefined, 'sSamInsert000001');
    expect(report).toEqual({ handled: 1, skipped: 0, skippedScopes: [] });
    await saved(m);
    expect(traffic.submitted).toEqual([{ origin: 'suggestion.accept', steps: expect.any(Number) }]);
    expect(traffic.submitted).toHaveLength(1);
    // The other suggestions are still there.
    expect(m.core.suggestionItems().map((s) => s.id)).toEqual([
      'sTessDelete00001',
      'sTessInsert00001',
    ]);
    expect(textOfNode(internals(m.core).state.doc, IDS.intro)).toBe('Hello big world');
    m.detach();
    await service.dispose();
  });

  it('rejects one by identifier: an insertion is removed, with origin suggestion.reject', async () => {
    const { service, m } = await setUp('grace', 'editor');
    await saved(m);
    traffic.clear();
    const report = m.core.resolveSuggestions('reject', 'document', undefined, 'sSamInsert000001');
    expect(report.handled).toBe(1);
    await saved(m);
    expect(traffic.submitted).toEqual([{ origin: 'suggestion.reject', steps: expect.any(Number) }]);
    expect(textOfNode(internals(m.core).state.doc, IDS.intro)).toBe('Hello world');
    m.detach();
    await service.dispose();
  });

  it('accept all and reject all carry the same origins, and an unknown identifier does nothing', async () => {
    const { service, m } = await setUp('grace', 'editor');
    await saved(m);
    traffic.clear();
    expect(m.core.resolveSuggestions('accept', 'document', undefined, 'nope').handled).toBe(0);
    expect(traffic.submitted).toEqual([]);
    expect(m.core.resolveSuggestions('reject', 'document').handled).toBe(3);
    await saved(m);
    expect(traffic.submitted.map((c) => c.origin)).toEqual(['suggestion.reject']);
    m.detach();
    await service.dispose();
  });
});

describe('next, previous and resolving at the selection (UX-036 criterion 1)', () => {
  it('steps forward and back through the suggestions and wraps at the ends', async () => {
    const { service, m } = await setUp('grace', 'editor');
    const ids = m.core.suggestionItems().map((s) => s.id);
    const seen: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) seen.push(m.core.stepSuggestion(1)?.id);
    // From the start of the document: the first, second, third, then round to the first.
    expect(seen).toEqual([ids[0], ids[1], ids[2], ids[0]]);
    const back: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) back.push(m.core.stepSuggestion(-1)?.id);
    expect(back).toEqual([ids[2], ids[1], ids[0]]);
    m.detach();
    await service.dispose();
  });

  it('a caret in a suggestion resolves that one; a selection resolves those inside; none is none', async () => {
    const { service, m } = await setUp('grace', 'editor');
    await saved(m);
    traffic.clear();
    // Nothing under the caret at the start of the document.
    expect(m.core.resolveAtSelection('accept')).toEqual({
      handled: 0,
      skipped: 0,
      skippedScopes: [],
    });
    expect(traffic.submitted).toEqual([]);
    // The caret inside sam's insertion.
    const sam = m.core.suggestionItems().find((s) => s.id === 'sSamInsert000001')!;
    m.core.revealSuggestion('sSamInsert000001');
    internals(m.core).dispatch(
      internals(m.core).state.tr.setSelection(
        TextSelection.create(internals(m.core).state.doc, sam.from + 1),
      ),
    );
    expect(m.core.resolveAtSelection('accept').handled).toBe(1);
    await saved(m);
    expect(traffic.submitted.map((c) => c.origin)).toEqual(['suggestion.accept']);
    // A selection over the whole document rejects what is left, in one commit.
    traffic.clear();
    const doc = internals(m.core).state.doc;
    internals(m.core).dispatch(
      internals(m.core).state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)),
    );
    expect(m.core.resolveAtSelection('reject').handled).toBe(2);
    await saved(m);
    expect(traffic.submitted.map((c) => c.origin)).toEqual(['suggestion.reject']);
    m.detach();
    await service.dispose();
  });
});

describe('another person resolves a suggestion first (UX-036 criterion 4)', () => {
  it('the other core drops it from its list on the next commit, and resolving it again does nothing', async () => {
    const service = newService();
    const docId = service.createDocument(suggestedDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const ada = await join(service, docId, 'ada', 'editor');
    const bob = await join(service, docId, 'bob', 'editor');
    await until(() => ada.core.suggestionItems().length === 3, 'ada sees three');
    await until(() => bob.core.suggestionItems().length === 3, 'bob sees three');
    const adaIds = (): string[] => ada.core.suggestionItems().map((s) => s.id);

    expect(
      bob.core.resolveSuggestions('accept', 'document', undefined, 'sSamInsert000001').handled,
    ).toBe(1);
    await until(() => !adaIds().includes('sSamInsert000001'), 'ada sees it resolved');
    expect(adaIds()).toEqual(['sTessDelete00001', 'sTessInsert00001']);
    expect(textOfNode(internals(ada.core).state.doc, IDS.intro)).toBe('Hello big world');

    // Ada resolves the same one a moment later: nothing to handle, nothing thrown, nothing sent.
    traffic.clear();
    expect(
      ada.core.resolveSuggestions('reject', 'document', undefined, 'sSamInsert000001'),
    ).toEqual({
      handled: 0,
      skipped: 0,
      skippedScopes: [],
    });
    expect(ada.core.revealSuggestion('sSamInsert000001')).toBe(false);
    expect(traffic.submitted).toEqual([]);
    ada.detach();
    bob.detach();
    await service.dispose();
  });
});

describe('stepping to a suggestion (UX-036 criterion 1: next and previous)', () => {
  it('reveals a suggestion by selecting its words, without a change of the document', async () => {
    const { service, m } = await setUp('grace', 'editor');
    await saved(m);
    traffic.clear();
    const before = internals(m.core).state.doc;
    expect(m.core.revealSuggestion('sTessInsert00001')).toBe(true);
    const state = internals(m.core).state;
    const item = m.core.suggestionItems().find((s) => s.id === 'sTessInsert00001')!;
    expect([state.selection.from, state.selection.to]).toEqual([item.from, item.to]);
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe('region');
    expect(m.core.revealedSuggestion.get()).toEqual({ id: 'sTessInsert00001', n: 1 });
    expect(m.core.revealSuggestion('nope')).toBe(false);
    expect(state.doc.eq(before)).toBe(true);
    expect(traffic.submitted).toEqual([]);
    m.detach();
    await service.dispose();
  });
});
