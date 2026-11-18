/**
 * PRM-060 criterion 7 (07 §16 row 8; review 3.2 S-08): text that was typed and then deleted stays
 * out of reach of a reader below the history gate (07 §8; ADR 0034) on each surface that could
 * show it: an old version (`GET /content?seq=`), the catch-up of a resumed channel (`resume.seq`),
 * and the activity list (`GET /activity`). The running service is the real one, in memory.
 *
 * The log is: commit 1 types a marker text, commit 2 deletes it, commit 3 types other text. Under
 * the default setting `editors` a viewer's gate is the head (3), so states 0 to 2 are behind it.
 * The marker is in states 1 only; no reply to the viewer may contain it, whatever the surface.
 * An owner has `edit` and so reads it, which shows that the refusals are the gate's and not an
 * absent state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import type { DocRef } from '../../../services/document-service/src/storage/types.ts';
import { documentWithRegions, posInside, startHarness, type Harness } from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const INTRO = 'pIntro0000000001';
const SECRET = 'DELETED-MARKER-TEXT';

describe('PRM-060 criterion 7: deleted text and the history surfaces (memory)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory');
  });
  afterAll(async () => {
    await h?.close();
  });

  /** A document whose log types the marker (1), deletes it (2) and types more text (3). */
  async function documentWithDeletion(): Promise<string> {
    const content = documentWithRegions();
    const doc = await h.createDocument(h.a, content);
    const ref: DocRef = { tenant: h.a.id, doc };
    const epoch = await h.parts.ownership.claim(ref, 'prm-060-node');
    const head = await h.parts.logs.head(ref);
    const perms = await h.parts.grants.current(ref);
    const at = posInside(content['doc'], INTRO);
    const base = {
      kind: 'steps',
      user: 'u-alice',
      session: 'session-test',
      origin: 'input',
      scopes: ['body'],
      revision: perms.revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [],
      claimed: [],
    } satisfies Omit<StoredCommit, 'seq' | 'id' | 'steps' | 'time'>;
    const steps: unknown[][] = [
      [
        {
          stepType: 'replace',
          from: at,
          to: at,
          slice: { content: [{ type: 'text', text: SECRET }] },
        },
      ],
      [{ stepType: 'replace', from: at, to: at + SECRET.length }],
      [
        {
          stepType: 'replace',
          from: at,
          to: at,
          slice: { content: [{ type: 'text', text: 'later' }] },
        },
      ],
    ];
    const commits = steps.map((s, i): StoredCommit => ({
      ...base,
      seq: head.seq + 1 + i,
      id: uuid7(),
      steps: s as StoredCommit['steps'],
      time: h.now(),
    }));
    const r = await h.parts.logs.append(ref, {
      epoch,
      revision: perms.revision,
      fromSeq: head.seq + 1,
      commits,
    });
    expect(r.status).toBe('ok');
    return doc;
  }

  it('refuses the old version, the catch-up and the activity of a viewer, and none of them shows the text', async () => {
    const doc = await documentWithDeletion();
    const owner = h.userToken(h.a, 'owner-1', { [doc]: 'owner' });
    const viewerToken = h.userToken(h.a, 'carol', { [doc]: 'viewer' });
    const content = (seq: number, token: string) =>
      h.call('GET', `/v1/documents/${doc}/content?seq=${seq}`, { token });

    // The marker exists in the log: a reader with `edit` reads it at seq 1.
    const full = await content(1, owner);
    expect(full.status, full.text).toBe(200);
    expect(full.text).toContain(SECRET);

    // Old versions: every state below the head is refused; the head is served without the text.
    for (const seq of [0, 1, 2]) {
      const r = await content(seq, viewerToken);
      expect(r.status, `seq ${seq}`).toBe(403);
      expect(r.text).not.toContain(SECRET);
    }
    const head = await content(3, viewerToken);
    expect(head.status, head.text).toBe(200);
    expect(head.text).not.toContain(SECRET);

    // Activity: an owner sees the three changes; the viewer sees none below the gate.
    const all = await h.call('GET', `/v1/documents/${doc}/activity`, { token: owner });
    expect(all.status, all.text).toBe(200);
    expect(all.json.items.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3]);
    const own = await h.call('GET', `/v1/documents/${doc}/activity`, { token: viewerToken });
    expect(own.status, own.text).toBe(200);
    expect(own.json.items.map((i: { seq: number }) => i.seq)).toEqual([3]);
    expect(own.text).not.toContain(SECRET);

    // Catch-up: a viewer who resumes from seq 1 is not streamed commits 2 and 3 (commit 2 would
    // reveal what was deleted); the channel reloads the content at the head instead.
    const first = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    const second = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      expect((await first.hello(viewerToken)).t).toBe('welcome');
      const opened = await first.open(1, doc);
      expect(opened.t).toBe('ch.opened');

      expect((await second.hello(viewerToken)).t).toBe('welcome');
      const resumed = await second.open(1, doc, {
        resume: { seq: 1, incarnation: opened.d!['incarnation'], view: opened.d!['view'] },
      });
      expect(resumed.t, JSON.stringify(resumed)).toBe('ch.opened');
      expect(resumed.d!['catchUp']).toBe('reload');
      expect(JSON.stringify(resumed)).not.toContain(SECRET);
      // Nothing that follows carries the text or a commit below the gate.
      await new Promise((r) => setTimeout(r, 300));
      expect(JSON.stringify(second.all('sync.commit'))).not.toContain(SECRET);
      expect(second.all('sync.commit')).toHaveLength(0);
    } finally {
      first.close();
      second.close();
    }
  });
});
