/**
 * The proofing request (UX-041, building block). Criteria 1 (language), 2 (no text from a scope the
 * user cannot view), 3 (stale findings are discarded) and 5 (no control without a port) are tested
 * at function level. Nothing calls these functions yet, so no criterion is ticked on them alone:
 * the wiring into the shell and the core, the decorations, the keyboard and the screen reader
 * (criteria 1, 4, 6 and 7) are not built.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  isFindingCurrent,
  proofingControlShown,
  proofingRequest,
  type ProofingBlock,
} from '../src/proofing/request.ts';

const blockArb = fc.record({
  id: fc.stringMatching(/^[a-z]{1,6}$/),
  scope: fc.constantFrom('body', 'section-a', 'section-b', 'region-x'),
  text: fc.string({ maxLength: 40 }),
  lang: fc.option(fc.constantFrom('en-GB', 'fr-FR', '  ', ''), { nil: null }),
}) as fc.Arbitrary<ProofingBlock>;

describe('proofing request (UX-041, building block)', () => {
  it('uses the block mark, else the document default, else none', () => {
    const request = proofingRequest(
      [
        { id: 'a', scope: 'body', text: 'one', lang: 'fr-FR' },
        { id: 'b', scope: 'body', text: 'two', lang: null },
        { id: 'c', scope: 'body', text: 'three', lang: '   ' },
      ],
      () => true,
      'en-GB',
    );
    expect(request.items.map((i) => [i.id, i.lang])).toEqual([
      ['a', 'fr-FR'],
      ['b', 'en-GB'],
      ['c', 'en-GB'],
    ]);
    const none = proofingRequest([{ id: 'd', scope: 'body', text: 'four' }], () => true, null);
    expect(none.items[0]?.lang).toBeNull();
  });

  it('sends no text from a scope the requester cannot view (property)', () => {
    fc.assert(
      fc.property(
        fc.array(blockArb, { maxLength: 12 }),
        fc.subarray(['body', 'section-a', 'section-b', 'region-x']),
        fc.option(fc.constantFrom('en-GB', 'de-DE'), { nil: null }),
        (blocks, visibleScopes, documentLang) => {
          const visible = new Set(visibleScopes);
          const request = proofingRequest(blocks, (scope) => visible.has(scope), documentLang);
          const shown = blocks.filter((b) => visible.has(b.scope));
          // Exactly the viewable blocks are sent, in order, and the rest are only counted.
          expect(request.items.map((i) => i.id)).toEqual(shown.map((b) => b.id));
          expect(request.items.map((i) => i.text)).toEqual(shown.map((b) => b.text));
          expect(request.omitted).toBe(blocks.length - shown.length);
        },
      ),
    );
  });

  it('offers the proofing control only when a port is given', () => {
    expect(proofingControlShown(undefined)).toBe(false);
    expect(proofingControlShown(null)).toBe(false);
    expect(proofingControlShown({})).toBe(true);
  });

  it('a finding is current only for the revision it was computed from (property)', () => {
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(1000), (found, now) => {
        expect(isFindingCurrent(found, now)).toBe(found === now);
      }),
    );
  });
});
