/**
 * Test instrumentation (spike S1, the input matrix of FE-123, and the engine's own tests). The
 * helpers read and change the core's state in ways the document API never offers. Not part of the
 * product API: the element loads it only when a demo page opts in.
 */
import { validate } from '@docedit/model/validate';
import type { Node as PMNode } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import { Transform } from 'prosemirror-transform';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { BodySelection, bodyRange, withinBody } from './body.ts';
import type { DocumentCore } from './core.ts';
import { internals } from './internals.ts';
import { unconfirmed } from './sync/state.ts';
import { viewsOf } from './view/web.ts';

export { spikeDocument, SPIKE_IDS } from './spike-document.ts';
export { internals, type Internals } from './internals.ts';
export { viewsOf } from './view/web.ts';
export { press } from './keys.ts';
export { rebuildStats } from './remote.ts';

export type RemoteMode = 'map' | 'rebase';

export interface RemoteInsert {
  /** Identifier of the node to insert into (a paragraph, a footnote or a story). */
  node: string;
  /** Offset inside the node's content, or its start or end. */
  at: 'start' | 'end' | number;
  text: string;
  mode: RemoteMode;
}

export interface RemoteParagraph {
  /** Identifier of the block before which the paragraph is inserted. */
  before: string;
  text: string;
  id: string;
  mode: RemoteMode;
}

/** A remote commit that removes one block (FE-028: the selection is mapped as for a local removal). */
export interface RemoteDelete {
  /** Identifier of the block to remove, with its whole node. */
  node: string;
  mode: RemoteMode;
}

export type RemoteOp =
  | ({ kind: 'insert' } & RemoteInsert)
  | ({ kind: 'paragraph' } & RemoteParagraph)
  | ({ kind: 'delete' } & RemoteDelete);

function findById(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
  let hit: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.attrs['id'] === id) hit = { node, pos };
    return !hit;
  });
  return hit;
}

/** The text of a range, one line per textblock. */
function blocksText(doc: PMNode, from: number, to: number): string {
  const lines: string[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock) {
      lines.push(node.textBetween(0, node.content.size, '', (leaf) => leafText(leaf)));
      return false;
    }
    return true;
  });
  return lines.join('\n');
}

function leafText(leaf: PMNode): string {
  if (leaf.type.name === 'footnote') return `[^${leaf.textContent}]`;
  return leaf.type.spec.leafText?.(leaf) ?? '';
}

export class SpikeHarness {
  readonly core: DocumentCore;
  readonly #log: string[] = [];
  readonly #detach: Array<() => void> = [];

  constructor(core: DocumentCore) {
    this.core = core;
  }

