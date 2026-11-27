/**
 * PRM-030 (07 §7, sixth bullet; lane w9): a user who may edit only inside regions (document role
 * `viewer` plus a region grant) applies what the document defines there, and every command that
 * changes a style, a numbering definition, a page setup, a header or a footer is not enabled for
 * them, with the reason in `queryCommand`.
 *
 * - Criterion 1: an existing paragraph or character style, and a list of a numbering definition the
 *   document has, are applied in the region. Through the mock service, which runs the real room,
 *   the commit is accepted and reaches another client.
 * - Criterion 2: the style definition commands, `setPageSetup`, `editHeader` (a header that exists
 *   and one that would be created), the page number of a header and a section break say `no-access`,
 *   a run changes nothing, and the same commands are enabled for an owner. No command of the core
 *   changes a definition, a story or anything outside the region for such a user: every command name
 *   is run. A numbering definition has no command at all: a list names one the document defines.
 *
 * Run with `pnpm exec vitest run --project node packages/engine/test/prm-030.region-only-definitions.test.ts`.
 */
import type { Access } from '@docedit/protocol';
import type { Node } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CommandArgs, CommandName } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { ownerAccess, regionOnlyAccess, spikeDocument } from './fixtures.ts';
import { join, microtask, newService, posOf, until } from './support.ts';

const IDS = {
  header: 'stHeader00000001',
  headerParagraph: 'pHeader000000001',
  intro: 'pIntro0000000001',
  region: 'rTerms0000000001',
  first: 'pTerms0000000001',
  second: 'pTerms0000000002',
  after: 'pAfter0000000001',
} as const;

/**
 * The document's own styles. A custom style has a random identifier: the built-in names are
 * reserved (I11), and a built-in style is neither renamed nor deleted.
 */
const STYLES = { quote: 'sQuote0000000001', term: 'sTerm00000000001' } as const;

const REGION = `region:${IDS.region}`;
const STORY = `story:${IDS.header}`;
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

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

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };

const paragraph = (id: string, text: string, style: string | null = 'Normal'): Json => ({
  type: 'paragraph',
  attrs: { id, style },
  content: [{ type: 'text', text }],
});

/**
 * A document with every kind of definition the criterion names: two built-in styles and a custom
 * one, a character style, a numbering definition, a page setup with a header story, and a
 * restricted region between two body paragraphs. `header` false leaves the header story out.
 */
function termsDocument(opts: { header?: boolean } = {}): CdmEnvelope {
  const header = opts.header !== false;
  const style = (attrs: Record<string, unknown>): Json => ({ type: 'style_def', attrs });
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            style({ id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true }),
            style({
              id: 'Heading1',
              kind: 'paragraph',
              name: 'Heading 1',
              builtIn: true,
              basedOn: 'Normal',
              next: 'Normal',
              outlineLevel: 1,
            }),
            style({ id: STYLES.quote, kind: 'paragraph', name: 'Clause quote', basedOn: 'Normal' }),
            style({ id: STYLES.term, kind: 'character', name: 'Defined term' }),
            { type: 'numbering_def', attrs: { id: 'Num1', levels: [LEVEL, LEVEL] } },
            {
              type: 'page_setup',
              attrs: { id: 'ps1', ...(header ? { headerDefault: IDS.header } : {}) },
            },
          ],
        },
        ...(header
          ? [
              {
                type: 'story',
                attrs: { id: IDS.header, kind: 'header' },
                content: [
                  {
                    type: 'paragraph',
                    attrs: { id: IDS.headerParagraph },
                    content: [{ type: 'text', text: 'Header text' }],
                  },
                ],
              },
            ]
          : []),
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            paragraph(IDS.intro, 'Introduction.'),
            {
              type: 'region',
              attrs: { id: IDS.region, title: 'Terms', policy: 'restricted' },
              content: [paragraph(IDS.first, 'First term.'), paragraph(IDS.second, 'Second term.')],
            },
            paragraph(IDS.after, 'After the terms.'),
          ],
        },
      ],
    },
  };
}

