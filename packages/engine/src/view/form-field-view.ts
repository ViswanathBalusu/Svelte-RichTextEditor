/**
 * Form fields and their mirrors in the web view (12 §3.2, §3.4, §11; FRW-004, FRW-006).
 *
 * - A `form_field` of kind `text`, `number`, `date`, `checkbox` or `choice` is a node view that
 *   holds a native control in the same shadow root. The control is named by the field's `label`,
 *   carries `aria-required`, and carries `aria-invalid` with a message it is described by (`aria-description`) while
 *   its entry has a problem (FRW-004 criterion 1). The other kinds, and a redacted value, keep the
 *   static text of the schema.
 * - An entry is checked while it is typed and submitted when the control reports a change. The
 *   core keeps an entry with a problem, so the control still shows it after the authority dropped
 *   it (FRW-004 criterion 5).
 * - A `field` of kind `formValue` is an atom that shows the value of its target field. Every
 *   mirror is drawn again after each change of the document, so it follows the target without a
 *   reload (FRW-006 criterion 1), and its accessible name says which field it shows (criterion 5).
 *
 * Kept out of the core so that the headless entry builds no DOM (FE-121).
 */
import { type FormFieldValue, type JsonValue, fieldText } from '@docedit/model';
import { isRedactionMarker } from '@docedit/model/definition';
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import type { FieldEntryState } from '../field-entries.ts';

/** What the views need from the core. */
export interface FormFieldPort {
  entry(id: string): FieldEntryState | null;
  check(id: string, value: JsonValue): ReadonlyArray<{ readonly message: string }>;
  enter(id: string, value: JsonValue): void;
  fillable(id: string): boolean;
  /** The control of the field took focus: the field is the one the person selected (FRW-073). */
  focused?(id: string): void;
}

/** The kinds drawn as a native control. */
const CONTROL_KINDS = new Set(['text', 'number', 'date', 'checkbox', 'choice']);

type Control = HTMLInputElement | HTMLSelectElement;

interface Refreshable {
  refresh(doc: PMNode): void;
}

/** The live field and mirror views of one editor view, so that they can be drawn again. */
export class FormFieldViews {
  readonly #views = new Set<Refreshable>();
  #doc: PMNode | null = null;
  #fields: ReadonlyMap<string, PMNode> = new Map();

  add(view: Refreshable): void {
    this.#views.add(view);
  }

  remove(view: Refreshable): void {
    this.#views.delete(view);
  }

