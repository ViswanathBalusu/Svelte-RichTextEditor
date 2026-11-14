/**
 * Which collaborators' carets the layer draws (UX-027 criterion 3; 13 §5). A peer whose position
 * cannot be mapped (a null caret) is not drawn: no caret, no selection, no flag. The rectangles the
 * core reports are passed on unchanged, and the colour slot does not depend on the order of peers.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { PeerCaret, ShellRect } from '../src/core-api.ts';
import { drawnPeers } from '../src/shell/carets.ts';
import { colourSlot } from '../src/shell/presence.ts';

const rect = fc.record({
  x: fc.integer({ min: 0, max: 2000 }),
  y: fc.integer({ min: 0, max: 2000 }),
  width: fc.integer({ min: 0, max: 800 }),
  height: fc.integer({ min: 1, max: 60 }),
}) satisfies fc.Arbitrary<ShellRect>;

// Sessions are unique, as the core's view gives them.
const peers = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
    minLength: 0,
    maxLength: 12,
    selector: (s) => s,
  })
  .chain((sessions) =>
    fc.tuple(
      ...sessions.map((session) =>
        fc.record<PeerCaret>({
          session: fc.constant(session),
          user: fc.string({ minLength: 1, maxLength: 8 }),
          name: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
          status: fc.constantFrom('active' as const, 'idle' as const),
          caret: fc.option(rect, { nil: null }),
          selection: fc.array(rect, { maxLength: 3 }),
        }),
      ),
    ),
  )
  .map((list) => [...list] as PeerCaret[]);

describe('drawnPeers (UX-027 criterion 3)', () => {
  it('draws exactly the peers whose caret is mapped, in the order the core gave them', () => {
    fc.assert(
      fc.property(peers, (list) => {
        const drawn = drawnPeers(list);
        const expected = list.filter((p) => p.caret !== null).map((p) => p.session);
        expect(drawn.map((d) => d.session)).toEqual(expected);
      }),
    );
  });

  it('draws nothing of a peer whose position cannot be mapped, not even its selection', () => {
    const unmapped: PeerCaret = {
      session: 's1',
      user: 'u1',
      status: 'active',
      caret: null,
      selection: [{ x: 1, y: 2, width: 60, height: 18 }],
    };
    expect(drawnPeers([unmapped])).toEqual([]);
    const mapped: PeerCaret = {
      ...unmapped,
      session: 's2',
      caret: { x: 4, y: 5, width: 0, height: 18 },
    };
    expect(drawnPeers([unmapped, mapped]).map((d) => d.session)).toEqual(['s2']);
  });

  it('passes the caret and the selection on exactly as the core reported them', () => {
    fc.assert(
      fc.property(peers, (list) => {
        for (const d of drawnPeers(list)) {
          const source = list.find((p) => p.session === d.session)!;
          expect(d.caret).toBe(source.caret);
          expect(d.selection).toBe(source.selection);
          expect(d.user).toBe(source.user);
          expect(d.status).toBe(source.status);
          expect(d.name).toBe(source.name ?? null);
        }
      }),
    );
  });

  it('gives a person the same colour slot whatever the order of the peers, and the slot is 1 to 8', () => {
    fc.assert(
      fc.property(peers, (list) => {
        const reversed = [...list].reverse();
        const a = new Map(drawnPeers(list).map((d) => [d.session, d.slot] as const));
        for (const d of drawnPeers(reversed)) {
          expect(a.get(d.session)).toBe(d.slot);
          expect(d.slot).toBe(colourSlot(d.user));
          expect(d.slot).toBeGreaterThanOrEqual(1);
          expect(d.slot).toBeLessThanOrEqual(8);
        }
      }),
    );
  });
});