/**
 * The access the room computes for a viewer with an `editor` grant on the restricted region (07 §4):
 * `view` everywhere, and the grant's capabilities in the region. No `structure`, so the definitions
 * and the stories stay `view`. The end-to-end test below shows the room gives the same.
 */
function ritaAccess(over: Partial<Access> = {}): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'viewer',
    caps: ['view'],
    scopes: {
      doc: ['view'],
      body: ['view'],
      defs: ['view'],
      [STORY]: ['view'],
      [REGION]: [...EDIT],
    },
    leases: {},
    fill: null,
    restrictions: [],
    ...over,
  };
}

function owner(): Access {
  return {
    ...ritaAccess(),
    docRole: 'owner',
    caps: [...EDIT, 'fill', 'structure', 'manage'],
    scopes: {
      doc: ['view', 'edit'],
      body: [...EDIT],
      defs: ['view', 'edit'],
      [STORY]: ['view', 'edit'],
      [REGION]: [...EDIT],
    },
  };
}

function core(access: Access = ritaAccess(), doc: CdmEnvelope = termsDocument()): DocumentCore {
  return new DocumentCore({ doc, access, schedule: microtask });
}

const docOf = (c: DocumentCore): Node => internals(c).state.doc;

/** Selects the text of the block with `id`, or puts the caret at its start. */
function select(c: DocumentCore, id: string, whole = true): void {
  const i = internals(c);
  const at = posOf(i.state.doc, id);
  const end = at + i.state.doc.nodeAt(at)!.nodeSize - 1;
  i.dispatch(
    i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 1, whole ? end : at + 1)),
  );
}

const attrsOf = (c: DocumentCore, id: string): Record<string, unknown> =>
  docOf(c).nodeAt(posOf(docOf(c), id))!.attrs;

/** The top-level nodes other than the body: the definitions and every story. */
function outsideBody(doc: Node): Node[] {
  const out: Node[] = [];
  doc.forEach((node) => {
    if (node.type.name !== 'body') out.push(node);
  });
  return out;
}

/** What a region-only editor must never change: everything but the content of their region. */
function expectOnlyRegionContentChanged(before: Node, after: Node): void {
  const was = outsideBody(before);
  const now = outsideBody(after);
  expect(now.map((n) => n.type.name)).toEqual(was.map((n) => n.type.name));
  now.forEach((node, i) => expect(node.eq(was[i]!), `${node.type.name} ${i}`).toBe(true));
  const bodyWas = before.lastChild!;
  const bodyNow = after.lastChild!;
  expect(bodyNow.attrs).toEqual(bodyWas.attrs);
  expect(bodyNow.childCount).toBe(bodyWas.childCount);
  bodyNow.forEach((child, _offset, index) => {
    const old = bodyWas.child(index);
    if (child.type.name === 'region') {
      // The region's own attributes (title, policy, identifier) are the structure's and `manage`'s.
      expect(child.type.name).toBe(old.type.name);
      expect(child.attrs).toEqual(old.attrs);
    } else {
      expect(child.eq(old), `body block ${index}`).toBe(true);
    }
  });
}

