/**
 * SEC-024 — a style, numbering or page-setup change cannot deface protected text (10 §3.3; 07 §5.3;
 * PRM-012). These proofs run the outcome check of the authority with the standard rules on a
 * document whose restricted region R uses styles through a `basedOn` chain, and whose other region
 * is open to editing. R's paragraph also uses a numbering definition in one variant of the document,
 * so the numbering clause (criterion 3) is proved too. Story headers and footers are not in the
 * fixture, so the header and footer clause (criterion 6) is still not proved (see the story's Notes).
 */
import {
  applySteps,
  computeAccess,
  type Connection,
  outcomeCheck,
  type PermissionState,
  STANDARD_RULES,
} from '@docedit/authority';
import type { Node } from 'prosemirror-model';
import { AttrStep, type Step } from 'prosemirror-transform';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BASE_JSON, regionsOf, schema } from './support/authority-fixtures.ts';

type J = Record<string, unknown>;

const R = 'rLegal000000000B'; // restricted: the protected clause
const OPEN = 'rOpen00000000001'; // inherit: open to editors

const conn = (
  sub: string,
  role: Connection['role'],
  extra: Partial<Connection> = {},
): Connection => ({
  sub,
  session: `s-${sub}`,
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
  ...extra,
});

/** An editor: structure, and edit only where the region allows it. */
const EDITOR = conn('edna', 'editor');
/** An owner: holds `manage`, and edit everywhere. */
const OWNER = conn('olive', 'owner');
/** A filler with an editor grant on the open region only: edits existing styles there and nothing else. */
const REGION_EDITOR = conn('rita', 'filler');

const grantOpen = (sub: string) => ({
  region: OPEN,
  principal: `user:${sub}`,
  role: 'editor' as const,
  expiresAt: null,
});

function perms(extra: Partial<PermissionState> = {}): PermissionState {
  return {
    revision: 1,
    grants: [],
    regionStates: new Map(),
    leases: [],
    documentState: 'active',
    workflowActive: false,
    ...extra,
  };
}

const paragraph = (id: string, text: string, style?: string): J => ({
  type: 'paragraph',
  attrs: { id, ...(style ? { style } : {}) },
  content: text ? [{ type: 'text', text }] : [],
});

const style = (id: string, basedOn: string | null = null): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, builtIn: false, basedOn },
});

/**
 * The document: the base definitions plus `styles`; the protected region R whose one paragraph uses
 * `legalStyle` (null: the default paragraph style, Normal); the open region with one paragraph in
 * the style `openStyle`.
 */
/** A numbering definition with one level, and the numbering that R's paragraph uses for it. */
const NUMBERING_DEF: J = {
  type: 'numbering_def',
  attrs: { id: 'N1', levels: [{ format: 'decimal', text: '%1.', start: 1 }] },
};
const NUMBERING_REF = { numberingId: 'N1', level: 0, listId: 'listAxxxxxxxxxxx' };

