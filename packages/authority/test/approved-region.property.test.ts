// PRM-047: an approved region stays as approved while a stream of commits runs around it. Field
// values are outside the approval hash (SR-M25; the answer to the open question in PRM-047), so
// only fills under P7 may change the region; everything else is refused.
import { sha256Hex } from '@docedit/model';
import fc from 'fast-check';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { PermissionState } from '../src/permissions/model.ts';
import { regionCanonicalText } from '../src/permissions/states.ts';
import { stepsToJson } from '../src/steps.ts';
import { USERS, posInside, posOf, schema } from './fixtures.ts';
import {
  FIELDS,
  MORE,
  commitId,
  fieldsDoc,
  morePermissions,
  rejection,
  roomWith,
} from './permission-fixtures.ts';

const TERMS = 'rTerms000000000A';
const NOW = 1_770_700_000_000;

const approvedPerms = (): PermissionState => ({
  ...morePermissions(),
  regionStates: new Map([[TERMS, 'approved' as const]]),
});

const typeAt = (doc: Node, at: string, text: string) => {
  const pos = posInside(doc, at);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
};

type Op =
  | { kind: 'fill'; value: string }
  | { kind: 'intro'; text: string }
  | { kind: 'comment' }
  | { kind: 'attack-text'; text: string }
  | { kind: 'attack-restyle'; colour: string };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('fill' as const),
    value: fc.string({ minLength: 1, maxLength: 12 }),
  }),
  fc.record({ kind: fc.constant('intro' as const), text: fc.constantFrom('a ', 'bc ', 'd ') }),
  fc.record({ kind: fc.constant('comment' as const) }),
  fc.record({ kind: fc.constant('attack-text' as const), text: fc.constantFrom('x', 'yz') }),
  fc.record({
    kind: fc.constant('attack-restyle' as const),
    colour: fc.constantFrom('#FF0000', '#00FF00'),
  }),
);

describe('an approved region stays as approved under a stream of commits (PRM-047)', () => {
  it('the canonical content, excluding field values, equals the approval when the stream ends (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
        const room = roomWith(fieldsDoc(), approvedPerms(), () => NOW);
        room.open('a1', USERS.alice);
        room.open('n1', MORE.lena);
        // The approval binds what the room computes now (`Room.regionApproval`).
        const basis = room.regionApproval(TERMS);
        expect(basis).not.toBeNull();
        const approvedHash = await sha256Hex(basis!.canonical);

        for (const o of ops) {
          if (o.kind === 'fill') {
            const fx = room.submit('n1', {
              id: commitId(),
              base: room.head,
              steps: stepsToJson([
                new AttrStep(posOf(room.document, FIELDS.termsSecret), 'value', o.value),
              ]),
            });
            expect(rejection(fx, 'n1')).toBeNull();
          } else if (o.kind === 'intro') {
            const fx = room.submit('a1', {
              id: commitId(),
              base: room.head,
              steps: stepsToJson([typeAt(room.document, 'pIntro0000000001', o.text)]),
            });
            expect(rejection(fx, 'a1')).toBeNull();
          } else if (o.kind === 'comment') {
            const outcome = room.createThread({
              id: commitId(),
              as: MORE.cora,
              target: { block: 'pTerms000000002A' },
            });
            expect(outcome.ok).toBe(true);
          } else if (o.kind === 'attack-text') {
            const fx = room.submit('a1', {
              id: commitId(),
              base: room.head,
              steps: stepsToJson([typeAt(room.document, 'pTerms000000001A', o.text)]),
            });
            expect(rejection(fx, 'a1')).toMatchObject({ code: 'permission_denied' });
          } else {
            const fx = room.submit('a1', {
              id: commitId(),
              base: room.head,
              steps: stepsToJson([new AttrStep(posOf(room.document, 'Normal'), 'color', o.colour)]),
            });
            expect(rejection(fx, 'a1')).toMatchObject({ code: 'permission_denied' });
          }
          // Drain what the room has ready to store, as the host does after each commit.
          for (let fx = room.writeCompleted({ status: 'ok' }); fx.write;) {
            fx = room.writeCompleted({ status: 'ok' });
          }
        }

        expect(room.permissions.regionStates.get(TERMS)).toBe('approved');
        const region = room.document.nodeAt(posOf(room.document, TERMS))!;
        expect(regionCanonicalText(region)).toBe(basis!.canonical);
        expect(await sha256Hex(regionCanonicalText(region))).toBe(approvedHash);
      }),
      { numRuns: 40 },
    );
  });

  it('reopening it by a state change is a control commit, after which editing is allowed', () => {
    const perms = approvedPerms();
    const room = roomWith(fieldsDoc(), perms, () => NOW);
    room.open('a1', USERS.alice);
    const reopened = room.permissionsChanged({
      ...perms,
      revision: perms.revision + 1,
      regionStates: new Map(),
    });
    expect(reopened.write?.commits.map((c) => c.kind)).toEqual(['control']);
    for (let fx = room.writeCompleted({ status: 'ok' }); fx.write;) {
      fx = room.writeCompleted({ status: 'ok' });
    }
    const edit = room.submit('a1', {
      id: commitId(),
      base: room.head,
      steps: stepsToJson([typeAt(room.document, 'pTerms000000001A', 'x')]),
    });
    expect(rejection(edit, 'a1')).toBeNull();
  });

  it('refuses a move of the approved region by an owner', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, approvedPerms(), () => NOW);
    room.open('a1', USERS.alice);
    const at = posOf(doc, TERMS);
    const size = doc.nodeAt(at)!.nodeSize;
    const introAt = posOf(doc, 'pIntro0000000001');
    // A move: the region is cut out and inserted before the intro paragraph (positions before the
    // cut are unaffected by it, so the second step needs no mapping).
    const tr = new Transform(doc);
    tr.delete(at, at + size);
    tr.insert(introAt, doc.nodeAt(at)!);
    const moved = room.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(tr.steps),
    });
    expect(rejection(moved, 'a1')).toMatchObject({ code: 'permission_denied' });
    expect(room.head).toBe(0);
  });
});