describe('a region-only editor applies what the document defines (PRM-030 criterion 1)', () => {
  it('applies an existing paragraph style and character style in the region; no definition changes', () => {
    const c = core();
    const before = docOf(c);
    select(c, IDS.first);
    expect(c.queryCommand('paragraphStyle', { style: STYLES.quote }).enabled).toBe(true);
    expect(c.run('paragraphStyle', { style: STYLES.quote })).toBe(true);
    expect(attrsOf(c, IDS.first)['style']).toBe(STYLES.quote);
    expect(c.run('paragraphStyle', { style: 'Heading1' })).toBe(true);
    expect(attrsOf(c, IDS.first)['style']).toBe('Heading1');
    expect(c.run('charStyle', { charStyle: STYLES.term })).toBe(true);
    const run = docOf(c).nodeAt(posOf(docOf(c), IDS.first) + 1)!;
    expect(run.marks.map((m) => [m.type.name, m.attrs['style']])).toContainEqual([
      'charStyle',
      STYLES.term,
    ]);
    // The styles themselves are as they were: the same definitions, in the same order.
    expect(docOf(c).firstChild!.eq(before.firstChild!)).toBe(true);
    expectOnlyRegionContentChanged(before, docOf(c));
  });

  it('applies a list of a numbering definition the document has; the definition is not changed', () => {
    const c = core();
    const before = docOf(c);
    select(c, IDS.first);
    expect(c.run('applyList', { numberingId: 'Num1' })).toBe(true);
    expect(attrsOf(c, IDS.first)['numbering']).toMatchObject({ numberingId: 'Num1', level: 0 });
    expect(c.run('listLevelUp')).toBe(true);
    expect(attrsOf(c, IDS.first)['numbering']).toMatchObject({ level: 1 });
    expect(docOf(c).firstChild!.eq(before.firstChild!)).toBe(true);
    // A numbering definition the document does not have is not made for the list.
    expect(c.run('applyList', { numberingId: 'Num2' })).toBe(false);
    expect(docOf(c).firstChild!.eq(before.firstChild!)).toBe(true);
  });

  it('cannot apply a style outside the region, where the user may only view', () => {
    const c = core();
    const before = docOf(c);
    select(c, IDS.intro);
    expect(c.run('paragraphStyle', { style: STYLES.quote })).toBe(false);
    expect(docOf(c)).toBe(before);
  });

  it('is accepted by the server: the styled paragraph reaches another client', async () => {
    const service = newService();
    const docId = service.createDocument(termsDocument() as never, {
      grants: [{ region: IDS.region, principal: 'user:rita', role: 'editor' }],
    });
    const rita = await join(service, docId, 'rita', 'viewer');
    const olivia = await join(service, docId, 'olivia', 'owner');
    await until(() => rita.core.permissions.get() !== null, "Rita's access");
    // The room's own access for a viewer with the grant: no structure, edit in the region only.
    const access = rita.core.permissions.get()!;
    expect(access.docRole).toBe('viewer');
    expect(access.caps).not.toContain('structure');
    expect(access.scopes[REGION]).toContain('edit');
    expect(access.scopes['body']).not.toContain('edit');
    expect(access.scopes['defs']).toEqual(ritaAccess().scopes['defs']);
    expect(access.scopes[STORY]).toEqual(ritaAccess().scopes[STORY]);

    select(rita.core, IDS.first);
    expect(rita.core.run('paragraphStyle', { style: STYLES.quote })).toBe(true);
    await rita.core.flush({ timeoutMs: 5000 });
    await until(
      () => attrsOf(olivia.core, IDS.first)['style'] === STYLES.quote,
      "the owner's copy",
    );
    expect(rita.core.recovered.get().count).toBe(0);
    // The commands of criterion 2 answer the same under the room's access.
    expect(rita.core.queryCommand('createStyle')).toMatchObject({
      enabled: false,
      reason: 'no-access',
    });
    expect(rita.core.queryCommand('editHeader')).toMatchObject({
      enabled: false,
      reason: 'no-access',
    });
    rita.detach();
    olivia.detach();
    await service.dispose();
  });
});

/** The commands that change a definition, a header or a footer, with arguments that would run. */
const DEFINITION_COMMANDS: ReadonlyArray<
  readonly [label: string, name: CommandName, args: CommandArgs | undefined, caretIn: string]
