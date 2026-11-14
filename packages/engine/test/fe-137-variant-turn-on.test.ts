/**
 * Turning on the first-page or odd and even variants creates their header and footer stories in
 * one transaction (FE-137 criterion 2; FE-057 criterion 2). The panel opening is the view's and is
 * not tested here. Source: packages/engine/src/variant-turn-on.ts.
 */
import { validate } from '@docedit/model/validate';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { storyOfVariant, variantsInUse } from '../src/header-footer.ts';
import { turnOnVariants } from '../src/variant-turn-on.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

/** Sixteen-character story identifiers, one per part and variant. */
const IDS: Readonly<Record<string, string>> = {
  'header:first': 'stHdrFirst000001',
  'footer:first': 'stFtrFirst000001',
  'header:even': 'stHdrEven0000001',
  'footer:even': 'stFtrEven0000001',
};

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access: ownerAccess(), schedule: microtask });
}

describe('turning on a variant creates its stories (FE-137 criterion 2)', () => {
  it('turning on the first-page variant creates a header and a footer story, names them and sets the flag', () => {
    const c = core();
    const i = internals(c);
    const built = turnOnVariants(
      i.state,
      'ps1',
      ['differentFirstPage'],
      (part, v) => IDS[`${part}:${v}`]!,
      true,
    );
    expect(built).not.toBeNull();
    expect(built!.created.map((s) => `${s.part}:${s.variant}`).sort()).toEqual([
      'footer:first',
      'header:first',
    ]);
    i.dispatch(built!.tr);

    const doc = internals(c).state.doc;
    expect(storyOfVariant(doc, 'ps1', 'header', 'first')).toBe(IDS['header:first']);
    expect(storyOfVariant(doc, 'ps1', 'footer', 'first')).toBe(IDS['footer:first']);
    expect(variantsInUse(findSetup(c))).toEqual(['default', 'first']);
    expect(findSetup(c).attrs['differentFirstPage']).toBe(true);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('turning on the odd and even variant creates the even stories and leaves the first-page ones alone', () => {
    const c = core();
    const i = internals(c);
    const built = turnOnVariants(
      i.state,
      'ps1',
      ['differentOddEven'],
      (part, v) => IDS[`${part}:${v}`]!,
      true,
    );
    i.dispatch(built!.tr);

    const doc = internals(c).state.doc;
    expect(storyOfVariant(doc, 'ps1', 'header', 'even')).toBe(IDS['header:even']);
    expect(storyOfVariant(doc, 'ps1', 'footer', 'even')).toBe(IDS['footer:even']);
    expect(storyOfVariant(doc, 'ps1', 'header', 'first')).toBeNull();
    expect(findSetup(c).attrs['differentOddEven']).toBe(true);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('creates nothing when the variant already has both stories, and only sets the flag', () => {
    const c = core();
    const i = internals(c);
    i.dispatch(
      turnOnVariants(i.state, 'ps1', ['differentFirstPage'], (p, v) => IDS[`${p}:${v}`]!, true)!.tr,
    );
    const again = turnOnVariants(
      internals(c).state,
      'ps1',
      ['differentFirstPage'],
      (p, v) => IDS[`${p}:${v}`]!,
      true,
    );
    expect(again).not.toBeNull();
    expect(again!.created).toEqual([]);
  });

  it('builds nothing and returns null when the caller may not change the definition', () => {
    const c = core();
    const i = internals(c);
    const built = turnOnVariants(
      i.state,
      'ps1',
      ['differentFirstPage'],
      (p, v) => IDS[`${p}:${v}`]!,
      false,
    );
    expect(built).toBeNull();
    expect(variantsInUse(findSetup(c))).toEqual(['default']);
  });

  it('returns null for an unknown page setup, and when a new identifier is already in use', () => {
    const c = core();
    const i = internals(c);
    expect(
      turnOnVariants(i.state, 'nope', ['differentFirstPage'], (p, v) => IDS[`${p}:${v}`]!, true),
    ).toBeNull();
    // The identifier of the body is already in use, so the caller's choice is refused.
    const bodyId = findBodyId(c);
    expect(turnOnVariants(i.state, 'ps1', ['differentFirstPage'], () => bodyId, true)).toBeNull();
  });
});

/** The page setup 'ps1' as it stands in the core's document. */
function findSetup(c: DocumentCore): PMNode {
  let found: PMNode | null = null;
  internals(c).state.doc.descendants((n) => {
    if (found === null && n.type.name === 'page_setup' && n.attrs['id'] === 'ps1') found = n;
    return found === null;
  });
  return found!;
}

/** The identifier of the body node, which every document gives once. */
function findBodyId(c: DocumentCore): string {
  let id = '';
  internals(c).state.doc.forEach((child) => {
    if (child.type.name === 'body') id = String(child.attrs['id']);
  });
  return id;
}
