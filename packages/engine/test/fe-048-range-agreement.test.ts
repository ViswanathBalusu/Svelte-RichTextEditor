/**
 * The client's comment ranges agree with the authority's `mapRangesThrough` on shared fixtures
 * (FE-048 criterion 3). The client maps the live step maps of each transaction as it is applied;
 * the authority maps the stored log, which is each commit's steps as JSON, read back with
 * `Step.fromJSON`. The two paths are different code, so agreement after every commit is a real
 * cross-check and not a restatement of one function.
 */
import { mapRangesThrough } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import type { Transaction } from 'prosemirror-state';
import { CommentRanges } from '../src/comment-ranges.ts';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { posOf } from './support.ts';

const microtask = (run: () => void) => queueMicrotask(run);

/**
 * One fixture commit: it adds steps to the transaction it is given. `from` and `to` are the range
 * as the client holds it before this commit.
 */
type Commit = (tr: Transaction, from: number, to: number) => void;

const FIXTURES: { name: string; commits: Commit[] }[] = [
  {
    name: 'insertion before the range',
    commits: [(tr, from) => tr.insertText('Big ', from)],
  },
  {
    name: 'insertion inside the range',
    commits: [(tr, from) => tr.insertText('x', from + 2)],
  },
  {
    name: 'insertion at the end edge of the range',
    commits: [(tr, _from, to) => tr.insertText('!', to)],
  },
  {
    name: 'deletion of the whole range (collapses and detaches)',
    commits: [(tr, from, to) => tr.delete(from, to)],
  },
  {
    name: 'deletion overlapping the start of the range',
    commits: [(tr, from) => tr.delete(from, from + 2)],
  },
  {
    name: 'two steps in one commit, both at the start edge',
    commits: [
      (tr, from) => {
        tr.insertText('Z', from);
        tr.insertText('Y', from + 1);
      },
    ],
  },
  {
    name: 'a sequence of commits: insert inside, delete inside, then delete the range',
    commits: [
      (tr, from) => tr.insertText('ab', from + 1),
      (tr, from) => tr.delete(from + 1, from + 3),
      (tr, from, to) => tr.delete(from, to),
    ],
  },
];

function fresh(): { core: DocumentCore; from: number; to: number } {
  const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(core);
  const from = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
  return { core, from, to: from + 4 };
}

describe('client comment ranges agree with the authority mapping (FE-048 criterion 3)', () => {
  for (const fixture of FIXTURES) {
    it(`agrees with mapRangesThrough after every commit: ${fixture.name}`, () => {
      const { core, from, to } = fresh();
      const client = new CommentRanges();
      client.set('thread', { from, to }, 1);
      const log: { steps: unknown[] }[] = [];

      fixture.commits.forEach((commit, n) => {
        const held = client.get('thread')!;
        const i = internals(core);
        const tr = i.state.tr;
        commit(tr, held.from, held.to);
        log.push({ steps: tr.steps.map((s) => s.toJSON()) });
        i.dispatch(tr);
        client.apply(tr.mapping.maps, n + 2);

        const authority = mapRangesThrough([{ from, to }], log, i.state.schema)[0]!;
        const c = client.get('thread')!;
        expect({ from: c.from, to: c.to, detached: c.detached }).toEqual({
          from: authority.from,
          to: authority.to,
          detached: authority.collapsed,
        });
      });
    });
  }
});