> = [
  ['a new style, before it has a name', 'createStyle', undefined, IDS.first],
  [
    'a new style',
    'createStyle',
    { styleDef: { name: 'Clause', kind: 'paragraph', basedOn: 'Normal' } },
    IDS.first,
  ],
  [
    'a style renamed',
    'changeStyle',
    { styleDef: { id: STYLES.quote, name: 'Citation' } },
    IDS.first,
  ],
  [
    'a style given another parent',
    'changeStyle',
    { styleDef: { id: STYLES.quote, basedOn: 'Heading1' } },
    IDS.first,
  ],
  ['a style deleted', 'deleteStyle', { styleDef: { id: STYLES.quote } }, IDS.first],
  [
    'the page setup',
    'setPageSetup',
    { pageSetup: { id: 'ps1', changes: { orientation: 'landscape', marginTop: 720 } } },
    IDS.first,
  ],
  [
    'a first-page header and footer turned on',
    'setPageSetup',
    { pageSetup: { id: 'ps1', changes: { differentFirstPage: true } } },
    IDS.first,
  ],
  ['the header', 'editHeader', undefined, IDS.first],
  [
    'a page number in the header',
    'insertField',
    { field: { kind: 'page', story: { id: IDS.header, pos: 1 } } },
    IDS.first,
  ],
  // A section break makes the page setup of the section after it; it goes in the body only.
  ['a section break', 'insertSectionBreak', { section: { start: 'nextPage' } }, IDS.intro],
];

describe('commands that change definitions, headers or footers (PRM-030 criterion 2)', () => {
  it.each(DEFINITION_COMMANDS)(
    'reports %s as not enabled with no-access, and a run changes nothing',
    (_label, name, args, caretIn) => {
      const c = core();
      select(c, caretIn, false);
      const before = docOf(c);
      expect(c.queryCommand(name, args)).toEqual({
        enabled: false,
        active: false,
        reason: 'no-access',
      });
      expect(c.run(name, args)).toBe(false);
      expect(c.exec(name, args)).toBe(false);
      expect(docOf(c)).toBe(before);
      expect(c.panel.get()).toBeNull();
      // Nothing was queued for the server.
      expect(internals(c).sync.queue).toHaveLength(0);
      expect(internals(c).sync.inflight).toBeNull();
    },
  );

  it.each(DEFINITION_COMMANDS)('reports %s as enabled for an owner', (_label, name, args, at) => {
    const c = core(owner());
    select(c, at, false);
    expect(c.queryCommand(name, args)).toEqual({ enabled: true, active: false });
  });

  it('says why through the style check the styles pane reads, for each operation', () => {
    const c = core();
    for (const op of ['create', 'change', 'delete'] as const)
      expect(c.checkStyleEdit(op, op === 'create' ? undefined : STYLES.quote)).toEqual({
        ok: false,
        reason: 'no-access',
        regions: [],
      });
  });

  it('records a refused style command for the shell, naming the definitions', () => {
    const c = core();
    expect(c.run('deleteStyle', { styleDef: { id: STYLES.quote } })).toBe(false);
    expect(c.refusal.get()).toMatchObject({ reason: 'scope', scopes: ['defs'] });
  });

  it('does not offer a header that would have to be created, and creates none', () => {
    const c = core(ritaAccess(), termsDocument({ header: false }));
    const before = docOf(c);
    expect(outsideBody(before).map((n) => n.type.name)).toEqual(['defs']);
    expect(c.queryCommand('editHeader')).toEqual({
      enabled: false,
      active: false,
      reason: 'no-access',
    });
    // The shell's query for its header command, and the reason it states for it.
    expect(c.query('hasHeader')).toBe(false);
    expect(c.queryReason('hasHeader')).toBe('structure');
    expect(c.run('editHeader')).toBe(false);
    expect(c.editStory('header', 'default')).toBe(false);
    expect(c.editStory('footer', 'default')).toBe(false);
    expect(c.storyVariants().map((v) => [v.part, v.variant, v.story, v.editable])).toEqual([
      ['header', 'default', null, false],
      ['footer', 'default', null, false],
    ]);
    expect(docOf(c).eq(before)).toBe(true);
    expect(c.panel.get()).toBeNull();
    // The owner is offered the same header, and the query draws no identifier for it.
    const o = core(owner(), termsDocument({ header: false }));
    expect(o.queryCommand('editHeader')).toEqual({ enabled: true, active: false });
    expect(o.query('hasHeader')).toBe(true);
    expect(o.queryReason('hasHeader')).toBeNull();
    expect(outsideBody(docOf(o)).map((n) => n.type.name)).toEqual(['defs']);
    expect(o.run('editHeader')).toBe(true);
    expect(outsideBody(docOf(o)).map((n) => n.type.name)).toEqual(['defs', 'story']);
  });

  it('gives the header query its reason only when the rights are what stops the user', () => {
    const c = core();
    expect(c.query('hasHeader')).toBe(false);
    expect(c.queryReason('hasHeader')).toBe('structure');
    // An owner in view mode is stopped by the mode, which the mode switcher explains.
    const viewing = core(owner());
    viewing.setMode('view');
    expect(viewing.query('hasHeader')).toBe(false);
    expect(viewing.queryReason('hasHeader')).toBeNull();
    // A header that would be created under a lock says read-only, not no-access.
    const locked = core(owner(), termsDocument({ header: false }));
    locked.setMode('view');
    expect(locked.queryCommand('editHeader')).toEqual({
      enabled: false,
      active: false,
      reason: 'read-only',
    });
    expect(locked.queryReason('hasHeader')).toBeNull();
    expect(core(owner()).queryReason('hasHeader')).toBeNull();
  });

  it('follows a new access without a reload: structure turns the commands on', () => {
    const c = core();
    select(c, IDS.first, false);
    expect(c.queryCommand('createStyle').enabled).toBe(false);
    expect(c.queryCommand('editHeader').enabled).toBe(false);
    c.setAccess({ ...owner(), rev: 2 });
    expect(c.queryCommand('createStyle')).toEqual({ enabled: true, active: false });
    expect(c.queryCommand('editHeader')).toEqual({ enabled: true, active: false });
    c.setAccess(ritaAccess({ rev: 3 }));
    expect(c.queryCommand('createStyle').reason).toBe('no-access');
    expect(c.queryCommand('editHeader').reason).toBe('no-access');
  });
});