  get #state() {
    return internals(this.core).state;
  }

  get view(): EditorView {
    const v = viewsOf(this.core).view;
    if (!v) throw new Error('the body view is not mounted');
    return v;
  }

  #sub() {
    return viewsOf(this.core).subEditor;
  }

  #dispatch(tr: Parameters<ReturnType<typeof internals>['dispatch']>[0]): void {
    internals(this.core).dispatch(tr);
  }

  doc(): unknown {
    return this.#state.doc.toJSON();
  }

  bodyText(): string {
    const b = bodyRange(this.#state.doc);
    return blocksText(this.#state.doc, b.start, b.end);
  }

  /** Text content of the node with an identifier (paragraph, footnote, story). */
  nodeText(id: string): string | null {
    const hit = findById(this.#state.doc, id);
    if (!hit) return null;
    if (hit.node.isTextblock || hit.node.inlineContent)
      return hit.node.textBetween(0, hit.node.content.size, '', leafText);
    return blocksText(hit.node, 0, hit.node.content.size);
  }

  /** Everything outside the body, for checks that it never changes. */
  outsideBody(): unknown {
    const doc = this.#state.doc.toJSON() as { content: unknown[] };
    return doc.content.slice(0, -1);
  }

  selection(): {
    type: string;
    from: number;
    to: number;
    anchor: number;
    head: number;
    inBody: boolean;
    body: { start: number; end: number };
    parentType: string;
  } {
    const { selection, doc } = this.#state;
    const b = bodyRange(doc);
    return {
      type:
        selection instanceof BodySelection
          ? 'body'
          : selection instanceof TextSelection
            ? 'text'
            : selection.constructor.name,
      from: selection.from,
      to: selection.to,
      anchor: selection.anchor,
      head: selection.head,
      inBody: selection instanceof BodySelection || withinBody(doc, selection.from, selection.to),
      body: { start: b.start, end: b.end },
      parentType: selection.$from.parent.type.name,
    };
  }

  /** Every node identifier, in document order, with its type. */
  ids(): Array<{ type: string; id: string | null }> {
    const out: Array<{ type: string; id: string | null }> = [];
    this.#state.doc.descendants((node) => {
      if ('id' in node.attrs && node.type.spec.attrs?.['id'])
        out.push({ type: node.type.name, id: (node.attrs['id'] as string | null) ?? null });
      return true;
    });
    return out;
  }

  validate(): {
    valid: boolean;
    violations: Array<{ invariant: string; path: string; message: string }>;
  } {
    const r = validate(this.core.getContent());
    return { valid: r.valid, violations: r.violations.map((v) => ({ ...v })) };
  }

  /** Puts a text selection at a position of the first occurrence of `text` (plus `offset`). */
  selectText(text: string, offset = 0, length = 0): number {
    const doc = this.#state.doc;
    let at = -1;
    doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + offset;
      return at < 0;
    });
    if (at < 0) throw new Error(`text not found: ${text}`);
    this.#dispatch(this.#state.tr.setSelection(TextSelection.create(doc, at, at + length)));
    this.view.focus();
    return at;
  }

  /** Puts the caret at the start or end of the node with an identifier. */
  caretIn(id: string, at: 'start' | 'end'): void {
    const doc = this.#state.doc;
    const hit = findById(doc, id);
    if (!hit) throw new Error(`no node ${id}`);
    const pos = at === 'start' ? hit.pos + 1 : hit.pos + hit.node.nodeSize - 1;
    this.#dispatch(this.#state.tr.setSelection(Selection.near(doc.resolve(pos))));
    this.view.focus();
  }

  /** Selects from the start of `fromText` to the start of `toText` (both first occurrences). */
  selectBetween(fromText: string, toText: string): void {
    const doc = this.#state.doc;
    const find = (t: string) => {
      let at = -1;
      doc.descendants((node, pos) => {
        if (at >= 0) return false;
        if (node.isText && node.text!.includes(t)) at = pos + node.text!.indexOf(t);
        return at < 0;
      });
      if (at < 0) throw new Error(`text not found: ${t}`);
      return at;
    };
    this.#dispatch(
      this.#state.tr.setSelection(TextSelection.create(doc, find(fromText), find(toText))),
    );
    this.view.focus();
  }

  /** Every footnote in the document, in order, with its text and the types of its children. */
  footnotes(): Array<{ id: string | null; text: string; children: string[] }> {
    const out: Array<{ id: string | null; text: string; children: string[] }> = [];
    this.#state.doc.descendants((node) => {
      if (node.type.name === 'footnote') {
        const children: string[] = [];
        node.forEach((child) => children.push(child.type.name));
        out.push({
          id: (node.attrs['id'] as string | null) ?? null,
          text: node.textContent,
          children,
        });
      }
      return true;
    });
    return out;
  }

  selectedText(): string {
    const { selection, doc } = this.#state;
    return doc.textBetween(selection.from, selection.to, '\n', leafText);
  }

  openFootnote(id: string): void {
    this.core.openFootnote(id);
  }

  openHeader(): boolean {
    return this.core.run('editHeader');
  }

  closePanel(): void {
    this.core.closePanel();
  }

  /** Whether the open sub-editor's view is mounted. */
  subMounted(): boolean {
    return this.#sub() !== null;
  }

  /**
   * Applies a remote insert from inside the next event of a type on the given view, so that a
   * remote commit lands while the browser's composition is open (used where the driver can only
   * commit a composition in one step: Firefox).
   */
  remoteOnNextEvent(
    target: 'main' | 'sub',
    type: 'compositionupdate' | 'keydown',
    op: RemoteOp,
  ): void {
    const view = target === 'main' ? this.view : this.#sub()?.view;
    if (!view) throw new Error('no view');
    const listener = () => {
      view.dom.removeEventListener(type, listener, true);
      this.#log.push(`${target}:remote-on-${type}`);
      this.remote(op);
    };
    view.dom.addEventListener(type, listener, true);
  }

  /** Applies a remote operation now, or the core defers it (a composition is open). */
  remote(op: RemoteOp): 'applied' | 'deferred' {
    const sub = this.#sub();
    const composing = `composing=${viewsOf(this.core).view?.composing ?? false}/${sub?.view.composing ?? false}`;
    const result =
      op.kind === 'insert'
        ? this.remoteInsert(op)
        : op.kind === 'paragraph'
          ? this.remoteParagraph(op)
          : this.remoteDelete(op);
    this.#log.push(`remote-${result}:${composing}`);
    return result;
  }

  /** Remote commits waiting for a composition to end. */
  deferredRemote(): number {
    return internals(this.core).deferredRemote;
  }

  /** Spike S2: an inline decoration with a `style` attribute (ProseMirror writes it with style.cssText). */
  styleDecoration(text: string, style: string): boolean {
    const doc = this.#state.doc;
    let from = -1;
    doc.descendants((node, pos) => {
      if (from >= 0) return false;
      if (node.isText && node.text!.includes(text)) from = pos + node.text!.indexOf(text);
      return from < 0;
    });
    if (from < 0) return false;
    const set = DecorationSet.create(doc, [
      Decoration.inline(from, from + text.length, { style, class: 'de-style-decoration' }),
    ]);
    this.view.setProps({ decorations: () => set });
    return true;
  }

  /** Unconfirmed local steps. */
  pending(): number {
    return unconfirmed(internals(this.core).sync).length;
  }

  confirm(): void {
    internals(this.core).confirmAll();
  }

  remoteInsert(op: RemoteInsert): 'applied' | 'deferred' {
    const i = internals(this.core);
    const base = op.mode === 'rebase' ? i.sync.confirmed : i.state.doc;
    const hit = findById(base, op.node);
    if (!hit)
      throw new Error(
        `no node ${op.node} in the ${op.mode === 'rebase' ? 'confirmed' : 'current'} document`,
      );
    const start = hit.pos + 1;
    const end = hit.pos + hit.node.nodeSize - 1;
    // A footnote or a story holds paragraphs: insert into its first or last one.
    const pos = hit.node.inlineContent
      ? op.at === 'start'
        ? start
        : op.at === 'end'
          ? end
          : start + op.at
      : op.at === 'end'
        ? end - 1
        : op.at === 'start'
          ? start + 1
          : start + 1 + op.at;
    const steps = new Transform(base).insert(pos, i.schema.text(op.text)).steps;
    return i.applyRemote(steps, op.mode);
  }

  remoteParagraph(op: RemoteParagraph): 'applied' | 'deferred' {
    const i = internals(this.core);
    const base = op.mode === 'rebase' ? i.sync.confirmed : i.state.doc;
    const hit = findById(base, op.before);
    if (!hit) throw new Error(`no node ${op.before}`);
    const para = i.schema.nodes['paragraph']!.create(
      { id: op.id },
      op.text ? i.schema.text(op.text) : null,
    );
    const steps = new Transform(base).insert(hit.pos, para).steps;
    return i.applyRemote(steps, op.mode);
  }

  remoteDelete(op: RemoteDelete): 'applied' | 'deferred' {
    const i = internals(this.core);
    const base = op.mode === 'rebase' ? i.sync.confirmed : i.state.doc;
    const hit = findById(base, op.node);
    if (!hit) throw new Error(`no node ${op.node}`);
    const steps = new Transform(base).delete(hit.pos, hit.pos + hit.node.nodeSize).steps;
    return i.applyRemote(steps, op.mode);
  }

  composing(): { main: boolean; sub: boolean } {
    return {
      main: viewsOf(this.core).view?.composing ?? false,
      sub: this.#sub()?.view.composing ?? false,
    };
  }

  subText(): string | null {
    const sub = this.#sub();
    if (!sub) return null;
    const doc = sub.view.state.doc;
    return doc.inlineContent
      ? doc.textBetween(0, doc.content.size, '', leafText)
      : blocksText(doc, 0, doc.content.size);
  }

  subDoc(): unknown {
    return this.#sub()?.view.state.doc.toJSON() ?? null;
  }

  /** Puts the caret in the sub-editor at its start or end. */
  subCaret(at: 'start' | 'end'): void {
    const sub = this.#sub();
    if (!sub) throw new Error('no sub-editor');
    const doc = sub.view.state.doc;
    const sel = at === 'start' ? Selection.atStart(doc) : Selection.atEnd(doc);
    sub.view.dispatch(sub.view.state.tr.setSelection(sel));
    sub.view.focus();
  }

  /** Copies the current selection through ProseMirror's clipboard serialiser and pastes it at the caret. */
  copyPasteSelection(target: 'main' | 'sub', at: 'end' | 'replace' = 'end'): string {
    const view = target === 'main' ? this.view : this.#sub()?.view;
    if (!view) throw new Error('no view');
    const { dom } = view.serializeForClipboard(view.state.selection.content());
    const html = dom.innerHTML;
    if (at === 'end') view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
    view.pasteHTML(html);
    return html;
  }

  pasteHTML(target: 'main' | 'sub', html: string): boolean {
    const view = target === 'main' ? this.view : this.#sub()?.view;
    if (!view) throw new Error('no view');
    return view.pasteHTML(html);
  }

  /** Records composition, input and key events on the body view and the sub-editor. */
  watchEvents(): void {
    const targets: Array<[string, EventTarget | undefined]> = [
      ['main', viewsOf(this.core).view?.dom],
      ['sub', this.#sub()?.view.dom],
    ];
    for (const [name, target] of targets) {
      if (!target) continue;
      for (const type of [
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'beforeinput',
        'input',
        'keydown',
      ]) {
        const listener = (e: Event) => {
          const detail =
            e instanceof CompositionEvent
              ? JSON.stringify(e.data)
              : e instanceof InputEvent
                ? `${e.inputType}:${JSON.stringify(e.data)}:${e.isComposing}`
                : e instanceof KeyboardEvent
                  ? `${e.key}:${e.isComposing}`
                  : '';
          this.#log.push(`${name}:${type}:${detail}`);
        };
        target.addEventListener(type, listener, true);
        this.#detach.push(() => target.removeEventListener(type, listener, true));
      }
    }
  }

  events(): string[] {
    return [...this.#log];
  }

  clearEvents(): void {
    this.#log.length = 0;
  }

  unwatchEvents(): void {
    for (const detach of this.#detach.splice(0)) detach();
  }
}