  /** The form fields of `doc` by key; walked once for each version of the document. */
  fieldsOf(doc: PMNode): ReadonlyMap<string, PMNode> {
    if (this.#doc === doc) return this.#fields;
    const fields = new Map<string, PMNode>();
    doc.descendants((node) => {
      if (node.type.name !== 'form_field') return true;
      const key = node.attrs['key'];
      if (typeof key === 'string' && !fields.has(key)) fields.set(key, node);
      return false;
    });
    this.#doc = doc;
    this.#fields = fields;
    return fields;
  }

  /** Draws every live view again from `doc`: after a change of the document, the access or the mode. */
  refresh(doc: PMNode): void {
    for (const view of this.#views) view.refresh(doc);
  }
}

/** The schema's own drawing of a node, for the nodes these views do not draw themselves. */
function schemaDOM(node: PMNode): HTMLElement {
  const spec = node.type.spec.toDOM;
  if (!spec) throw new Error(`the node ${node.type.name} has no drawing`);
  const { dom } = DOMSerializer.renderSpec(document, spec(node));
  return dom as HTMLElement;
}

function optionsOf(node: PMNode): Array<{ id: string; label: string }> {
  const options: unknown = node.attrs['options'];
  if (!Array.isArray(options)) return [];
  const out: Array<{ id: string; label: string }> = [];
  for (const o of options as unknown[]) {
    if (typeof o !== 'object' || o === null) continue;
    const { id, label } = o as { id?: unknown; label?: unknown };
    if (typeof id === 'string') out.push({ id, label: typeof label === 'string' ? label : id });
  }
  return out;
}

class FormFieldView implements NodeView, Refreshable {
  readonly dom: HTMLElement;
  readonly #port: FormFieldPort;
  readonly #views: FormFieldViews;
  readonly #control: Control;
  readonly #message: HTMLElement;
  #node: PMNode;
  /** The person typed since the last submitted entry. */
  #dirty = false;

  constructor(node: PMNode, port: FormFieldPort, views: FormFieldViews) {
    this.#node = node;
    this.#port = port;
    this.#views = views;
    const kind = String(node.attrs['kind']);
    const dom = document.createElement('span');
    dom.className = 'de-form-field';
    dom.setAttribute('data-kind', kind);
    dom.setAttribute('data-field', String(node.attrs['id']));
    dom.contentEditable = 'false';
    this.dom = dom;

    this.#control = this.#makeControl(kind);
    const message = document.createElement('span');
    message.className = 'de-form-field-message';
    message.setAttribute('role', 'alert');
    message.hidden = true;
    this.#message = message;
    dom.append(this.#control, message);

    this.#control.addEventListener('input', this.#typed);
    this.#control.addEventListener('change', this.#changed);
    this.#control.addEventListener('focus', this.#focused);
    views.add(this);
    this.#draw();
  }

  #makeControl(kind: string): Control {
    if (kind === 'choice') {
      const select = document.createElement('select');
      select.className = 'de-form-field-control';
      return select;
    }
    const input = document.createElement('input');
    input.className = 'de-form-field-control';
    if (kind === 'checkbox') input.type = 'checkbox';
    else if (kind === 'date') input.type = 'date';
    else {
      input.type = 'text';
      // A number is a decimal string and is never read as a binary float (12 §3.3).
      if (kind === 'number') input.inputMode = 'decimal';
    }
    return input;
  }

  get #id(): string {
    return String(this.#node.attrs['id']);
  }

  /** The entry the control holds now, as a field value; an empty control is an empty value. */
  #entry(): JsonValue {
    const c = this.#control;
    const kind = String(this.#node.attrs['kind']);
    if (kind === 'checkbox') return (c as HTMLInputElement).checked;
    const text = kind === 'number' ? c.value.trim() : c.value;
    return text === '' ? null : text;
  }

  readonly #typed = (): void => {
    const kind = String(this.#node.attrs['kind']);
    if (kind !== 'text' && kind !== 'number') return;
    if (!this.#port.fillable(this.#id)) return this.#draw();
    this.#dirty = true;
    this.#showProblems(this.#port.check(this.#id, this.#entry()));
  };

  readonly #focused = (): void => {
    this.#port.focused?.(this.#id);
  };

  readonly #changed = (): void => {
    this.#dirty = false;
    if (this.#port.fillable(this.#id)) this.#port.enter(this.#id, this.#entry());
    this.#draw();
  };

  #showProblems(problems: ReadonlyArray<{ readonly message: string }>): void {
    const c = this.#control;
    if (problems.length === 0) {
      c.removeAttribute('aria-invalid');
      c.removeAttribute('aria-description');
      this.#message.textContent = '';
      this.#message.hidden = true;
      return;
    }
    const text = problems.map((p) => p.message).join('; ');
    c.setAttribute('aria-invalid', 'true');
    // The description is the message's text, not a reference to its id: no ID reference is set
    // from script (FE-108 criterion 2).
    c.setAttribute('aria-description', text);
    this.#message.textContent = text;
    this.#message.hidden = false;
  }

  /** Draws the control from what the core says the field shows. */
  #draw(): void {
    const node = this.#node;
    const c = this.#control;
    const state = this.#port.entry(this.#id);
    const label = node.attrs['label'];
    c.setAttribute(
      'aria-label',
      typeof label === 'string' && label !== '' ? label : String(node.attrs['key']),
    );
    if (node.attrs['required'] === true) c.setAttribute('aria-required', 'true');
    else c.removeAttribute('aria-required');

    const fillable = this.#port.fillable(this.#id);
    if (c instanceof HTMLSelectElement || c.type === 'checkbox') c.disabled = !fillable;
    else c.readOnly = !fillable;

    if (c instanceof HTMLSelectElement) {
      const options = [{ id: '', label: '' }, ...optionsOf(node)];
      c.replaceChildren(
        ...options.map((o) => {
          const el = document.createElement('option');
          el.value = o.id;
          el.textContent = o.label;
          return el;
        }),
      );
    }
    if (this.#dirty) return;
    const value = state ? state.value : null;
    if (c instanceof HTMLInputElement && c.type === 'checkbox') c.checked = value === true;
    else c.value = typeof value === 'string' ? value : '';
    this.#showProblems(state ? state.problems : []);
  }

  refresh(): void {
    this.#draw();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.#node.type) return false;
    if (node.attrs['kind'] !== this.#node.attrs['kind']) return false;
    if (node.attrs['id'] !== this.#node.attrs['id']) return false;
    if (isRedactionMarker(node.attrs['value'] as JsonValue | undefined)) return false;
    this.#node = node;
    this.#draw();
    return true;
  }

  /** The control's own events are the control's: ProseMirror reads none of them. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.dom.contains(event.target);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.#views.remove(this);
    this.#control.removeEventListener('input', this.#typed);
    this.#control.removeEventListener('change', this.#changed);
    this.#control.removeEventListener('focus', this.#focused);
  }
}

/** The node view of a `form_field`: a native control for the kinds a person fills by hand. */
export function formFieldView(port: FormFieldPort, views: FormFieldViews): NodeViewConstructor {
  return (node) => {
    const drawn =
      CONTROL_KINDS.has(String(node.attrs['kind'])) &&
      typeof node.attrs['id'] === 'string' &&
      !isRedactionMarker(node.attrs['value'] as JsonValue | undefined);
    return drawn ? new FormFieldView(node, port, views) : { dom: schemaDOM(node) };
  };
}

/** What a mirror shows and how it is named, from the document it sits in (FRW-006). */
export function mirrorText(
  node: PMNode,
  fields: ReadonlyMap<string, PMNode>,
): { readonly text: string; readonly name: string } {
  const target = node.attrs['target'];
  const key = typeof target === 'string' && target.startsWith('field:') ? target.slice(6) : null;
  const field = key === null ? undefined : fields.get(key);
  if (!field || key === null) return { text: '', name: 'Value of a field that does not exist' };
  const label = field.attrs['label'];
  const named = typeof label === 'string' && label !== '' ? label : key;
  const value = (field.attrs['value'] ?? null) as JsonValue;
  // A mirror of a value the reader may not read is redacted too (ADR 0019; second review SR-C3).
  if (isRedactionMarker(value))
    return { text: '[redacted]', name: `Value of the field ${named}: redacted` };
  const shown: FormFieldValue = {
    kind: String(field.attrs['kind']),
    value,
    options: (field.attrs['options'] ?? null) as NonNullable<FormFieldValue['options']> | null,
  };
  const computed = fieldText(
    { kind: 'formValue', target: target as string },
    { fields: new Map([[key, shown]]) },
  );
  const text = computed.computed ? computed.text : '';
  return {
    text,
    name:
      text === '' ? `Value of the field ${named}: empty` : `Value of the field ${named}: ${text}`,
  };
}

class MirrorView implements NodeView, Refreshable {
  readonly dom: HTMLElement;
  readonly #views: FormFieldViews;
  #node: PMNode;

  constructor(node: PMNode, doc: PMNode, views: FormFieldViews) {
    this.#node = node;
    this.#views = views;
    const dom = document.createElement('span');
    dom.className = 'de-field de-field-mirror';
    dom.setAttribute('data-kind', 'formValue');
    dom.setAttribute('role', 'note');
    dom.contentEditable = 'false';
    this.dom = dom;
    views.add(this);
    this.refresh(doc);
  }

  refresh(doc: PMNode): void {
    const { text, name } = mirrorText(this.#node, this.#views.fieldsOf(doc));
    if (this.dom.textContent !== text) this.dom.textContent = text;
    this.dom.setAttribute('aria-label', name);
    this.dom.toggleAttribute('data-empty', text === '');
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.#views.remove(this);
  }
}

/** The node view of a `field`: a mirror for `formValue`, the schema's drawing for the others. */
export function fieldView(views: FormFieldViews): NodeViewConstructor {
  return (node, view) =>
    node.attrs['kind'] === 'formValue'
      ? new MirrorView(node, view.state.doc, views)
      : { dom: schemaDOM(node) };
}
