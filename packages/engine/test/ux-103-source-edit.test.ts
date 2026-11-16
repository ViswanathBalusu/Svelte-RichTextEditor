/**
 * Source definitions through the core (UX-103 criteria 1, 2 and 4; lane w3). Node.js, the real
 * DocumentCore with the region guard and its sync queue: adding, changing and deleting a source is
 * a local change that queues a commit; a cited source is not deleted and the answer says where it
 * is cited; a user without `structure` can cite a source but cannot change the definitions.
 */
import type { Access } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore, sourceProblems } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const REGION = `region:${AUTH_IDS.region}`;

/** May edit the body and the region, not the definitions: no `structure` (07 §4). */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'], [REGION]: [...EDIT] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

function ownerAccess(): Access {
  return {
    ...editorAccess(),
    docRole: 'owner',
    caps: [...EDIT, 'structure', 'manage'],
    scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT], [REGION]: [...EDIT] },
  };
}

function core(access: Access): DocumentCore {
  const doc: CdmEnvelope = { cdm: 1, requires: [], doc: authoringEnvelope() };
  return new DocumentCore({ doc, access, schedule: microtask });
}

function pending(c: DocumentCore): number {
  const s = internals(c).sync;
  return s.queue.length + (s.inflight ? 1 : 0);
}

const ids = (c: DocumentCore): string[] => c.sources().map((s) => s.id);

