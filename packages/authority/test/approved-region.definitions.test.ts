// An approved region stays as approved against the definitions it uses (07 §5.3, §11; PRM-047
// criterion 4): a numbering definition and a page setup used by an approved region cannot be
// changed by anyone, the owner included, while the same change is accepted once the region is not
// approved. The style case is in leases-states.test.ts.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { PermissionState } from '../src/permissions/model.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, USERS, baseDoc, posOf, schema } from './fixtures.ts';
import { commitId, morePermissions, rejection, roomWith } from './permission-fixtures.ts';

const TERMS = 'rTerms000000000A';
const NOW = 1_770_700_000_000;

type J = Record<string, unknown>;

const LEVEL = {
  format: 'decimal',
  text: '%1.',
  start: 1,
  restartAfter: null,
  legal: false,
  indentLeft: 720,
  hanging: 360,
  align: 'start',
  bulletChar: null,
  runProps: null,
};
/** The same definition with one different indent: a valid, changed set of levels. */
const CHANGED_LEVELS = [{ ...LEVEL, indentLeft: 1440 }];

/** The base document with a numbering definition used by a paragraph inside Terms. */
function docWithNumbering() {
  const json = structuredClone(BASE_JSON) as unknown as { content: J[] };
  const defs = json.content[0]!['content'] as J[];
  defs.splice(
    defs.findIndex((d) => d['type'] === 'page_setup'),
    0,
    {
      type: 'numbering_def',
      attrs: { id: 'numT', levels: [LEVEL] },
    },
  );
  const body = json.content[1]!['content'] as J[];
  const terms = body.find((b) => (b['attrs'] as J | undefined)?.['id'] === TERMS)!;
  const first = (terms['content'] as J[])[0]!;
  (first['attrs'] as J)['numbering'] = {
    numberingId: 'numT',
    level: 0,
    listId: 'lTerms0000000001',
  };
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const approved = (): PermissionState => ({
  ...morePermissions(),
  regionStates: new Map([[TERMS, 'approved' as const]]),
});

describe('an approved region keeps the definitions it uses (PRM-047 criterion 4)', () => {
  it('refuses an owner who changes the numbering definition its paragraphs use', () => {
    const doc = docWithNumbering();
    const at = posOf(doc, 'numT');
    const room = roomWith(doc, approved(), () => NOW);
    room.open('a1', USERS.alice);
    const fx = room.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([new AttrStep(at, 'levels', CHANGED_LEVELS)]),
    });
    expect(rejection(fx, 'a1')).toMatchObject({ code: 'permission_denied' });
  });

  it('refuses an owner who changes the page setup the region is laid out with', () => {
    const doc = baseDoc();
    const at = posOf(doc, 'ps1');
    const room = roomWith(doc, approved(), () => NOW);
    room.open('a1', USERS.alice);
    const fx = room.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([new AttrStep(at, 'orientation', 'landscape')]),
    });
    expect(rejection(fx, 'a1')).toMatchObject({ code: 'permission_denied' });
  });

  it('accepts the same two changes once the region is not approved (the control)', () => {
    const numbered = docWithNumbering();
    const room = roomWith(numbered, morePermissions(), () => NOW);
    room.open('a1', USERS.alice);
    const numberingFx = room.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(numbered, 'numT'), 'levels', CHANGED_LEVELS)]),
    });
    expect(rejection(numberingFx, 'a1')).toBeNull();

    const plain = baseDoc();
    const room2 = roomWith(plain, morePermissions(), () => NOW);
    room2.open('a1', USERS.alice);
    const pageFx = room2.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(plain, 'ps1'), 'orientation', 'landscape')]),
    });
    expect(rejection(pageFx, 'a1')).toBeNull();
  });
});
