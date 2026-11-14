/**
 * Accept and reject all, through the core and the authority (FE-047 criteria 5 and 6; 02 §5.2;
 * 07 §5.2). The contract document is given suggestion marks by two suggesters; members join the
 * mock service (the real authority room) and call `DocumentCore.resolveSuggestions`. Each call must
 * reach the log as one commit, the authority must accept it, and suggestions in a scope where the
 * member lacks `edit` must be skipped, counted and left as they were on the server.
 */
import type { CdmEnvelope } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { MockService } from '@docedit/backend-mock';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { join, newService, posOf, until, type Member } from './support.ts';

const LOCKED = `region:${IDS.locked}`;

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const ins = (id: string, user: string) => ({ type: 'ins', attrs: { id, user } });
const del = (id: string, user: string) => ({ type: 'del', attrs: { id, user } });

/**
 * The contract document with suggestions: in the body paragraph, an insertion by sam ("big ") and a
 * deletion by tess ("world"); in the open region, an insertion by tess ("region"); in the restricted
 * region, a deletion by sam (" text").
 */
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
  find(root, IDS.lockedPara)!.content = [
    { type: 'text', text: 'Restricted' },
    { type: 'text', text: ' text', marks: [del('sSamDelete000001', 'sam')] },
  ];
  return env;
}

/** The runs of the paragraph `id` in the server's document: text and suggestion mark types. */
function serverRuns(service: MockService, docId: string, id: string): [string, string[]][] {
  const doc = service.document(docId)!.content().doc as unknown as JsonNode;
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return (find(doc)!.content ?? []).map((t) => [
    t.text ?? '',
    (t.marks ?? []).map((m) => `${m.type}:${String(m.attrs?.['user'])}`),
  ]);
}

/** The server's document as a CDM envelope, for `validate` (I1 to I12). */
function serverEnvelope(service: MockService, docId: string): CdmEnvelope {
  const c = service.document(docId)!.content();
  return { cdm: 1, requires: c.requires, doc: c.doc } as unknown as CdmEnvelope;
}

async function setUp(sub: string, role: 'editor' | 'suggester', groups?: string[]) {
  const service = newService();
  const docId = service.createDocument(suggestedDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const m: Member = await join(service, docId, sub, role, {}, groups ? { groups } : {});
  await until(() => m.core.permissions.get() !== null, 'access');
  return { service, docId, m, head: service.document(docId)!.head };
}

async function saved(m: Member): Promise<void> {
  await until(() => m.core.saveState.get() === 'saved', 'saved', 5000);
}

describe('accept or reject all in one commit (FE-047 criterion 5)', () => {
  it('accepts every suggestion in the document as one commit the authority accepts', async () => {
    const { service, docId, m, head } = await setUp('grace', 'editor', ['legal']);
    const report = m.core.resolveSuggestions('accept', 'document');
    expect(report).toEqual({ handled: 4, skipped: 0, skippedScopes: [] });
    await saved(m);
    expect(service.document(docId)!.head).toBe(head + 1);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([['Hello big ', []]]);
    expect(serverRuns(service, docId, IDS.openPara)).toEqual([['Open region', []]]);
    expect(serverRuns(service, docId, IDS.lockedPara)).toEqual([['Restricted', []]]);
    expect(validate(serverEnvelope(service, docId)).valid).toBe(true);
    m.detach();
    await service.dispose();
  });

  it('accepts only the chosen author, in one commit', async () => {
    const { service, docId, m, head } = await setUp('grace', 'editor', ['legal']);
    const report = m.core.resolveSuggestions('accept', 'document', 'sam');
    expect(report).toEqual({ handled: 2, skipped: 0, skippedScopes: [] });
    await saved(m);
    expect(service.document(docId)!.head).toBe(head + 1);
    // sam's insertion is kept and his deletion carried out; tess's suggestions are untouched.
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello big ', []],
      ['world', ['del:tess']],
    ]);
    expect(serverRuns(service, docId, IDS.openPara)).toEqual([
      ['Open ', []],
      ['region', ['ins:tess']],
    ]);
    expect(serverRuns(service, docId, IDS.lockedPara)).toEqual([['Restricted', []]]);
    expect(validate(serverEnvelope(service, docId)).valid).toBe(true);
    m.detach();
    await service.dispose();
  });

  it('rejects every suggestion in a region chosen by its identifier, in one commit', async () => {
    const { service, docId, m, head } = await setUp('grace', 'editor', ['legal']);
    const report = m.core.resolveSuggestions('reject', { id: IDS.open });
    expect(report).toEqual({ handled: 1, skipped: 0, skippedScopes: [] });
    await saved(m);
    expect(service.document(docId)!.head).toBe(head + 1);
    expect(serverRuns(service, docId, IDS.openPara)).toEqual([['Open ', []]]);
    // Outside the region nothing changed.
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:sam']],
      ['world', ['del:tess']],
    ]);
    expect(validate(serverEnvelope(service, docId)).valid).toBe(true);
    m.detach();
    await service.dispose();
  });

  it('rejects every suggestion in the selection, in one commit', async () => {
    const { service, docId, m, head } = await setUp('grace', 'editor', ['legal']);
    const i = internals(m.core);
    const from = posOf(i.state.doc, IDS.intro) + 1;
    const to = from + 'Hello big world'.length;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
    const report = m.core.resolveSuggestions('reject', 'selection');
    expect(report).toEqual({ handled: 2, skipped: 0, skippedScopes: [] });
    await saved(m);
    expect(service.document(docId)!.head).toBe(head + 1);
    // The insertion is removed and the deletion's text stays without its mark.
    expect(serverRuns(service, docId, IDS.intro)).toEqual([['Hello world', []]]);
    expect(serverRuns(service, docId, IDS.openPara)).toEqual([
      ['Open ', []],
      ['region', ['ins:tess']],
    ]);
    expect(validate(serverEnvelope(service, docId)).valid).toBe(true);
    m.detach();
    await service.dispose();
  });

  it('makes no commit when the target has no suggestion', async () => {
    const { service, docId, m, head } = await setUp('grace', 'editor', ['legal']);
    expect(m.core.resolveSuggestions('accept', { id: IDS.mid })).toEqual({
      handled: 0,
      skipped: 0,
      skippedScopes: [],
    });
    expect(m.core.resolveSuggestions('accept', { id: 'pNoSuchNode00001' })).toEqual({
      handled: 0,
      skipped: 0,
      skippedScopes: [],
    });
    expect(service.document(docId)!.head).toBe(head);
    m.detach();
    await service.dispose();
  });
});