describe('source definitions through the core (UX-103)', () => {
  it('adds a source after the last one, as a queued commit (criterion 1)', () => {
    const c = core(ownerAccess());
    const before = pending(c);
    const values = {
      kind: 'article-journal',
      title: 'On editing',
      authors: [{ family: 'Lovelace', given: 'Ada' }],
      issued: '2026-11',
      containerTitle: 'Journal of Documents',
      doi: '10.1234/abc.def',
      url: 'https://example.org/on-editing',
    };
    expect(c.editSource({ op: 'add', id: 'lovelace2026', values }, true)).toEqual({ ok: true });
    expect(ids(c)).toEqual(['smith2026', 'jones2024']);
    expect(c.editSource({ op: 'add', id: 'lovelace2026', values })).toEqual({ ok: true });
    expect(ids(c)).toEqual(['smith2026', 'jones2024', 'lovelace2026']);
    expect(c.sources()[2]!.values).toMatchObject(values);
    expect(pending(c)).toBe(before + 1);
  });

  it('changes a source one attribute at a time, as a queued commit (criterion 1)', () => {
    const c = core(ownerAccess());
    const before = pending(c);
    const values = { title: 'A better book', issued: '2025' };
    expect(c.editSource({ op: 'update', id: 'smith2026', values })).toEqual({ ok: true });
    expect(c.sources()[0]!.values).toMatchObject({ kind: 'book', ...values });
    // One step per attribute; the queue may hold them as one commit or as two.
    expect(pending(c)).toBeGreaterThan(before);
    const queued = pending(c);
    expect(c.editSource({ op: 'update', id: 'smith2026', values })).toEqual({
      ok: false,
      reason: 'no-change',
    });
    expect(c.editSource({ op: 'update', id: 'nobody', values })).toEqual({
      ok: false,
      reason: 'not-defined',
    });
    expect(pending(c)).toBe(queued);
  });

  it('deletes an uncited source as a queued commit (criterion 1)', () => {
    const c = core(ownerAccess());
    const before = pending(c);
    expect(c.editSource({ op: 'delete', id: 'jones2024' })).toEqual({ ok: true });
    expect(ids(c)).toEqual(['smith2026']);
    expect(pending(c)).toBe(before + 1);
  });

  it('refuses a value outside its grammar and a second source with the same identifier', () => {
    const c = core(ownerAccess());
    const before = pending(c);
    const bad = c.editSource({
      op: 'add',
      id: 'x1',
      values: { doi: 'not a doi', url: 'javascript:alert(1)', issued: 'last year' },
    });
    expect(bad.ok).toBe(false);
    expect(bad).toMatchObject({ reason: 'invalid' });
    const fields =
      !bad.ok && bad.reason === 'invalid' ? bad.problems.map((p) => p.field) : ['none'];
    expect([...new Set(fields)].sort()).toEqual(['doi', 'issued', 'url']);
    expect(c.editSource({ op: 'add', id: 'bad id', values: {} })).toMatchObject({
      reason: 'invalid',
    });
    expect(c.editSource({ op: 'add', id: 'smith2026', values: {} })).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(
      c.editSource({ op: 'update', id: 'smith2026', values: { kind: 'tablet' } }),
    ).toMatchObject({ reason: 'invalid' });
    expect(ids(c)).toEqual(['smith2026', 'jones2024']);
    expect(pending(c)).toBe(before);
  });

  it('does not delete a cited source, and says where it is cited (criterion 2)', () => {
    const c = core(ownerAccess());
    caret(c, AUTH_IDS.p1, 5);
    expect(c.run('insertCitation', { citation: { items: [{ source: 'smith2026' }] } })).toBe(true);
    const before = pending(c);
    const listed = c.sources().find((s) => s.id === 'smith2026')!;
    expect(listed.citedAt).toHaveLength(1);
    expect(listed.citedAt[0]!.excerpt).toBe('Alpha beta');
    const outcome = c.editSource({ op: 'delete', id: 'smith2026' });
    expect(outcome).toEqual({ ok: false, reason: 'cited', citedAt: [listed.citedAt[0]!.pos] });
    expect(ids(c)).toContain('smith2026');
    expect(pending(c)).toBe(before);
    // The uncited one lists no place.
    expect(c.sources().find((s) => s.id === 'jones2024')!.citedAt).toEqual([]);
  });

  it('without structure a user cites a source but changes no definition (criterion 4)', () => {
    const c = core(editorAccess());
    const before = pending(c);
    const edits = [
      { op: 'add', id: 'new2026', values: { title: 'New' } },
      { op: 'update', id: 'smith2026', values: { title: 'Changed' } },
      { op: 'delete', id: 'jones2024' },
    ] as const;
    for (const edit of edits) {
      expect(c.editSource(edit, true), edit.op).toEqual({ ok: false, reason: 'read-only' });
      expect(c.editSource(edit), edit.op).toEqual({ ok: false, reason: 'read-only' });
    }
    expect(ids(c)).toEqual(['smith2026', 'jones2024']);
    expect(c.sources()[0]!.values.title).toBe('A book');
    expect(pending(c)).toBe(before);
    // Citing an existing source is a change of the body, which this user may make.
    caret(c, AUTH_IDS.inRegion, 3);
    expect(c.run('insertCitation', { citation: { items: [{ source: 'jones2024' }] } })).toBe(true);
    expect(pending(c)).toBe(before + 1);
    expect(c.sources()[1]!.citedAt).toHaveLength(1);
  });

  it('in view mode nothing changes', () => {
    const doc: CdmEnvelope = { cdm: 1, requires: [], doc: authoringEnvelope() };
    const c = new DocumentCore({ doc, access: ownerAccess(), schedule: microtask, mode: 'view' });
    expect(c.editSource({ op: 'delete', id: 'jones2024' })).toEqual({
      ok: false,
      reason: 'read-only',
    });
    expect(ids(c)).toEqual(['smith2026', 'jones2024']);
  });

  it('a value the grammar refuses never reaches the document (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (doi, url) => {
        const c = core(ownerAccess());
        const values = { doi, url };
        const problems = sourceProblems('k1', values);
        const outcome = c.editSource({ op: 'add', id: 'k1', values });
        expect(outcome.ok).toBe(problems.length === 0);
        expect(ids(c).includes('k1')).toBe(problems.length === 0);
      }),
      { numRuns: 60 },
    );
  });
});
