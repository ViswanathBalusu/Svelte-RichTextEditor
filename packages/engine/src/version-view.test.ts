// An old version as a second, read-only state (HIS-010 criteria 1, 2, 3 and 5).
import { PortError } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from './core.ts';
import { spikeDocument } from './spike-document.ts';
import { VersionDocument, openVersion, type VersionOpener } from './version-view.ts';

const microtask = (run: () => void): void => queueMicrotask(run);

interface Call {
  readonly kind: string;
  readonly args: readonly unknown[];
}

/** A sync port that records its calls; `open` would be a connection to the live channel. */
function fakeSync(
  heads: Record<number, ReturnType<typeof spikeDocument>>,
  calls: Call[],
  fail?: 'forbidden' | 'not_found' | 'boom',
) {
  return {
    loadContent: (docId: string, seq?: number) => {
      calls.push({ kind: 'loadContent', args: [docId, seq] });
      if (fail === 'forbidden') return Promise.reject(new PortError('forbidden', 'below the gate'));
      if (fail === 'not_found') return Promise.reject(new PortError('not_found', 'no such seq'));
      if (fail === 'boom') return Promise.reject(new Error('network'));
      const env = heads[seq ?? -1];
      if (!env) return Promise.reject(new PortError('not_found', 'no such seq'));
      return Promise.resolve({
        seq: seq as number,
        incarnation: 'inc-1',
        cdm: env.cdm,
        requires: env.requires,
        doc: env.doc,
      });
    },
    open: () => {
      calls.push({ kind: 'open', args: [] });
      return Promise.reject(new Error('a version must never open the live channel'));
    },
  };
}

const opener = (sync: ReturnType<typeof fakeSync>): VersionOpener => ({
  sync: sync as unknown as VersionOpener['sync'],
  docId: 'doc-1',
  options: { schedule: microtask },
});