describe('the style definition commands for a user who may change definitions (PRM-030; UX-022)', () => {
  const styleNames = (c: DocumentCore): string[] => c.styles.get().map((s) => s.name);

  it('create, rename and delete a style through run, as the style methods do', () => {
    const c = core(owner());
    expect(c.run('createStyle', { styleDef: { name: 'Clause', kind: 'paragraph' } })).toBe(true);
    expect(styleNames(c)).toContain('Clause');
    const id = c.styles.get().find((s) => s.name === 'Clause')!.id;
    expect(c.run('changeStyle', { styleDef: { id, name: 'Article', basedOn: 'Normal' } })).toBe(
      true,
    );
    expect(c.styles.get().find((s) => s.id === id)).toMatchObject({
      name: 'Article',
      basedOn: 'Normal',
    });
    expect(c.run('deleteStyle', { styleDef: { id } })).toBe(true);
    expect(styleNames(c)).not.toContain('Article');
  });

  it('say what in the document stops them', () => {
    const c = core(owner());
    const reason = (name: CommandName, styleDef: NonNullable<CommandArgs['styleDef']>) =>
      c.queryCommand(name, { styleDef }).reason;
    expect(reason('createStyle', { name: 'clause QUOTE', kind: 'paragraph' })).toBe(
      'duplicate-name',
    );
    expect(reason('createStyle', { name: '  ', kind: 'paragraph' })).toBe('bad-name');
    expect(reason('createStyle', { name: 'New', kind: 'paragraph', basedOn: STYLES.term })).toBe(
      'bad-based-on',
    );
    expect(reason('changeStyle', { id: 'Missing', name: 'x' })).toBe('unknown-style');
    expect(reason('changeStyle', { id: 'Normal', name: 'Plain' })).toBe('built-in');
    expect(reason('changeStyle', { id: STYLES.quote, name: 'Heading 1' })).toBe('duplicate-name');
    expect(reason('deleteStyle', { id: 'Heading1' })).toBe('built-in');
    // A style a paragraph uses is not deleted.
    select(c, IDS.first);
    c.run('paragraphStyle', { style: STYLES.quote });
    expect(reason('deleteStyle', { id: STYLES.quote })).toBe('in-use');
    expect(c.run('deleteStyle', { styleDef: { id: STYLES.quote } })).toBe(false);
    expect(styleNames(c)).toContain('Clause quote');
  });

  it('run nothing without the name or the style they act on', () => {
    const c = core(owner());
    const before = docOf(c);
    expect(c.run('createStyle')).toBe(false);
    expect(c.run('createStyle', { styleDef: { name: 'Clause' } })).toBe(false);
    expect(c.run('changeStyle', { styleDef: { name: 'Clause' } })).toBe(false);
    expect(c.run('deleteStyle', { styleDef: {} })).toBe(false);
    expect(docOf(c)).toBe(before);
  });

  it('are unavailable under a lock and under suggestion mode, with the reason', () => {
    const viewing = core(owner());
    viewing.setMode('view');
    expect(viewing.queryCommand('createStyle').reason).toBe('read-only');
    expect(viewing.run('createStyle', { styleDef: { name: 'Clause', kind: 'paragraph' } })).toBe(
      false,
    );
    const reviewing = core(owner());
    reviewing.setMode('review');
    expect(reviewing.queryCommand('deleteStyle', { styleDef: { id: STYLES.quote } }).reason).toBe(
      'suggestion',
    );
  });

  it('name the region that uses a style the user may not edit (07 §5.3)', () => {
    // An editor with structure, who may not edit the restricted region where the style is used.
    const used = termsDocument();
    const doc = used.doc as Json;
    const body = doc.content![doc.content!.length - 1]!;
    const region = body.content!.find((n) => n.type === 'region')!;
    region.content![0]!.attrs!['style'] = STYLES.quote;
    const structure = owner();
    const editor: Access = {
      ...structure,
      docRole: 'editor',
      caps: [...EDIT, 'fill', 'structure'],
      scopes: { ...structure.scopes, [REGION]: ['view', 'comment'] },
    };
    const c = core(editor, used);
    expect(
      c.queryCommand('changeStyle', { styleDef: { id: STYLES.quote, name: 'Citation' } }),
    ).toEqual({
      enabled: false,
      active: false,
      reason: 'region',
    });
    expect(c.queryCommand('createStyle')).toEqual({ enabled: true, active: false });
  });
});

