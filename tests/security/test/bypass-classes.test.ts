/**
 * SEC-021 — the known ways of escaping the writable set each have a named fixture that runs on
 * every build against the real service (10 §3.3; 07 §5). The authority's property tests and oracle
 * (PRM-017, packages/authority/test/harness) are the exhaustive check; this file is the regression
 * gate that the bypass classes stay closed end to end, over the wire.
 *
 * The document has a restricted region `rLegal0000000001`; a document-level editor holds no grant
 * there, so every attempt to change it must be refused with `permission_denied` and that scope.
 */
import { AddMarkStep, AttrStep, ReplaceAroundStep, ReplaceStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { at, Fragment, inside, loadDoc, schema, Slice, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

const LEGAL = 'rLegal0000000001';
const LEGAL_SCOPE = `region:${LEGAL}`;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-021 known bypass classes stay closed (${storage})`, () => {
    let h: Harness;
    let doc: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the CDM content envelope
    let content: any;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
        content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json;
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** A welcomed, opened client for a document role. */
    const client = async (role: string) => {
      const token = await h.mintToken(h.a, `u-${role}`, { [doc]: role });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      return c;
    };

    /** Submits steps built against the current content as `role`, returns the answer. */
    const submitAs = async (role: string, steps: Record<string, unknown>[]) => {
      const c = await client(role);
      try {
        return await c.submit(1, { id: uuid7(), base: 0, steps });
      } finally {
        c.terminate();
      }
    };

    // The named bypass fixtures of 10 §3.3 / 07 §16, each built against the restricted region.
    t()('attr step with an empty position map on a restricted region is refused', async () => {
      const d = loadDoc(content.doc);
      // An attr step maps no positions, so a range-based check would not see which scope it touches.
      const steps = stepsJson([new AttrStep(at(d, 'pLegal0000000001'), 'align', 'end')]);
      const r = await submitAs('editor', steps);
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
      expect(r.d?.['scopes']).toContain(LEGAL_SCOPE);
    });

    t()('mark step with an empty position map on a restricted region is refused', async () => {
      const d = loadDoc(content.doc);
      const from = inside(d, 'pLegal0000000001');
      const steps = stepsJson([
        new AddMarkStep(from, from + 'Liability'.length, schema.marks['bold']!.create()),
      ]);
      const r = await submitAs('editor', steps);
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
      expect(r.d?.['scopes']).toContain(LEGAL_SCOPE);
    });

    t()('a crafted replaceAround that restyles a restricted paragraph is refused', async () => {
      const d = loadDoc(content.doc);
      const p = at(d, 'pLegal0000000001');
      const para = d.nodeAt(p)!;
      const steps = stepsJson([
        new ReplaceAroundStep(
          p,
          p + para.nodeSize,
          p + 1,
          p + para.nodeSize - 1,
          new Slice(
            Fragment.from(schema.nodes['paragraph']!.create({ ...para.attrs, align: 'end' })),
            0,
            0,
          ),
          1,
          true,
        ),
      ]);
      const r = await submitAs('editor', steps);
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
      expect(r.d?.['scopes']).toContain(LEGAL_SCOPE);
    });

    t()('a bare region token deleted on its own cannot apply and is refused', async () => {
      const d = loadDoc(content.doc);
      const p = at(d, LEGAL);
      // Delete just the region's opening token with an empty slice. ProseMirror cannot apply this
      // ("Inconsistent open depths"), so it never reaches the outcome check; the removal that
      // does apply is the next fixture. Here the point is only that nothing is stored.
      const step = new ReplaceStep(p, p + 1, Slice.empty);
      expect(step.apply(d).failed).not.toBeNull();
      const steps = stepsJson([step]);
      const r = await submitAs('editor', steps);
      expect(r.t).toBe('sync.reject');
      expect(['permission_denied', 'invalid_op', 'rebase_failed']).toContain(r.d?.['code']);
      // The region is still there and whole.
      const after = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
        .json;
      expect(JSON.stringify(after.doc)).toContain(LEGAL);
    });

    /** The stored document is still the one every fixture was built against. */
    const expectUnchanged = async () => {
      const after = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
        .json;
      expect(after.doc).toEqual(content.doc);
    };

    // Removing exactly one region boundary (P3). The step below applies cleanly in ProseMirror:
    // it deletes the restricted region's closing token together with the opening token of the
    // region after it, so the two regions join and pOpen moves into the restricted region.
    t()('removing exactly one region boundary, the closing token, is refused (P3)', async () => {
      const d = loadDoc(content.doc);
      const legalPos = at(d, LEGAL);
      const legal = d.nodeAt(legalPos)!;
      const step = new ReplaceStep(
        legalPos + legal.nodeSize - 1,
        inside(d, 'rOpen00000000001'),
        Slice.empty,
      );
      const local = step.apply(d);
      expect(local.failed).toBeNull();
      // Locally the restricted region now ends with pOpen and the open region is gone.
      const joined = local.doc!.nodeAt(at(local.doc!, LEGAL))!;
      expect(joined.childCount).toBe(2);
      expect(joined.lastChild!.attrs['id']).toBe('pOpen00000000001');
      expect(JSON.stringify(local.doc!.toJSON())).not.toContain('rOpen00000000001');
      const r = await submitAs('editor', stepsJson([step]));
      expect(r.t).toBe('sync.reject');
      // Measured (lane V-SEC-017-032, round 4): the service answers invalid_op with the P3 message
      // on both memory and PostgreSQL storage, so the code is pinned here.
      expect(r.d?.['code']).toBe('invalid_op');
      expect(String(r.d?.['message'])).toContain('removes one boundary of region');
      await expectUnchanged();
    });

    // Inserting exactly one region boundary (P3). A slice that carries one region token but not
    // its partner moves that boundary: content crosses into or out of the region. Each step below
    // applies cleanly in ProseMirror, so only the authority stands between it and the log.
    t()('inserting exactly one region boundary, an unbalanced open, is refused (P3)', async () => {
      const d = loadDoc(content.doc);
      const intro = at(d, 'pIntro0000000001');
      const legal = d.nodeAt(at(d, LEGAL))!;
      // Replace [pIntro, just inside the region) with a slice that opens the region but does not
      // close it: one opening token is inserted before pIntro and the old one is taken away, so
      // pIntro is pulled into the restricted region.
      const step = new ReplaceStep(
        intro,
        inside(d, LEGAL),
        new Slice(
          Fragment.from(schema.nodes['region']!.create(legal.attrs, d.nodeAt(intro)!)),
          0,
          1,
        ),
      );
      const local = step.apply(d);
      expect(local.failed).toBeNull();
      expect(local.doc!.nodeAt(at(local.doc!, LEGAL))!.firstChild!.attrs['id']).toBe(
        'pIntro0000000001',
      );
      const r = await submitAs('editor', stepsJson([step]));
      expect(r.t).toBe('sync.reject');
      expect(['permission_denied', 'invalid_op']).toContain(r.d?.['code']);
      await expectUnchanged();
    });

    t()('inserting exactly one region boundary, an unbalanced close, is refused (P3)', async () => {
      const d = loadDoc(content.doc);
      const legalPos = at(d, LEGAL);
      const legal = d.nodeAt(legalPos)!;
      const open = d.nodeAt(at(d, 'pOpen00000000001'))!;
      // Replace [just before the region's closing token, pEnd) with a slice that closes the region
      // but does not open it: the closing token moves past the open part, so pOpen is swallowed.
      const step = new ReplaceStep(
        legalPos + legal.nodeSize - 1,
        at(d, 'pEnd000000000001'),
        new Slice(Fragment.from(schema.nodes['region']!.create(legal.attrs, open)), 1, 0),
      );
      const local = step.apply(d);
      expect(local.failed).toBeNull();
      expect(local.doc!.nodeAt(at(local.doc!, LEGAL))!.lastChild!.attrs['id']).toBe(
        'pOpen00000000001',
      );
      const r = await submitAs('editor', stepsJson([step]));
      expect(r.t).toBe('sync.reject');
      expect(['permission_denied', 'invalid_op']).toContain(r.d?.['code']);
      await expectUnchanged();
    });

    t()('a bare unbalanced region token inserted at one point is refused (P3)', async () => {
      const d = loadDoc(content.doc);
      const legalPos = at(d, LEGAL);
      const legal = d.nodeAt(legalPos)!;
      // Insert, without removing anything, a slice holding one closing region token. ProseMirror
      // cannot place it, so the step must be refused rather than throw or be stored.
      const q = legalPos + legal.nodeSize - 1;
      const step = new ReplaceStep(
        q,
        q,
        new Slice(
          Fragment.from([
            schema.nodes['region']!.create(legal.attrs, legal.firstChild!),
            d.nodeAt(at(d, 'pEnd000000000001'))!,
          ]),
          1,
          0,
        ),
      );
      expect(step.apply(d).failed).not.toBeNull();
      const r = await submitAs('editor', stepsJson([step]));
      expect(r.t).toBe('sync.reject');
      expect(['permission_denied', 'invalid_op']).toContain(r.d?.['code']);
      await expectUnchanged();
    });

    t()('reusing a node identifier is refused (I2)', async () => {
      const d = loadDoc(content.doc);
      // I2: a non-null id never changes; giving pIntro another node's id is refused.
      const steps = stepsJson([new AttrStep(at(d, 'pIntro0000000001'), 'id', 'pEnd000000000001')]);
      const r = await submitAs('editor', steps);
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('invalid_op');
    });

    t()('re-creating a deleted region to inherit its grants is refused (I3)', async () => {
      // Owner deletes the restricted region, then tries to insert a region with the same id.
      const owner = await client('owner');
      try {
        const d0 = loadDoc(content.doc);
        const p = at(d0, LEGAL);
        const legal = d0.nodeAt(p)!;
        const del = await owner.submit(1, {
          id: uuid7(),
          base: 0,
          steps: stepsJson([new ReplaceStep(p, p + legal.nodeSize, Slice.empty)]),
        });
        expect(del.t).toBe('sync.ack');
        const after = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
          .json;
        const d1 = loadDoc(after.doc);
        const end = at(d1, 'pEnd000000000001');
        const again = await owner.submit(1, {
          id: uuid7(),
          base: 1,
          steps: stepsJson([new ReplaceStep(end, end, new Slice(Fragment.from(legal), 0, 0))]),
        });
        // A retired region identifier can never be reused (I3): the re-creation is refused and the
        // region does not come back, so it cannot inherit the old grants.
        expect(again.t).toBe('sync.reject');
        const final = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
          .json;
        const regionIds = (
          final.doc.content.at(-1).content as Array<{ type: string; attrs?: { id?: string } }>
        )
          .filter((n) => n.type === 'region')
          .map((n) => n.attrs?.id);
        expect(regionIds).not.toContain(LEGAL);
      } finally {
        owner.terminate();
      }
    });

    t()('a change in the doc/defs scope without structure is refused', async () => {
      // A suggester has neither edit nor structure; changing a shared style definition is refused.
      const d = loadDoc(content.doc);
      const steps = stepsJson([new AttrStep(at(d, 'Normal'), 'name', 'Renamed')]);
      const r = await submitAs('suggester', steps);
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
    });

    t()('viewers and commenters are refused any commit with permission_denied (P6)', async () => {
      const d = loadDoc(content.doc);
      const steps = stepsJson([
        new ReplaceStep(
          inside(d, 'pIntro0000000001'),
          inside(d, 'pIntro0000000001'),
          new Slice(Fragment.from(schema.text('x')), 0, 0),
        ),
      ]);
      for (const role of ['viewer', 'commenter']) {
        const r = await submitAs(role, steps);
        expect(r.t, role).toBe('sync.reject');
        expect(r.d?.['code'], role).toBe('permission_denied');
      }
    });

    t()('a normal edit by a document editor in the open body still succeeds', async () => {
      // The gate is specific: the same editor can write where it holds edit.
      const r = await submitAs('editor', [
        insertText(inside(loadDoc(content.doc), 'pIntro0000000001'), 'Z'),
      ]);
      expect(r.t).toBe('sync.ack');
    });
  });
}
