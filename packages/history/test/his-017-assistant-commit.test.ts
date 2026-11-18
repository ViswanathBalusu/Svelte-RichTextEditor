// HIS-017 criterion 1: a commit made by an assistant acting under a delegated agent identity is
// recorded with the person it acted for, the agent and the origin `assistant`. The room stamps the
// commit from the connection (G6); this test runs that stored commit through the attribution map
// of `@docedit/history`, so the two halves are joined by a real commit and not by field names.
// How a connection obtains its agent identity is the open decision UX-044 (ADR 0234 Part A,
// proposed); this test gives the connection the identity and checks only what is recorded.
import { type Connection, type Effects, Room, type StoredCommit } from '@docedit/authority';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, applyCommit, authorLabel, commitAuthor } from '../src/attribution.ts';
import { REQUIRES, baseDoc, posInside, schema, typeAt, uuid } from './fixtures.ts';

const NOW = 1_790_000_000_000;

const person = (sub: string, agent?: string): Connection => ({
  sub,
  session: `s-${sub}`,
  role: 'editor',
  groups: [],
  participantRoles: [],
  participantActive: false,
  ...(agent !== undefined ? { agent } : {}),
});

function newRoom(): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: {
      revision: 1,
      grants: [],
      regionStates: new Map(),
      leases: [],
      documentState: 'active',
      workflowActive: false,
    },
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-his-017',
    now: () => NOW,
  });
}

/** Submits one insertion as `who`, stores it and returns the commit the observer is sent. */
function submitOne(who: Connection, origin: 'assistant' | 'input', text: string): StoredCommit {
  const r = newRoom();
  r.open('writer', who);
  r.open('observer', person('observer'));
  // An agent connection holds at most `suggest` (UX-044, UX-046), so its text is a suggestion.
  const tr =
    who.agent === undefined
      ? typeAt(baseDoc(), 'pIntro0000000001', 0, text)
      : new Transform(baseDoc()).insert(
          posInside(baseDoc(), 'pIntro0000000001'),
          schema.text(text, [
            schema.marks['ins']!.create({ id: 'sHis017000000001', user: who.sub }),
          ]),
        );
  const steps = tr.steps.map((s) => s.toJSON()) as unknown[];
  let fx: Effects = r.submit('writer', { id: uuid(), base: 0, steps, origin } as never);
  const all: Effects = { send: [...fx.send], write: null };
  let write = fx.write;
  while (write) {
    fx = r.writeCompleted({ status: 'ok' });
    all.send.push(...fx.send);
    write = fx.write;
  }
  const sent = all.send
    .filter((o) => o.channel === 'observer')
    .flatMap((o) => (o.msg.t === 'sync.commit' ? [o.msg.commit] : []));
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe('an assistant commit is recorded for the person and names the agent (HIS-017 criterion 1)', () => {
  it('stores the person, the agent and origin assistant, and the attribution names both', () => {
    const commit = submitOne(person('bob', 'assistant:drafting'), 'assistant', 'Drafted. ');
    expect(commit).toMatchObject({ user: 'bob', agent: 'assistant:drafting', origin: 'assistant' });
    expect(commitAuthor(commit)).toMatchObject({ user: 'bob', agent: 'assistant:drafting' });

    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, { user: 'owner', seq: 0 });
    applyCommit(map, commit as never, schema);
    const inserted = map.at(posInside(doc, 'pIntro0000000001'))!;
    expect(inserted).toMatchObject({ user: 'bob', agent: 'assistant:drafting' });
    expect(authorLabel(inserted)).toEqual({
      kind: 'assistant',
      user: 'bob',
      agent: 'assistant:drafting',
    });
  });

  it('control: the same person typing records no agent and is labelled as a person', () => {
    const commit = submitOne(person('bob'), 'input', 'Typed. ');
    expect(commit.agent).toBeUndefined();
    expect(commit.origin).toBe('input');
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, { user: 'owner', seq: 0 });
    applyCommit(map, commit as never, schema);
    const inserted = map.at(posInside(doc, 'pIntro0000000001'))!;
    expect(authorLabel(inserted)).toEqual({ kind: 'person', user: 'bob' });
  });
});
