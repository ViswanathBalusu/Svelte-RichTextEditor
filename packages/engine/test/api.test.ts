/**
 * The document API (02 §5.1; FE-026) and the read views (02 §4; FE-023, FE-024): queries in plain
 * data, no ProseMirror type on the surface, and at most one notification pass per frame.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DocumentApi } from '../src/api.ts';
import { DocumentCore, type EditorCore } from '../src/index.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { caret, microtask, posOf, type } from './support.ts';

/** A scheduler the test runs by hand: one call is one animation frame. */
function frames() {
  const queue: Array<() => void> = [];
  return {
    schedule: (run: () => void) => void queue.push(run),
    run(): number {
      const n = queue.length;
      for (const f of queue.splice(0)) f();
      return n;
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('no ProseMirror type on the document API (FE-026 criterion 2)', () => {
  it('the API file imports nothing from ProseMirror', () => {
    const text = readFileSync(resolve(import.meta.dirname, '../src/api.ts'), 'utf8');
    expect(/from\s+['"]prosemirror-/.test(text)).toBe(false);
  });

  it('every public member of the cores is a member of the document API or of the web view', () => {
    // A member not listed here fails to compile: the surface is the API, nothing else.
    type Allowed =
      | keyof DocumentApi
      | 'hasParagraphStyle'
      | 'readOnly'
      | 'reconnect'
      | 'onTransaction'
      // FE-005: the element suspends and resumes the channel when a host moves it out and back.
      | 'suspendSync'
      | 'resumeSync'
      // SYN-036: the peers of `presence` with their positions in the visible document.
      | 'peerSelections'
      // PRM-034: the element re-reads the region list when a region is renamed, added or removed.
      | 'regionTitles'
      // UX-017: the recovered edits pane puts a set-aside edit back or drops it, by its id.
      | 'insertRecovered'
      | 'discardRecovered'
      // UX-018: the status bar's word count and the document language at the selection.
      | 'words'
      | 'language'
      // FRW-004: the entries of form fields, for the field controls of the web view. The fill
      // methods of the embedding API (12 §10) are FRW-069's and are not on the document API yet.
      | 'fieldEntry'
      | 'checkFieldEntry'
      | 'fieldFillable'
      | 'fieldRuleState'
      | 'enterFieldValue'
      | 'validateFields'
      // FRW-070, FRW-078: the fields of fill mode without their values, and the entries a person made.
      | 'fillFields'
      // FRW-069: the field members of the embedding API.
      | 'fieldValues'
      | 'fillField'
      | 'onFieldChange'
      // FRW-074: the roles of the document and the changes to them, for the roles manager.
      | 'roles'
      | 'nextRoleId'
      | 'editRole'
      // FRW-073: the properties of a form field and the changes to them, for the properties pane.
      | 'formFields'
      | 'fieldProperties'
      | 'selectedField'
      | 'selectField'
      | 'canEditField'
      | 'editField'
      // FE-070: the equation the person selected, the request to edit it, and its confirmation, for the math editor.
      | 'equationAt'
      | 'selectedEquation'
      | 'selectEquation'
      | 'requestEquationEdit'
      | 'equationRequest'
      | 'equationAccess'
      | 'equationLimits'
      | 'checkEquationSource'
      | 'confirmEquation'
      // UX-018: the language at the selection and the document's, and the word count, for the status bar.
      | 'language'
      | 'words'
      // UX-017: the recovered edits pane puts an item back into the document or drops it.
      | 'insertRecovered'
      | 'discardRecovered'
      // UX-035: the markup view of suggestions and the label that names one for assistive technology.
      | 'markupView'
      | 'setMarkupView'
      | 'setSuggestionLabel'
      | 'suggestionLabel';
    expectTypeOf<Exclude<keyof DocumentCore, Allowed>>().toEqualTypeOf<never>();
    type WebAllowed =
      | Allowed
      | 'mountBody'
      | 'mountPanel'
      | 'selectionShimResult'
      | 'setLabels'
      | 'labels'
      // FE-068: the element hands the web view the blocks that start a page.
      | 'setPageGuides'
      // UX-008: where the shell opens a menu asked for from the keyboard.
      | 'caretRect'
      // SYN-036: the peers' carets as rectangles, which the shell draws (UX-027).
      | 'carets'
      // FRW-078: the summary's link moves focus to a field's control.
      | 'focusField'
      // FRW-069: focus by key, and the next field the person may fill.
      | 'focusFieldByKey'
      | 'nextFillableField'
      // HIS-013: a read-only version view draws a comparison over its document.
      | 'setComparison';
    expectTypeOf<Exclude<keyof EditorCore, WebAllowed>>().toEqualTypeOf<never>();
  });
});

describe('queries (FE-026)', () => {
  it('selectionScope returns the scope and the block in the shape of de-selection', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    caret(c, SPIKE_IDS.intro, 2);
    expect(c.selectionScope()).toEqual({ scope: 'body', blockId: SPIKE_IDS.intro });
    caret(c, SPIKE_IDS.legal, 2);
    expect(c.selectionScope()).toEqual({
      scope: `region:${SPIKE_IDS.region}`,
      blockId: SPIKE_IDS.legal,
    });
  });

  it('canEdit follows the access, and is false for a region the access does not list', () => {
    const access = editorAccess();
    const c = new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
    expect(c.canEdit('body')).toBe(true);
    expect(c.canEdit(`region:${SPIKE_IDS.region}`)).toBe(false);
    expect(c.canEdit('defs')).toBe(false);
    expect(c.canEdit(`story:${SPIKE_IDS.header}`)).toBe(false);
    expect(c.canEdit('region:rUnknown00000001')).toBe(false);
    c.setAccess(
      editorAccess({
        rev: 2,
        caps: ['view', 'comment'],
        scopes: { ...access.scopes, body: ['view', 'comment'] },
      }),
    );
    expect(c.canEdit('body')).toBe(false);
  });

  it('activeMarks and queryCommand answer from the selection', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const i = internals(c);
    const at = posOf(i.state.doc, SPIKE_IDS.legal) + 1 + 'Liability is limited to '.length;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 1, at + 4)));
    expect(c.activeMarks()).toEqual(['bold']);
    expect(c.queryCommand('bold')).toEqual({ enabled: true, active: true });
    expect(c.queryCommand('italic')).toEqual({ enabled: true, active: false });
    expect(c.query('isBold')).toBe(true);
    expect(c.query('canUndo')).toBe(false);
    expect(c.queryCommand('undo').enabled).toBe(false);
    type(c, 'x');
    expect(c.queryCommand('undo').enabled).toBe(true);
    expect(c.query('hasHeader')).toBe(true);
    expect(c.query('no-such-query')).toBeUndefined();
    expect(c.queryNames).toContain('canEditSelection');
  });

  it('access at the selection says what limits it', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    caret(c, SPIKE_IDS.after, 1);
    expect(c.access.get()).toEqual({
      scope: 'body',
      caps: ['view', 'comment', 'suggest', 'edit'],
      limit: null,
    });
    caret(c, SPIKE_IDS.legal, 1);
    expect(c.access.get()).toEqual({
      scope: `region:${SPIKE_IDS.region}`,
      caps: ['view', 'comment'],
      limit: 'region',
    });
    expect(c.query('canEditSelection')).toBe(false);
    expect(c.queryCommand('bold').enabled).toBe(false);
  });
});

