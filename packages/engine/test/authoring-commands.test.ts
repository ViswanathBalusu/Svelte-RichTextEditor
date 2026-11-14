/**
 * The authoring commands through the core (FE-133, FE-137, FE-140): `insertCitation`, `addLink`,
 * `insertBookmark`, `followInternalLink` and `setPageSetup` run through `DocumentCore.run` and
 * `queryCommand`, with the region guard's real `canWrite` (guard.ts) deciding where the user may
 * change the document. No test predicate stands in for the guard here.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { caret, microtask, posOf } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;
const REGION = `region:${AUTH_IDS.region}`;

function envelope(): CdmEnvelope {
  return { cdm: 1, requires: [], doc: authoringEnvelope() };
}

/** An editor: the body, not the restricted region or the definitions (07 §4, §5.3). */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'], [REGION]: [...READ] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

/** An owner: everything, the definitions included. */
function ownerAccess(): Access {
  return {
    ...editorAccess(),
    docRole: 'owner',
    caps: [...EDIT, 'structure', 'manage'],
    scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT], [REGION]: [...EDIT] },
  };
}

function core(access: Access | null = editorAccess()): DocumentCore {
  return new DocumentCore({ doc: envelope(), access, schedule: microtask });
}

/** Selects `from` to `to` characters of the paragraph `id`. */
function select(c: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(c);
  const base = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, base + from, base + to)));
}

function nodesOf(c: DocumentCore, type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  internals(c).state.doc.descendants((n) => {
    if (n.type.name === type) out.push(n.attrs);
    return true;
  });
  return out;
}

function pageSetup(c: DocumentCore): Record<string, unknown> {
  let attrs: Record<string, unknown> | null = null;
  internals(c).state.doc.firstChild!.forEach((n) => {
    if (n.type.name === 'page_setup') attrs = n.attrs;
  });
  return attrs!;
}

/** Runs `act` and reports whether the document changed and how many steps were queued. */
function attempt(c: DocumentCore, act: () => boolean) {
  const i = internals(c);
  const doc = i.state.doc;
  const queued = unconfirmed(i.sync).length;
  const done = act();
  return {
    done,
    changed: internals(c).state.doc !== doc,
    queued: unconfirmed(internals(c).sync).length - queued,
  };
}

const CITE = { citation: { items: [{ source: 'smith2026', locator: '12', label: 'page' }] } };

describe('insertCitation through the core (FE-140)', () => {
  it('inserts a citation at the caret in the body, where the guard lets the editor write', () => {
    const c = core();
    caret(c, AUTH_IDS.p1, 3);
    expect(c.queryCommand('insertCitation', CITE)).toEqual({ enabled: true, active: false });
    const r = attempt(c, () => c.run('insertCitation', CITE));
    expect(r).toMatchObject({ done: true, changed: true });
    expect(r.queued).toBeGreaterThan(0);
    const cites = nodesOf(c, 'citation');
    expect(cites).toHaveLength(1);
    expect(cites[0]!['items']).toEqual([{ source: 'smith2026', locator: '12', label: 'page' }]);
  });

  it('is unavailable in a region the real guard protects, and changes nothing (criterion 4; 07 §7)', () => {
    const c = core();
    expect(c.canEdit(REGION)).toBe(false); // the guard's own answer for this access
    caret(c, AUTH_IDS.inRegion, 2);
    expect(c.queryCommand('insertCitation', CITE)).toEqual({
      enabled: false,
      active: false,
      reason: 'no-access',
    });
    expect(attempt(c, () => c.run('insertCitation', CITE))).toEqual({
      done: false,
      changed: false,
      queued: 0,
    });
    expect(nodesOf(c, 'citation')).toHaveLength(0);
  });

  it('becomes available in that region when an access grants edit there', () => {
    const c = core(ownerAccess());
    caret(c, AUTH_IDS.inRegion, 2);
    expect(c.queryCommand('insertCitation', CITE).enabled).toBe(true);
    expect(c.run('insertCitation', CITE)).toBe(true);
    expect(nodesOf(c, 'citation')).toHaveLength(1);
  });

  it('is unavailable with the reason read-only when the mode locks the document', () => {
    const c = core();
    caret(c, AUTH_IDS.p1, 1);
    c.setMode('view');
    expect(c.queryCommand('insertCitation', CITE)).toEqual({
      enabled: false,
      active: false,
      reason: 'read-only',
    });
    expect(c.run('insertCitation', CITE)).toBe(false);
  });

  it('refuses a source the document does not define and a locator label the CDM does not know', () => {
    const c = core();
    caret(c, AUTH_IDS.p1, 1);
    const unknown = { citation: { items: [{ source: 'nobody1999' }] } };
    expect(c.queryCommand('insertCitation', unknown).enabled).toBe(false);
    const badLabel = { citation: { items: [{ source: 'smith2026', label: 'shelf' }] } };
    expect(c.run('insertCitation', badLabel)).toBe(false);
    expect(nodesOf(c, 'citation')).toHaveLength(0);
  });

  it('without arguments the command is not available', () => {
    const c = core();
    caret(c, AUTH_IDS.p1, 1);
    expect(c.queryCommand('insertCitation')).toEqual({ enabled: false, active: false });
  });
});