describe('an old version as a read-only state (HIS-010)', () => {
  it('is read-only, detached from any channel, and refuses every command (criterion 1)', () => {
    const v = VersionDocument.create(
      { seq: 4, content: spikeDocument(), time: '2026-11-01T10:00:00Z', name: 'Draft' },
      { schedule: microtask },
    );
    expect(v.readOnly).toBe(true);
    expect(v.connection()).toBe('detached');
    expect('attach' in v).toBe(false);
    const before = JSON.stringify(v.content());
    for (const name of [
      'bold',
      'italic',
      'undo',
      'redo',
      'clearFormatting',
      'selectAll',
    ] as const) {
      if (name === 'selectAll') continue; // moving the selection is not a change
      expect(v.run(name)).toBe(false);
    }
    expect(v.run('paragraphStyle', { style: 'Heading1' })).toBe(false);
    expect(JSON.stringify(v.content())).toBe(before);
    expect(v.unsent()).toBe(0);
    v.destroy();
    expect(v.run('bold')).toBe(false);
  });

  it('keeps the live document unaffected, and is unaffected by it (criterion 2)', async () => {
    const live = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const calls: Call[] = [];
    const out = await openVersion(opener(fakeSync({ 3: spikeDocument() }, calls)), 3, {
      time: '2026-11-01T10:00:00Z',
    });
    if (!out.ok) throw new Error('the version did not open');
    const old = JSON.stringify(out.version.content());
    // The live document keeps taking commits: a change to it leaves the version as it was.
    live.run('selectAll');
    expect(live.run('bold')).toBe(true);
    expect(JSON.stringify(live.getContent())).not.toBe(old);
    expect(JSON.stringify(out.version.content())).toBe(old);
    // And the other way round: nothing the version refuses reaches the live core.
    const liveBefore = JSON.stringify(live.getContent());
    expect(out.version.run('italic')).toBe(false);
    expect(JSON.stringify(live.getContent())).toBe(liveBefore);
    live.destroy();
    out.version.destroy();
  });

  it('reads the content with one pinned read at the version seq and never opens a channel (criteria 1 and 3)', async () => {
    const calls: Call[] = [];
    const out = await openVersion(opener(fakeSync({ 7: spikeDocument() }, calls)), 7, {
      time: '2026-11-02T09:00:00Z',
      name: 'Signed',
    });
    expect(out.ok).toBe(true);
    expect(calls).toEqual([{ kind: 'loadContent', args: ['doc-1', 7] }]);
    if (out.ok) {
      expect(out.version.seq).toBe(7);
      expect(out.version.name).toBe('Signed');
      out.version.destroy();
    }
  });

  it('answers a version below the gate with forbidden and opens nothing (criterion 5)', async () => {
    const calls: Call[] = [];
    const out = await openVersion(opener(fakeSync({}, calls, 'forbidden')), 1, { time: 't' });
    expect(out).toEqual({ ok: false, reason: 'forbidden' });
    expect(calls.map((c) => c.kind)).toEqual(['loadContent']);
    expect(await openVersion(opener(fakeSync({}, [], 'not_found')), 1, { time: 't' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await openVersion(opener(fakeSync({}, [], 'boom')), 1, { time: 't' })).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('refuses a read that answers for another seq, and a document this build cannot open', async () => {
    const sync = fakeSync({ 5: spikeDocument() }, []);
    const wrong = {
      ...sync,
      loadContent: async () => ({
        seq: 6,
        incarnation: 'i',
        cdm: 1,
        requires: [],
        doc: spikeDocument().doc,
      }),
    };
    expect(await openVersion(opener(wrong as never), 5, { time: 't' })).toEqual({
      ok: false,
      reason: 'failed',
    });
    const future = {
      ...sync,
      loadContent: async () => ({
        seq: 5,
        incarnation: 'i',
        cdm: 99,
        requires: [],
        doc: spikeDocument().doc,
      }),
    };
    expect(await openVersion(opener(future as never), 5, { time: 't' })).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('shows the comment ranges of the version seq, as the service maps them (criterion 4)', async () => {
    const calls: Call[] = [];
    const asked: unknown[] = [];
    const pages: Record<string, { items: unknown[]; nextCursor: string | null }> = {
      first: {
        items: [
          { id: 't1', state: 'open', target: { range: { from: 3, to: 9, baseSeq: 7 } } },
          { id: 'block', state: 'open', target: { block: 'pIntro0000000001' } },
        ],
        nextCursor: 'more',
      },
      more: {
        items: [{ id: 't2', state: 'open', target: { range: { from: 12, to: 12, baseSeq: 7 } } }],
        nextCursor: null,
      },
    };
    const comments = {
      threads: (docId: string, query?: { seq?: number; cursor?: string }) => {
        asked.push([docId, query]);
        return Promise.resolve({ ...pages[query?.cursor ?? 'first']!, seq: query?.seq });
      },
    } as unknown as NonNullable<VersionOpener['comments']>;
    const r = await openVersion(
      { ...opener(fakeSync({ 10: spikeDocument() }, calls)), comments },
      10,
      { time: 't' },
    );
    if (!r.ok) throw new Error('did not open');
    // The read asks for the ranges at the version seq, page after page.
    expect(asked).toEqual([
      ['doc-1', { seq: 10 }],
      ['doc-1', { seq: 10, cursor: 'more' }],
    ]);
    expect(r.version.commentsShown).toBe(true);
    // A block thread has no range; a deleted one is detached; the others are as the service gave them.
    expect(r.version.commentRanges()).toEqual([
      { id: 't1', from: 3, to: 9, detached: false },
      { id: 't2', from: 12, to: 12, detached: true },
    ]);
    // Opening still read the content once and never opened a channel.
    expect(calls.map((c) => c.kind)).toEqual(['loadContent']);
  });

  it('opens without comment ranges when the host has no comments or the read fails (criterion 4)', async () => {
    const without = await openVersion(opener(fakeSync({ 10: spikeDocument() }, [])), 10, {
      time: 't',
    });
    if (!without.ok) throw new Error('did not open');
    expect(without.version.commentsShown).toBe(false);
    expect(without.version.commentRanges()).toEqual([]);

    const failing = {
      threads: () => Promise.reject(new PortError('not_found', 'this server has no comments')),
    } as unknown as NonNullable<VersionOpener['comments']>;
    const failed = await openVersion(
      { ...opener(fakeSync({ 10: spikeDocument() }, [])), comments: failing },
      10,
      { time: 't' },
    );
    if (!failed.ok) throw new Error('a version opens without its comments');
    expect(failed.version.commentsShown).toBe(false);
    expect(failed.version.commentRanges()).toEqual([]);
  });

  it('does not read the comments of a version it refused (criteria 4 and 5)', async () => {
    const asked: unknown[] = [];
    const comments = {
      threads: (...a: unknown[]) => {
        asked.push(a);
        return Promise.reject(new Error('must not be called'));
      },
    } as unknown as NonNullable<VersionOpener['comments']>;
    const r = await openVersion({ ...opener(fakeSync({}, [], 'forbidden')), comments }, 2, {
      time: 't',
    });
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
    expect(asked).toEqual([]);
  });
});
