// Lane V-UX-046-060, round 2: the room's answers to assistant writes (UX-046 criteria 4 and 5;
// UX-048 criterion 5 in its insertion half). Node.js only; the room is in-process, so no container
// is needed.
//
// - Criterion 4: an assistant result aimed at a scope where the author has no `suggest` (a viewer's
//   region) is refused with `permission_denied`, nothing is stored and the reason is sent back.
// - Criterion 5: a user who holds only `suggest` (the suggester) gets the assistant's result through
//   suggestion marks only. A direct insertion is refused under P4; the same text as an `ins` mark
//   naming the person is accepted, stored with origin `assistant` and the agent identity.
// - UX-048 criterion 5 (insertion half): LaTeX control sequences and delimiters, arriving as an
//   approved assistant result, are stored and shown as text nodes with no mark or attribute that
//   feeds LaTeX. The export side is in packages/export-latex/src/assistant-text.escape.test.ts.
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { RemoveMarkStep, ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { CommitInput, Effects, StoredCommit, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_770_100_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8100-${(++counter).toString(16).padStart(12, '0')}`;
/** Suggestion identifiers are 16 characters of [A-Za-z0-9_-] (I11). */
const suggestionId = (n: number) => `s046A${n.toString().padStart(11, '0')}`;

function room(): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-ux-046-v',
    now: () => ++clock,
  });
}

/** Inserts `text` at the start of the textblock `paraId`, as plain text or as an `ins` suggestion. */
function insertion(paraId: string, text: string, suggestBy?: { user: string; mark: string }) {
  const doc = baseDoc();
  const pos = posInside(doc, paraId, 0);
  const marks = suggestBy
    ? [schema.marks['ins']!.create({ id: suggestBy.mark, user: suggestBy.user })]
    : [];
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text, marks)), 0, 0)),
  ]);
}

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}
function rejectOf(fx: Effects, channel: string) {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.reject');
  return m && m.t === 'sync.reject' ? m : null;
}
function ackOf(fx: Effects, channel: string): boolean {
  return msgs(fx, channel).some((x) => x.t === 'sync.ack');
}
function stored(fx: Effects, observer: string): StoredCommit[] {
  return msgs(fx, observer).flatMap((m) => (m.t === 'sync.commit' ? [m.commit] : []));
}
/** Stores whatever the room asks to write, as the room tests do. */
function flush(r: Room, fx: Effects): Effects {
  const all: Effects = { send: [...fx.send], write: null };
  let write = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    all.send.push(...done.send);
    write = done.write;
  }
  return all;
}

/** The text nodes of a paragraph, with their marks, as plain data. */
function paragraphRuns(doc: Node, paraId: string): { text: string; marks: string[] }[] {
  let runs: { text: string; marks: string[] }[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'paragraph' && n.attrs['id'] === paraId) {
      runs = [];
      n.forEach((c) =>
        runs.push({ text: c.text ?? `<${c.type.name}>`, marks: c.marks.map((m) => m.type.name) }),
      );
      return false;
    }
    return true;
  });
  return runs;
}

describe('UX-046 criterion 4: a result aimed at a scope without suggest is refused and nothing is applied', () => {
  it('refuses an assistant result for a viewer in the inherit region, tells the submitter, stores nothing', () => {
    const r = room();
    r.open('x-f', { ...USERS.frank, session: 's-ux046-f', agent: 'assistant:drafting' });
    r.open('a1', USERS.alice);
    const steps = insertion('pNotes000000001C', 'Assistant text for notes.', {
      user: 'frank',
      mark: suggestionId(1),
    });
    const fx = flush(
      r,
      r.submit('x-f', { id: id(), base: 0, steps, origin: 'assistant' } as CommitInput),
    );
    const reject = rejectOf(fx, 'x-f');
    expect(reject?.code).toBe('permission_denied');
    expect(reject?.reason.length).toBeGreaterThan(0);
    expect(stored(fx, 'a1')).toEqual([]);
    expect(paragraphRuns(r.document, 'pNotes000000001C')).toEqual([
      { text: 'Notes go here.', marks: [] },
    ]);
  });
});

describe("UX-046 criterion 5: a suggester's assistant writes obey P4 and the agent holds no more than the user", () => {
  const agentForSuggester = { ...USERS.dave, session: 's-ux046-d', agent: 'assistant:drafting' };

  it("refuses the assistant's direct insertion for a suggester (no suggestion mark), as P4 requires", () => {
    const r = room();
    r.open('x-d', agentForSuggester);
    r.open('a1', USERS.alice);
    const fx = flush(
      r,
      r.submit('x-d', {
        id: id(),
        base: 0,
        steps: insertion('pLegal000000001B', 'direct'),
        origin: 'assistant',
      } as CommitInput),
    );
    expect(rejectOf(fx, 'x-d')?.code).toBe('permission_denied');
    expect(stored(fx, 'a1')).toEqual([]);
  });

  it('accepts the same result as a suggestion naming the suggester, stored with origin assistant and the agent', () => {
    const r = room();
    r.open('x-d2', agentForSuggester);
    r.open('a1', USERS.alice);
    const steps = insertion('pLegal000000001B', 'Suggested by the assistant.', {
      user: 'dave',
      mark: suggestionId(2),
    });
    const fx = flush(
      r,
      r.submit('x-d2', { id: id(), base: 0, steps, origin: 'assistant' } as CommitInput),
    );
    expect(rejectOf(fx, 'x-d2')).toBeNull();
    expect(ackOf(fx, 'x-d2')).toBe(true);
    expect(stored(fx, 'a1')[0]).toMatchObject({
      user: 'dave',
      origin: 'assistant',
      agent: 'assistant:drafting',
    });
    const runs = paragraphRuns(r.document, 'pLegal000000001B');
    expect(runs[0]).toEqual({ text: 'Suggested by the assistant.', marks: ['ins'] });
  });

  it('stores origin assistant for a verified agent connection whatever the client sends, and keeps a claim on a user connection', () => {
    const r = room();
    r.open('x-d3', agentForSuggester);
    r.open('x-u', USERS.dave);
    r.open('a1', USERS.alice);
    const asAgent = flush(
      r,
      r.submit('x-d3', {
        id: id(),
        base: 0,
        steps: insertion('pLegal000000001B', 'One. ', { user: 'dave', mark: suggestionId(3) }),
        origin: 'input',
      } as CommitInput),
    );
    expect(ackOf(asAgent, 'x-d3')).toBe(true);
    expect(stored(asAgent, 'a1')[0]).toMatchObject({
      origin: 'assistant',
      agent: 'assistant:drafting',
    });
    // A user connection that claims ssistant has no agent: the claim stays a claim (04 section 2).
    const asUser = flush(
      r,
      r.submit('x-u', {
        id: id(),
        base: 1,
        steps: insertion('pLegal000000001B', 'Two. ', { user: 'dave', mark: suggestionId(4) }),
        origin: 'assistant',
      } as CommitInput),
    );
    const claimed = stored(asUser, 'a1')[0]!;
    expect(claimed.agent).toBeUndefined();
  });

  it("an editor accepting the assistant's suggestion is stored as the editor's own action, with origin suggestion.accept and no agent", () => {
    const r = room();
    r.open('x-d5', agentForSuggester);
    r.open('a1', USERS.alice);
    const text = 'Accept me. ';
    const made = flush(
      r,
      r.submit('x-d5', {
        id: id(),
        base: 0,
        steps: insertion('pLegal000000001B', text, { user: 'dave', mark: suggestionId(5) }),
        origin: 'assistant',
      } as CommitInput),
    );
    expect(stored(made, 'a1')[0]).toMatchObject({ user: 'dave', agent: 'assistant:drafting' });
    const pos = posInside(baseDoc(), 'pLegal000000001B', 0);
    const mark = schema.marks['ins']!.create({ id: suggestionId(5), user: 'dave' });
    const accept = stepsToJson([new RemoveMarkStep(pos, pos + text.length, mark)]);
    const fx = flush(
      r,
      r.submit('a1', {
        id: id(),
        base: 1,
        steps: accept,
        origin: 'suggestion.accept',
      } as CommitInput),
    );
    expect(rejectOf(fx, 'a1')).toBeNull();
    const decided = stored(fx, 'x-d5').find((c) => c.origin === 'suggestion.accept');
    expect(decided).toMatchObject({ user: 'alice', origin: 'suggestion.accept' });
    expect(decided?.agent).toBeUndefined();
  });
});

describe('UX-048 criterion 5 (insertion half): LaTeX text from an approved result is stored as literal text', () => {
  const attack = [
    '\\section{Injected}',
    '\\input{/etc/passwd}',
    '\\write18{rm -rf /}',
    '$x^2$ and $$y$$',
    '%comment \\newcommand',
    '{\\catcode`\\%=0 }',
    '#1 & ~ _ ^ {}',
  ].join(' ');

  it('inserts the strings as plain text nodes that carry only the suggestion mark, nothing LaTeX reads', () => {
    const r = room();
    r.open('x-d3', { ...USERS.dave, session: 's-ux048-d', agent: 'assistant:drafting' });
    r.open('a1', USERS.alice);
    const fx = flush(
      r,
      r.submit('x-d3', {
        id: id(),
        base: 0,
        steps: insertion('pIntro0000000001', attack, { user: 'dave', mark: suggestionId(3) }),
        origin: 'assistant',
      } as CommitInput),
    );
    expect(rejectOf(fx, 'x-d3')).toBeNull();
    expect(ackOf(fx, 'x-d3')).toBe(true);
    const runs = paragraphRuns(r.document, 'pIntro0000000001');
    expect(runs[0]).toEqual({ text: attack, marks: ['ins'] });
    // The inserted node is text, so no attribute of it can feed a LaTeX command.
    let nonText = 0;
    r.document.descendants((n) => {
      if (n.type.name === 'paragraph' && n.attrs['id'] === 'pIntro0000000001') {
        n.forEach((c) => {
          if (!c.isText) nonText += 1;
        });
      }
      return true;
    });
    expect(nonText).toBe(0);
  });
});
