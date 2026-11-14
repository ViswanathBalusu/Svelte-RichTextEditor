/**
 * SEC-024 criterion 6 (header and footer clause): a user who may edit only regions can apply an
 * existing style inside their region, but cannot change a definition, a page setup, a header or a
 * footer (10 §3.3; 07 §2, §4, §5.3). The fixture here has a header and a footer story, which the
 * shared-definitions fixture lacks. The proofs run the outcome check of the authority with the
 * standard rules, as shared-definitions.test.ts does.
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
import { describe, expect, it } from 'vitest';
import { BASE_JSON, regionsOf, schema } from './support/authority-fixtures.ts';

type J = Record<string, unknown>;

const R = 'rLegal000000000B'; // restricted: the protected clause
const OPEN = 'rOpen00000000001'; // inherit: open to editors
const HEADER = 'sHeader000000001';
const FOOTER = 'sFooter000000001';
const PHEADER = 'pHeader0000000001';
const PFOOTER = 'pFooter0000000001';

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

/** An owner: holds `manage` and edit everywhere. */
const OWNER = conn('olive', 'owner');
/** A user with an editor grant on the open region only. */
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

const story = (id: string, kind: 'header' | 'footer', pid: string, text: string): J => ({
  type: 'story',
  attrs: { id, kind },
  content: [paragraph(pid, text)],
});

/**
 * The document: the base definitions, a header and a footer story, and a body with the restricted
 * region R and the open region.
 */
function buildDoc(): Node {
  const defs = (BASE_JSON.content as J[])[0]!;
  const body = (BASE_JSON.content as J[])[1]!.content as J[];
  const title = body[0]!;
  const json: J = {
    type: 'doc',
    content: [
      defs,
      story(HEADER, 'header', PHEADER, 'Header text.'),
      story(FOOTER, 'footer', PFOOTER, 'Footer text.'),
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          title,
          {
            type: 'region',
            attrs: { id: R, title: 'Legal', policy: 'restricted' },
            content: [paragraph('pLegal000000001B', 'Liability is limited.')],
          },
          {
            type: 'region',
            attrs: { id: OPEN, title: 'Open', policy: 'inherit' },
            content: [paragraph('pOpen0000000001', 'Open clause.', 'Plain')],
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
  return outcomeCheck({
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
}

describe('SEC-024 criterion 6: a region-only user cannot change headers or footers', () => {
  it('applies an existing style inside its open region', () => {
    const doc = buildDoc();
    const p = perms({ grants: [grantOpen(REGION_EDITOR.sub)] });
    const apply: Step[] = [
      new AttrStep(posOf(doc, 'paragraph', 'pOpen0000000001'), 'style', 'Plain'),
    ];
    expect(judge(doc, apply, REGION_EDITOR, p).ok).toBe(true);
  });

  it('refuses a change to the text style of a header paragraph', () => {
    const doc = buildDoc();
    const p = perms({ grants: [grantOpen(REGION_EDITOR.sub)] });
    const headerEdit: Step[] = [new AttrStep(posOf(doc, 'paragraph', PHEADER), 'style', 'Plain')];
    expect(judge(doc, headerEdit, REGION_EDITOR, p)).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });

  it('refuses a change to a footer paragraph', () => {
    const doc = buildDoc();
    const p = perms({ grants: [grantOpen(REGION_EDITOR.sub)] });
    const footerEdit: Step[] = [new AttrStep(posOf(doc, 'paragraph', PFOOTER), 'style', 'Plain')];
    expect(judge(doc, footerEdit, REGION_EDITOR, p)).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });

  it('refuses a change to the kind of a header story', () => {
    const doc = buildDoc();
    const p = perms({ grants: [grantOpen(REGION_EDITOR.sub)] });
    const kind: Step[] = [new AttrStep(posOf(doc, 'story', HEADER), 'kind', 'footer')];
    expect(judge(doc, kind, REGION_EDITOR, p)).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });

  it('refuses a page setup change for the same user, alongside the header and footer refusals', () => {
    const doc = buildDoc();
    const p = perms({ grants: [grantOpen(REGION_EDITOR.sub)] });
    const pageSetup: Step[] = [new AttrStep(posOf(doc, 'page_setup', 'ps1'), 'marginTop', 720)];
    expect(judge(doc, pageSetup, REGION_EDITOR, p)).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });

  it('the owner may change a header story (the control: the refusals are for lack of permission)', () => {
    const doc = buildDoc();
    const headerEdit: Step[] = [new AttrStep(posOf(doc, 'paragraph', PHEADER), 'style', 'Plain')];
    expect(judge(doc, headerEdit, OWNER).ok).toBe(true);
  });
});