describe('scopes without edit are skipped and counted (FE-047 criterion 6)', () => {
  it('an editor without the restricted region skips its suggestion and the rest commit', async () => {
    const { service, docId, m, head } = await setUp('eddie', 'editor');
    // The access the authority sent: the region is not editable for eddie.
    expect(m.core.permissions.get()!.scopes[LOCKED] ?? []).not.toContain('edit');
    const before = m.core.refusal.get()?.n ?? 0;
    const report = m.core.resolveSuggestions('accept', 'document');
    expect(report).toEqual({ handled: 3, skipped: 1, skippedScopes: [LOCKED] });
    // The skip is recorded for the interface, with the scope that blocked it.
    expect(m.core.refusal.get()).toMatchObject({
      n: before + 1,
      reason: 'scope',
      scopes: [LOCKED],
    });
    await saved(m);
    expect(service.document(docId)!.head).toBe(head + 1);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([['Hello big ', []]]);
    expect(serverRuns(service, docId, IDS.lockedPara)).toEqual([
      ['Restricted', []],
      [' text', ['del:sam']],
    ]);
    expect(validate(serverEnvelope(service, docId)).valid).toBe(true);
    m.detach();
    await service.dispose();
  });

  it('a suggester, who has suggest but not edit, skips every suggestion and commits nothing', async () => {
    const { service, docId, m, head } = await setUp('sam', 'suggester');
    const access = m.core.permissions.get()!;
    expect(access.scopes['body'] ?? access.caps).toContain('suggest');
    expect(access.scopes['body'] ?? access.caps).not.toContain('edit');
    const report = m.core.resolveSuggestions('accept', 'document', 'sam');
    expect(report.handled).toBe(0);
    expect(report.skipped).toBe(2);
    expect(report.skippedScopes).toEqual(['body', LOCKED].sort());
    expect(m.core.refusal.get()).toMatchObject({ reason: 'scope' });
    expect(service.document(docId)!.head).toBe(head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:sam']],
      ['world', ['del:tess']],
    ]);
    m.detach();
    await service.dispose();
  });
});