/**
 * Every command of the core, each with arguments that would make it run for a user who may. The
 * type makes the list complete: a command added to `CommandName` must be added here too.
 */
const EVERY_COMMAND: { readonly [K in CommandName]: ReadonlyArray<CommandArgs | undefined> } = {
  bold: [undefined],
  italic: [undefined],
  underline: [undefined],
  strike: [undefined],
  smallCaps: [undefined],
  allCaps: [undefined],
  superscript: [undefined],
  subscript: [undefined],
  selectAll: [undefined],
  insertFootnote: [undefined],
  editHeader: [undefined],
  editFooter: [undefined],
  undo: [undefined],
  redo: [undefined],
  paragraphStyle: [{ style: STYLES.quote }, { style: 'Heading1' }],
  fontFamily: [{ fontFamily: 'Arial' }],
  fontSize: [{ fontSize: 280 }],
  color: [{ color: '#AA0000' }],
  highlight: [{ highlight: 'yellow' }],
  lang: [{ lang: 'fr' }],
  charStyle: [{ charStyle: STYLES.term }],
  clearFormatting: [undefined],
  applyList: [{ numberingId: 'Num1' }, { numberingId: 'Num2' }],
  removeList: [undefined],
  listLevelUp: [undefined],
  listLevelDown: [undefined],
  restartNumbering: [undefined],
  continueNumbering: [undefined],
  insertCitation: [{ citation: { items: [{ source: 'src1' }] } }],
  addLink: [{ href: 'https://example.com/', title: 'Example' }],
  insertBookmark: [{ name: 'mark1' }],
  followInternalLink: [{ href: '#mark1' }],
  setPageSetup: [
    { pageSetup: { id: 'ps1', changes: { paperSize: 'Letter' } } },
    { pageSetup: { id: 'ps1', changes: { differentFirstPage: true, differentOddEven: true } } },
    { pageSetup: { id: 'ps1', changes: { watermark: 'Draft', pageNumberStart: 5 } } },
  ],
  insertBreak: [{ breakKind: 'page' }, { breakKind: 'line' }],
  insertSectionBreak: [{ section: { start: 'nextPage' } }, { section: { start: 'continuous' } }],
  insertField: [
    { field: { kind: 'text' } },
    { field: { kind: 'title', title: 'Title' } },
    { field: { kind: 'page', story: { id: IDS.header, pos: 1 } } },
    { field: { kind: 'pageCount', story: { id: IDS.header, pos: 1 } } },
  ],
  insertToc: [{ toc: {} }],
  insertSymbol: [{ symbol: '§' }],
  insertCaption: [{ caption: { kind: 'here' } }],
  insertReference: [{ reference: { target: `node:${IDS.intro}` } }],
  insertEquation: [{ newEquation: { display: false } }, { newEquation: { display: true } }],
  setEquationLatex: [{ equation: { pos: 1, latex: 'x^2' } }],
  insertRowAbove: [undefined],
  insertRowBelow: [undefined],
  insertColumnLeft: [undefined],
  insertColumnRight: [undefined],
  deleteRow: [undefined],
  deleteColumn: [undefined],
  deleteTable: [undefined],
  mergeCells: [{ cells: { top: 0, left: 0, bottom: 0, right: 1 } }],
  splitCell: [undefined],
  setTableStyle: [{ tableStyle: 'Grid' }, { tableStyle: null }],
  sortTableRows: [{ sortDirection: 'ascending' }],
  setTableSize: [{ tableSize: { rowHeight: 600 } }],
  moveBlockUp: [undefined],
  moveBlockDown: [undefined],
  resizeFigure: [{ figurePos: 1, figureSize: { width: 2000 } }],
  setFigureLayout: [{ figurePos: 1, figureLayout: { placement: 'here' } }],
  increaseIndent: [undefined],
  decreaseIndent: [undefined],
  setParagraphFormat: [{ paragraphFormat: { align: 'center', indentLeft: 720 } }],
  nextEditableRegion: [undefined],
  markRegion: [{ title: 'Mine' }],
  setRegionPolicy: [{ region: IDS.region, policy: 'inherit' }],
  renameRegion: [{ region: IDS.region, title: 'Renamed' }],
  copyFormat: [undefined],
  pasteFormat: [undefined],
  createStyle: [{ styleDef: { name: 'Clause', kind: 'paragraph' } }],
  changeStyle: [
    { styleDef: { id: STYLES.quote, name: 'Citation' } },
    { styleDef: { id: 'Heading1', basedOn: null } },
  ],
  deleteStyle: [{ styleDef: { id: STYLES.quote } }, { styleDef: { id: STYLES.term } }],
};

