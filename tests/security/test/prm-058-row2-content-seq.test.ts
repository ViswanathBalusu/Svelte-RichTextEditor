// PRM-058 criterion 1 (07 §12 row 2): reads at an earlier `seq` need `view` and the history gate
// (PRM-041, PRM-042) together, on the wire routes `content?seq=`, `commits?after=` and
// `field-values?seq=`. Lane U-PRM-052-067. Memory and PostgreSQL (when the integration
// environment is up). On each route:
//   - an outsider (a role on another document only) is refused by `view`: 403 `forbidden`;
//   - a viewer has `view` (the head answers 200) but the default history setting (`editors`)
//     hides earlier states from viewers: 403 `forbidden` from the gate, whose detail says so;
//   - an editor has `view` and the gate lets it read the earlier state: 200.
// The gate and the view refusal share the code `forbidden` (gate.ts, `refuseBelowGate`); the
// detail and the 200 at the head tell them apart.
import type { StoredCommit } from '@docedit/authority';
import type { DocRef } from '@docedit/document-service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const BODY_PARAGRAPH = 'pIntro0000000001';

/** Appends one text insert to the body as a stored commit, as the room would (the test seeds history). */
async function appendText(h: Harness, doc: string, text: string): Promise<void> {
  const ref: DocRef = { tenant: h.a.id, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const content = await h.service.content.rebuild(ref, head.incarnation, head.seq);
  const pos = posInside(content.doc, BODY_PARAGRAPH);
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: pos,
        to: pos,
        slice: { content: [{ type: 'text', text }] },
      },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 's',
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
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-058 row 2: content at an earlier seq (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip !== null)(
      'refuses an outsider by view, a viewer by the history gate, and serves an editor an earlier state',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const other = await h.createDocument(h.a, documentWithRegions());
        await appendText(h, doc, 'a');
        await appendText(h, doc, 'b');
        const head = await h.parts.logs.head({ tenant: h.a.id, doc });
        const earlier = head.seq - 1;
        expect(earlier).toBeGreaterThanOrEqual(1);

        const outsider = await h.mintToken(h.a, 'outsider-row2', { [other]: 'owner' });
        const viewer = await h.mintToken(h.a, 'viewer-row2', { [doc]: 'viewer' });
        const editor = await h.mintToken(h.a, 'editor-row2', { [doc]: 'editor' });

        // The served routes that read at an earlier seq: content and commits (row 2), the field
        // values, which are content read by key (FRW-060 criterion 4), the comparison, the
        // attribution and the threads at a state (lane w9). `history` is in the OpenAPI document but
        // the control plane does not serve it yet (HIS-026). The thread list answers a caller with no
        // role on the document as `not_found`, so as not to say that the document exists.
        // `detail`: whether the refusal keeps the gate's own detail. A user's commits page comes
        // from the data plane (`RoomHost.readCommits`), whose refusal the pipeline passes on as
        // its code only (`registryRefusal`); there the 200 at the head shows the gate was the cause.
        const routes = [
          {
            name: 'content',
            detail: true,
            at: (s: number) => `/v1/documents/${doc}/content?seq=${s}`,
          },
          {
            name: 'commits',
            detail: false,
            at: (s: number) => `/v1/documents/${doc}/commits?after=${s}`,
          },
          {
            name: 'field-values',
            detail: true,
            at: (s: number) => `/v1/documents/${doc}/field-values?seq=${s}`,
          },
          {
            name: 'diff',
            detail: false,
            at: (s: number) => `/v1/documents/${doc}/diff?fromSeq=${s}&toSeq=${head.seq}`,
          },
          {
            name: 'attribution',
            detail: false,
            at: (s: number) => `/v1/documents/${doc}/attribution?atSeq=${s}`,
          },
          {
            name: 'threads',
            detail: true,
            outsider: { status: 404, code: 'not_found' },
            at: (s: number) => `/v1/documents/${doc}/threads?seq=${s}`,
          },
        ];
        const problem = (r: { json?: unknown }) =>
          (r.json ?? {}) as { code?: string; detail?: string };

        for (const route of routes) {
          // `view` is required: a token without a role on this document is `forbidden` (07 §12).
          const byOutsider = await h.call('GET', route.at(earlier), { token: outsider });
          const refused = route.outsider ?? { status: 403, code: 'forbidden' };
          expect(byOutsider.status, route.name).toBe(refused.status);
          expect(problem(byOutsider).code, route.name).toBe(refused.code);
          expect(problem(byOutsider).detail ?? '', route.name).not.toMatch(/history visibility/);

          // The viewer holds `view`: the same route at the head answers.
          const atHead = await h.call('GET', route.at(head.seq), { token: viewer });
          expect(atHead.status, `${route.name} at the head: ${atHead.text}`).toBe(200);

          // The gate is required too: under the default `editors` a viewer's gate is the head, so
          // the earlier seq is refused by the gate (07 §8; `refuseBelowGate`, `rangeVisible`).
          const byViewer = await h.call('GET', route.at(earlier), { token: viewer });
          expect(byViewer.status, `${route.name}: ${byViewer.text}`).toBe(403);
          expect(problem(byViewer).code, route.name).toBe('forbidden');
          if (route.detail)
            expect(problem(byViewer).detail ?? '', route.name).toMatch(
              /below the history visibility of the caller/,
            );

          // With both, the earlier state is served.
          const byEditor = await h.call('GET', route.at(earlier), { token: editor });
          expect(byEditor.status, `${route.name}: ${byEditor.text}`).toBe(200);
        }
      },
    );
  });
}