describe('read-only views, one update per frame (FE-023, FE-024)', () => {
  it('exposes selection, marks, style, permissions, connection and command state as small views', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    expect(c.selection.get()).toMatchObject({ scope: 'body', style: 'Heading1' });
    expect(c.permissions.get()).toBeNull();
    expect(c.connection.get()).toBe('detached');
    expect(c.status.get()).toEqual({ connection: 'offline', sync: 'saved' });
    expect(c.commands.get().bold).toEqual({ enabled: true, active: false });
    for (const v of [
      c.selection,
      c.outline,
      c.permissions,
      c.access,
      c.saveState,
      c.commands,
      c.revision,
    ])
      expect(typeof v.subscribe).toBe('function');
  });

  it('ten transactions in one frame notify each subscriber at most once, with the final values', () => {
    const f = frames();
    const c = new DocumentCore({ doc: spikeDocument(), schedule: f.schedule });
    f.run();
    const calls = { selection: 0, outline: 0, revision: 0, commands: 0 };
    c.selection.subscribe(() => calls.selection++);
    c.outline.subscribe(() => calls.outline++);
    c.revision.subscribe(() => calls.revision++);
    c.commands.subscribe(() => calls.commands++);
    caret(c, SPIKE_IDS.title, 'end');
    for (let k = 0; k < 10; k++) type(c, String(k));
    expect(f.pending).toBe(1); // one pass scheduled for everything
    expect(f.run()).toBe(1);
    expect(calls.selection).toBeLessThanOrEqual(1);
    expect(calls.outline).toBe(1); // the heading's text changed
    expect(calls.revision).toBe(1);
    expect(calls.commands).toBe(1);
    expect(c.outline.get()[0]!.text).toBe('Scope0123456789');
    expect(internals(c).hub.passes).toBe(2);
  });

  it('a transaction that changes no view schedules nothing', () => {
    const f = frames();
    const c = new DocumentCore({ doc: spikeDocument(), schedule: f.schedule });
    f.run();
    const i = internals(c);
    i.dispatch(i.state.tr.setMeta('x-anything', true));
    expect(f.pending).toBe(0);
  });

  it('the editing surface updates in the same call; the interface waits for the frame', () => {
    const f = frames();
    const c = new DocumentCore({ doc: spikeDocument(), schedule: f.schedule });
    f.run();
    let notified = 0;
    c.selection.subscribe(() => notified++);
    caret(c, SPIKE_IDS.legal, 1);
    // The state (what the view draws from) changed synchronously; the view's own update is called
    // from dispatch (view/web.ts), so it is never delayed to the next frame.
    expect(internals(c).state.selection.$from.parent.attrs['id']).toBe(SPIKE_IDS.legal);
    expect(notified).toBe(0);
    f.run();
    expect(notified).toBe(1);
  });

  it('a view registered with the core is updated inside dispatch, before the frame', () => {
    const f = frames();
    const updates: number[] = [];
    class Probe extends DocumentCore {
      constructor() {
        super({ doc: spikeDocument(), schedule: f.schedule });
        this.addView({
          update: (state) => updates.push(state.selection.from),
          composing: () => null,
          focus: () => {},
        });
      }
    }
    const c = new Probe();
    f.run();
    caret(c, SPIKE_IDS.legal, 1);
    expect(updates).toEqual([internals(c).state.selection.from]);
    expect(f.pending).toBe(1); // the interface's update waits for the frame
  });

  it('a burst of remote commits gives one pass with the final state', () => {
    const f = frames();
    const c = new DocumentCore({ doc: spikeDocument(), schedule: f.schedule });
    f.run();
    const i = internals(c);
    let outline = 0;
    c.outline.subscribe(() => outline++);
    for (let k = 0; k < 5; k++) {
      const pos = posOf(i.sync.confirmed, SPIKE_IDS.title) + 1;
      const step = i.state.tr.insertText(`r${k}`, pos).steps[0]!;
      expect(i.applyRemote([step], 'rebase')).toBe('applied');
    }
    expect(f.run()).toBe(1);
    expect(outline).toBe(1);
    expect(c.outline.get()[0]!.text).toBe('r4r3r2r1r0Scope');
    expect(c.confirmedSeq.get()).toBe(5);
  });

  it('a large document: a keystroke notifies only the views that changed', () => {
    const env = spikeDocument();
    const doc = structuredClone(env.doc) as { content: Array<{ content?: unknown[] }> };
    const body = doc.content[doc.content.length - 1]!;
    // About 100 pages of paragraphs (3,000 paragraphs of 60 characters).
    for (let k = 0; k < 3000; k++)
      body.content!.push({
        type: 'paragraph',
        attrs: { id: `pBulk${String(k).padStart(11, '0')}` },
        content: [
          { type: 'text', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed.' },
        ],
      });
    const f = frames();
    const c = new DocumentCore({ doc: { ...env, doc }, schedule: f.schedule });
    f.run();
    const counts = new Map<string, number>();
    const views = {
      selection: c.selection,
      outline: c.outline,
      permissions: c.permissions,
      access: c.access,
      saveState: c.saveState,
      confirmedSeq: c.confirmedSeq,
      connection: c.connection,
      commands: c.commands,
      refusal: c.refusal,
      recovered: c.recovered,
      syncSummary: c.syncSummary,
      direction: c.direction,
      status: c.status,
      revision: c.revision,
      panel: c.panel,
    };
    for (const [name, v] of Object.entries(views))
      v.subscribe(() => counts.set(name, (counts.get(name) ?? 0) + 1));
    caret(c, 'pBulk00000001500', 3);
    f.run();
    counts.clear();
    type(c, 'x');
    f.run();
    // A keystroke in a plain paragraph: the revision, the queue, the save state and the undo state
    // change; the outline, the selection summary, the access and the rest do not.
    const allowed = ['commands', 'revision', 'syncSummary', 'saveState', 'status'];
    for (const k of counts.keys()) expect(allowed, k).toContain(k);
    for (const k of counts.values()) expect(k).toBe(1);
    expect(counts.has('revision')).toBe(true);
    expect(counts.has('outline')).toBe(false);
    expect(counts.has('selection')).toBe(false);
  });
});
