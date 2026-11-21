// HIS-024 criterion 6: under the default setting `editors`, a person with `edit` somewhere in the
// document sees full history and everyone else sees named versions only (08 §9; ADR 0034 §2; owner
// decision 140). A viewer, with no setting made, reads the state at the head and at a named version
// and no other earlier state; a run that starts below the gate is refused even at a named version
// (a named version is a state, not a range). Over HTTP, memory and PostgreSQL. Test values only.
import { type StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const INTRO = 'pIntro0000000001';
const HEAD = 4;
const NAMED = 2;

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

async function appendOne(h: Harness, doc: string, text: string): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'his-024-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 'session-test',
    time: h.now(),
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [commit],
  });
  expect(r.status).toBe('ok');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the default setting editors: named versions only for everyone else (${storage}; HIS-024 criterion 6)`, async () => {
    const skip = await skipReason(storage);
    if (skip) console.warn(`skipped: ${skip}`);
    let h: Harness;
    let doc: string;
    let viewer: string;
    let editor: string;

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ content: documentWithRegions(), title: 'Named' });
      for (let i = 1; i <= HEAD; i++) {
        h.advance(10_000);
        await appendOne(h, doc, `c${i}`);
      }
      viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
      editor = h.userToken({ [doc]: 'editor' }, { sub: 'u-editor' });
      // No setting is made: the effective setting is `editors`.
      const view = await h.call('GET', `/v1/documents/${doc}/history-visibility`, {
        token: h.apiKey,
      });
      expect(view.json).toEqual({ setting: null, effective: 'editors', source: 'default' });
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    const get = (token: string, path: string) =>
      h.call('GET', `/v1/documents/${doc}${path}`, { token });

    it.skipIf(skip)('shows an editor every state, and a viewer the head only', async () => {
      for (let seq = 0; seq <= HEAD; seq++) {
        expect((await get(editor, `/content?seq=${seq}`)).status, `editor ${seq}`).toBe(200);
        const v = await get(viewer, `/content?seq=${seq}`);
        if (seq === HEAD) expect(v.status).toBe(200);
        else {
          expect(v.status, `viewer ${seq}`).toBe(403);
          expect(v.json.code).toBe('forbidden');
        }
      }
    });

    it.skipIf(skip)(
      'shows a viewer the state at a named version, and no other earlier state',
      async () => {
        const made = await h.call('POST', `/v1/documents/${doc}/versions`, {
          token: editor,
          body: { seq: NAMED, name: 'Sent to legal' },
        });
        expect(made.status, made.text).toBe(201);

        // A state read: content, the history up to it, the attribution, a comparison of two named or
        // head states, a thread read and an export, each at the named version.
        const states: Array<[string, () => Promise<{ status: number }>]> = [
          ['content', () => get(viewer, `/content?seq=${NAMED}`)],
          ['history toSeq', () => get(viewer, `/history?toSeq=${NAMED}`)],
          ['attribution', () => get(viewer, `/attribution?atSeq=${NAMED}`)],
          [
            'diff between a named version and the head',
            () => get(viewer, `/diff?fromSeq=${NAMED}&toSeq=${HEAD}`),
          ],
          ['threads', () => get(viewer, `/threads?seq=${NAMED}`)],
          ['field values', () => get(viewer, `/field-values?seq=${NAMED}`)],
        ];
        for (const [what, call] of states)
          expect((await call()).status, `${what} at the named version`).toBe(200);

        // The other earlier states stay refused.
        for (const seq of [0, 1, 3]) {
          const r = await get(viewer, `/content?seq=${seq}`);
          expect(r.status, `content at ${seq}`).toBe(403);
          expect((await get(viewer, `/attribution?atSeq=${seq}`)).status).toBe(403);
        }
        // A run is not a state: the commits after a named version, or a history from it, are refused.
        expect((await get(viewer, `/commits?after=${NAMED}`)).status).toBe(403);
        expect((await get(viewer, `/history?fromSeq=${NAMED + 1}`)).status).toBe(403);
        // A named version below the gate does not let a comparison start before it.
        expect((await get(viewer, `/diff?fromSeq=${NAMED - 1}&toSeq=${NAMED}`)).status).toBe(403);
        // The export at a named version is allowed, one at an unnamed earlier state is refused.
        const exp = (seq: number) =>
          h.call('POST', `/v1/documents/${doc}/exports`, {
            token: viewer,
            body: { target: 'pdf', seq },
          });
        expect((await exp(NAMED)).status).toBe(202);
        expect((await exp(1)).status).toBe(403);
      },
    );
  });
}