describe('addLink through the core (FE-133 criterion 1)', () => {
  it('adds a link with a safe scheme to the selection', () => {
    const c = core();
    select(c, AUTH_IDS.p1, 0, 5);
    const args = { href: 'https://example.org/a', title: 'Example' };
    expect(c.queryCommand('addLink', args)).toEqual({ enabled: true, active: false });
    expect(c.run('addLink', args)).toBe(true);
    const doc = internals(c).state.doc;
    const text = doc.nodeAt(posOf(doc, AUTH_IDS.p1) + 1)!;
    expect(text.marks.map((m) => [m.type.name, m.attrs['href']])).toEqual([
      ['link', 'https://example.org/a'],
    ]);
  });

  it('refuses an unsafe scheme before anything is stored, and says why', () => {
    const c = core();
    select(c, AUTH_IDS.p1, 0, 5);
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const args = { href };
      expect(c.queryCommand('addLink', args)).toEqual({
        enabled: false,
        active: false,
        reason: 'scheme-not-allowed',
      });
      expect(attempt(c, () => c.run('addLink', args))).toEqual({
        done: false,
        changed: false,
        queued: 0,
      });
    }
    expect(c.queryCommand('addLink', { href: 'not a url' }).reason).toBe('malformed-link');
  });

  it('is unavailable in a region the real guard protects', () => {
    const c = core();
    select(c, AUTH_IDS.inRegion, 0, 4);
    const args = { href: 'https://example.org' };
    expect(c.queryCommand('addLink', args).reason).toBe('no-access');
    expect(attempt(c, () => c.run('addLink', args)).changed).toBe(false);
  });
});

describe('insertBookmark and followInternalLink through the core (FE-133 criteria 2 and 3)', () => {
  it('creates an anchor with the name, with an identifier, and refuses a duplicate name', () => {
    const c = core();
    caret(c, AUTH_IDS.p2, 2);
    expect(c.run('insertBookmark', { name: 'intro' })).toBe(true);
    const anchors = nodesOf(c, 'anchor');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!['name']).toBe('intro');
    expect(typeof anchors[0]!['id']).toBe('string'); // filled by the identifier plugin (FE-031)

    caret(c, AUTH_IDS.p1, 1);
    expect(c.queryCommand('insertBookmark', { name: 'intro' })).toEqual({
      enabled: false,
      active: false,
      reason: 'duplicate-bookmark',
    });
    expect(attempt(c, () => c.run('insertBookmark', { name: 'intro' })).changed).toBe(false);
    expect(c.queryCommand('insertBookmark', { name: '9 bad' }).reason).toBe('bad-bookmark-name');
    expect(nodesOf(c, 'anchor')).toHaveLength(1);
  });

  it('is unavailable in a region the real guard protects', () => {
    const c = core();
    caret(c, AUTH_IDS.inRegion, 1);
    expect(c.queryCommand('insertBookmark', { name: 'inside' }).reason).toBe('no-access');
    expect(attempt(c, () => c.run('insertBookmark', { name: 'inside' })).changed).toBe(false);
  });

  it('following #name moves the caret to the bookmark and changes nothing else', () => {
    const c = core();
    caret(c, AUTH_IDS.p2, 3);
    c.run('insertBookmark', { name: 'target' });
    caret(c, AUTH_IDS.p1, 0);
    const doc = internals(c).state.doc;
    expect(c.run('followInternalLink', { href: '#target' })).toBe(true);
    expect(internals(c).state.doc).toBe(doc);
    const head = internals(c).state.selection.head;
    expect(internals(c).state.doc.nodeAt(head)?.type.name).toBe('anchor');
    expect(c.queryCommand('followInternalLink', { href: '#missing' }).enabled).toBe(false);
  });
});

describe('setPageSetup through the core (FE-137 criteria 1 and 3)', () => {
  it('stores a paper size, orientation and margins in twentieths of a point', () => {
    const c = core(ownerAccess());
    const args = {
      pageSetup: {
        id: 'ps1',
        changes: {
          paperSize: 'A4' as const,
          orientation: 'landscape' as const,
          marginTop: 1440,
          marginRight: 1134,
          marginBottom: 1440,
          marginLeft: 1134,
        },
      },
    };
    expect(c.queryCommand('setPageSetup', args)).toEqual({ enabled: true, active: false });
    const r = attempt(c, () => c.run('setPageSetup', args));
    expect(r).toMatchObject({ done: true, changed: true });
    expect(r.queued).toBeGreaterThan(0);
    expect(pageSetup(c)).toMatchObject({
      width: 11906,
      height: 16838,
      orientation: 'landscape',
      marginTop: 1440,
      marginRight: 1134,
      marginBottom: 1440,
      marginLeft: 1134,
    });
  });

  it('stores header and footer distances and the gutter', () => {
    const c = core(ownerAccess());
    const changes = { headerDistance: 708, footerDistance: 709, gutter: 360 };
    expect(c.run('setPageSetup', { pageSetup: { id: 'ps1', changes } })).toBe(true);
    expect(pageSetup(c)).toMatchObject(changes);
  });

  it('is unavailable to an editor without edit on the definitions (07 §5.3), and changes nothing', () => {
    const c = core(editorAccess());
    expect(c.canEdit('defs')).toBe(false);
    const args = { pageSetup: { id: 'ps1', changes: { marginTop: 720 } } };
    expect(c.queryCommand('setPageSetup', args)).toEqual({
      enabled: false,
      active: false,
      reason: 'no-access',
    });
    expect(attempt(c, () => c.run('setPageSetup', args))).toEqual({
      done: false,
      changed: false,
      queued: 0,
    });
  });

  it('refuses a value outside the CDM range and an unknown page setup', () => {
    const c = core(ownerAccess());
    const before = pageSetup(c);
    expect(c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { gutter: -1 } } })).toBe(
      false,
    );
    expect(c.run('setPageSetup', { pageSetup: { id: 'nope', changes: { gutter: 1 } } })).toBe(
      false,
    );
    expect(pageSetup(c)).toEqual(before);
  });
});