function buildDoc(
  styles: J[],
  legalStyle: string | null,
  openStyle = 'Plain',
  numbered = false,
): Node {
  const defs = (BASE_JSON.content as J[])[0]!.content as J[];
  const body = (BASE_JSON.content as J[])[1]!.content as J[];
  const title = body[0]!;
  const legal = paragraph('pLegal000000001B', 'Liability is limited.', legalStyle ?? undefined);
  if (numbered) (legal['attrs'] as J)['numbering'] = NUMBERING_REF;
  const json: J = {
    type: 'doc',
    content: [
      // The styles follow Normal and precede the numbering, page setup and role definitions (the defs grammar).
      {
        type: 'defs',
        content: [
          ...defs.slice(0, 2),
          style('Plain'),
          ...styles,
          ...(numbered ? [NUMBERING_DEF] : []),
          ...defs.slice(2),
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          title,
          {
            type: 'region',
            attrs: { id: R, title: 'Legal', policy: 'restricted' },
            content: [legal],
          },
          {
            type: 'region',
            attrs: { id: OPEN, title: 'Open', policy: 'inherit' },
            content: [paragraph('pOpen0000000001', 'Open clause.', openStyle)],
          },
          paragraph('pEnd00000000001Z', ''),
        ],
      },
    ],
  };
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** Position of the node of `type` with the given identifier. */
function posOf(doc: Node, type: string, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.type.name === type && n.attrs['id'] === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no ${type} ${id}`);
  return found;
}

/** The outcome check for `user` on the commit `steps`, with the access the authority computes. */
function judge(before: Node, steps: Step[], user: Connection, p: PermissionState = perms()) {
  const applied = applySteps(before, steps);
  if (!applied.ok) throw new Error('the change does not apply');
  const access = computeAccess(user, regionsOf(before), p, 0);
  const verdict = outcomeCheck({
    before,
    after: applied.value.doc,
    user: user.sub,
    access,
    perms: p,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules: STANDARD_RULES,
  });
  return { access, verdict };
}

const rename = (doc: Node, type: string, id: string, name: string): Step[] => [
  new AttrStep(posOf(doc, type, id), 'name', name),
];

const CLAUSE_DOC = () => buildDoc([style('Base'), style('Clause', 'Base')], 'Clause');

describe('SEC-024: shared definitions cannot deface protected text', () => {
  it('refuses a style used in R when the user has edit only in another region (criterion 1)', () => {
    const doc = CLAUSE_DOC();
    const r = judge(doc, rename(doc, 'style_def', 'Clause', 'Struck'), EDITOR);
    // The premise: the editor edits the open region, not R.
    expect(r.access.regions.get(OPEN)?.has('edit')).toBe(true);
    expect(r.access.regions.get(R)?.has('edit')).toBe(false);
    expect(r.verdict).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('refuses the same change from a structure holder without edit in R, and allows it with manage (criterion 2)', () => {
    const doc = CLAUSE_DOC();
    const steps = rename(doc, 'style_def', 'Clause', 'Struck');
    // The editor holds structure but not edit in R, and not manage: refused.
    const editor = judge(doc, steps, EDITOR);
    expect(editor.access.docRole.has('structure')).toBe(true);
    expect(editor.access.regions.get(R)?.has('edit')).toBe(false);
    expect(editor.access.docRole.has('manage')).toBe(false);
    expect(editor.verdict).toMatchObject({ ok: false, code: 'permission_denied' });
    // Another user's lease on R limits everyone else to view and comment in R (07 §4 limit 3), the
    // owner included. The owner then holds structure and manage but not edit in R, so only the
    // `manage` exception can accept the change.
    const leased = perms({ leases: [{ region: R, holder: 'someone-else', expiresAt: 1 }] });
    const owner = judge(doc, steps, OWNER, leased);
    expect(owner.access.docRole.has('structure')).toBe(true);
    expect(owner.access.regions.get(R)?.has('edit')).toBe(false);
    expect(owner.access.docRole.has('manage')).toBe(true);
    expect(owner.verdict.ok).toBe(true);
    // The control under the same lease: the editor, without manage, is still refused.
    expect(judge(doc, steps, EDITOR, leased).verdict).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });

  it('refuses a change to a definition, a numbering-free page setup, for anyone once R is approved, owner included (criterion 3)', () => {
    const doc = CLAUSE_DOC();
    const approved = perms({ regionStates: new Map([[R, 'approved']]) });
    expect(
      judge(doc, rename(doc, 'style_def', 'Clause', 'X'), OWNER, approved).verdict,
    ).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    const pageSetup: Step[] = [new AttrStep(posOf(doc, 'page_setup', 'ps1'), 'marginTop', 720)];
    expect(judge(doc, pageSetup, OWNER, approved).verdict).toMatchObject({ ok: false });
    // Without the approval the owner's page setup change is allowed, so the refusal is the approval's.
    expect(judge(doc, pageSetup, OWNER).verdict.ok).toBe(true);
  });

  it('refuses a change to a numbering definition R uses, from an editor, and from the owner once R is approved (criterion 3, numbering)', () => {
    const doc = buildDoc([style('Base')], 'Base', 'Plain', true);
    const steps: Step[] = [new AttrStep(posOf(doc, 'numbering_def', 'N1'), 'name', 'Changed')];
    // The premise: R's paragraph is numbered by N1, so N1 is a definition R uses.
    const r = judge(doc, steps, EDITOR);
    expect(r.access.regions.get(R)?.has('edit')).toBe(false);
    expect(r.verdict).toMatchObject({ ok: false, code: 'permission_denied' });
    // Once R is approved, the owner is refused too.
    const approved = perms({ regionStates: new Map([[R, 'approved']]) });
    expect(judge(doc, steps, OWNER, approved).verdict).toMatchObject({ ok: false });
    // The control: without the approval the owner may change N1, so the refusal is the approval's.
    expect(judge(doc, steps, OWNER).verdict.ok).toBe(true);
  });

  it('refuses a style reached only through a basedOn chain of up to ten styles from a style R uses (criterion 4)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (depth) => {
        // C0 is the root; each Ci is based on C(i-1); R uses C<depth>, so C0 is reached only by the chain.
        const styles: J[] = [];
        for (let i = 0; i <= depth; i++) styles.push(style(`C${i}`, i === 0 ? null : `C${i - 1}`));
        const doc = buildDoc(styles, `C${depth}`);
        const refused = judge(doc, rename(doc, 'style_def', 'C0', 'Changed'), EDITOR).verdict;
        expect(refused).toMatchObject({ ok: false, code: 'permission_denied' });
        // The control: a style R does not use changes freely by the same editor.
        const free = judge(doc, rename(doc, 'style_def', 'Plain', 'Changed'), EDITOR).verdict;
        expect(free.ok).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('refuses a change to Normal by anyone but an owner, when R paragraphs use the default style (criterion 5)', () => {
    // The protected paragraph has no style, so it uses the default paragraph style, Normal.
    const doc = buildDoc([style('Base')], null);
    const steps = rename(doc, 'style_def', 'Normal', 'Changed');
    expect(judge(doc, steps, EDITOR).verdict).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    expect(judge(doc, steps, OWNER).verdict.ok).toBe(true);
  });

  it('a region-only editor applies existing styles in its region, and cannot change definitions or page setup (criterion 6, part)', () => {
    const doc = CLAUSE_DOC();
    const p = perms({ grants: [grantOpen(REGION_EDITOR.sub)] });
    // Applying an existing style inside the open region works.
    const apply: Step[] = [
      new AttrStep(posOf(doc, 'paragraph', 'pOpen0000000001'), 'style', 'Base'),
    ];
    expect(judge(doc, apply, REGION_EDITOR, p).verdict.ok).toBe(true);
    // Changing a definition, even one not used by R, is refused for lack of structure.
    expect(
      judge(doc, rename(doc, 'style_def', 'Plain', 'X'), REGION_EDITOR, p).verdict,
    ).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    // So is a page setup change.
    const pageSetup: Step[] = [new AttrStep(posOf(doc, 'page_setup', 'ps1'), 'marginTop', 720)];
    expect(judge(doc, pageSetup, REGION_EDITOR, p).verdict).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });
});