const RUNS = (Object.keys(EVERY_COMMAND) as CommandName[]).flatMap((name) =>
  EVERY_COMMAND[name].map((args) => [name, args] as const),
);

describe('no command reaches past the region for a region-only editor (PRM-030 criterion 2)', () => {
  it('covers every command of the core, and each of them runs for an owner or is refused for a reason of the document', () => {
    // The list is not vacuous: most commands change the document when the user may.
    let changed = 0;
    for (const [name, args] of RUNS) {
      const c = core(owner());
      select(c, IDS.first);
      const before = docOf(c);
      c.run(name, args);
      if (!docOf(c).eq(before)) changed++;
    }
    expect(RUNS.length).toBeGreaterThanOrEqual(Object.keys(EVERY_COMMAND).length);
    expect(changed).toBeGreaterThan(25);
  });

  it('is a check that can fail: for an owner the same runs do change definitions, stories and the region itself', () => {
    const caught = new Set<CommandName>();
    for (const [name, args] of RUNS) {
      const c = core(owner());
      select(c, IDS.first);
      const before = docOf(c);
      c.run(name, args);
      try {
        expectOnlyRegionContentChanged(before, docOf(c));
      } catch {
        caught.add(name);
      }
    }
    expect([...caught].sort()).toEqual([
      'changeStyle',
      'createStyle',
      'deleteStyle',
      'editFooter',
      'insertField',
      'renameRegion',
      'setPageSetup',
      'setRegionPolicy',
    ]);
  });

  it.each(['a selection in the region', 'a caret in the region'] as const)(
    'with %s, a run of any command leaves the definitions, the stories and the body outside the region as they were',
    (where) => {
      let changed = 0;
      for (const [name, args] of RUNS) {
        const c = core();
        select(c, IDS.first, where === 'a selection in the region');
        // The format painter has something to paste.
        if (name === 'pasteFormat') c.run('copyFormat');
        const before = docOf(c);
        c.run(name, args);
        if (!docOf(c).eq(before)) changed++;
        try {
          expectOnlyRegionContentChanged(before, docOf(c));
        } catch (error) {
          throw new Error(`${name} ${JSON.stringify(args)}: ${String(error)}`, { cause: error });
        }
      }
      // The user's own part is live: many of the commands did change the region's content.
      expect(changed).toBeGreaterThan(where === 'a selection in the region' ? 20 : 10);
    },
  );

  it('with the caret outside the region, where the user may only view, no command changes the document', () => {
    for (const [name, args] of RUNS) {
      const c = core();
      select(c, IDS.intro);
      const before = docOf(c);
      c.run(name, args);
      expect(docOf(c).eq(before), `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it('has no command that changes a numbering definition: lists name the ones the document has', () => {
    for (const [name, args] of RUNS) {
      const c = core(owner());
      select(c, IDS.first);
      const numbering = (doc: Node): Node[] => {
        const out: Node[] = [];
        doc.firstChild!.forEach((n) => {
          if (n.type.name === 'numbering_def') out.push(n);
        });
        return out;
      };
      const before = numbering(docOf(c));
      c.run(name, args);
      const after = numbering(docOf(c));
      expect(after.length, name).toBe(before.length);
      after.forEach((n, i) => expect(n.eq(before[i]!), name).toBe(true));
    }
  });
});

describe('the spike document (the page setup part, round 4)', () => {
  const PAGE_SETUP = { pageSetup: { id: 'ps1', changes: { paperSize: 'Letter' as const } } };

  it('reports setPageSetup as not enabled, with a reason, and leaves the document unchanged', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: regionOnlyAccess(),
      schedule: microtask,
    });
    const before = internals(c).state.doc;
    const state = c.queryCommand('setPageSetup', PAGE_SETUP);
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe('no-access');
    expect(c.run('setPageSetup', PAGE_SETUP)).toBe(false);
    expect(internals(c).state.doc).toBe(before);
  });

  it('reports the same command as enabled for an owner, so the refusal comes from the access', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: ownerAccess(),
      schedule: microtask,
    });
    expect(c.queryCommand('setPageSetup', PAGE_SETUP)).toMatchObject({ enabled: true });
  });
});
