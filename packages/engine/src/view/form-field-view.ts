/**
 * Form fields and their mirrors in the web view (12 §3.2, §3.4, §11; FRW-004, FRW-006).
 *
 * - A `form_field` of kind `text`, `number`, `date`, `checkbox` or `choice` is a node view that
 *   holds a native control in the same shadow root. The control is named by the field's `label`,
 *   carries `aria-required`, and carries `aria-invalid` with a message it is described by (`aria-description`) while
 *   its entry has a problem (FRW-004 criterion 1). The other kinds, and a redacted value, keep the
 *   static text of the schema.
 * - The control is a text input that stops at the field's `maxLength` (in code points), a decimal
 *   entry for a number, a calendar date for a date, a checkbox, or a list of the option labels for
 *   a choice whose stored value is the option's id (FRW-079 criterion 2). A control is described by
 *   its kind and by the role it belongs to, and by the message of its problem (criterion 3).
 * - The field's box is as wide as its `width`, or the default width of its kind, whatever the
 *   control holds (FRW-080 criteria 1 to 3). A paste into a text field with a `maxLength` is cut at
 *   the limit and a live region says so (criterion 4).
 * - `format` changes the display only: while nobody edits the control it shows the formatted text,
 *   and while it is edited it shows the stored value (criterion 4).
 * - An entry is checked while it is typed and submitted when the control reports a change. The
 *   core keeps an entry with a problem, so the control still shows it after the authority dropped
 *   it (FRW-004 criterion 5).
 * - A `field` of kind `formValue` is an atom that shows the value of its target field. Every
 *   mirror is drawn again after each change of the document, so it follows the target without a
 *   reload (FRW-006 criterion 1), and its accessible name says which field it shows (criterion 5).
 * - A `field` of kind `seq` or `ref` shows its computed text, drawn again after each change of the
 *   document (computed-field-view.ts; FE-134 criterion 3).
 *
 * Kept out of the core so that the headless entry builds no DOM (FE-121).
 */
import { type FormFieldValue, type JsonValue, fieldText } from '@docedit/model';
import { fieldWidth, isRedactionMarker } from '@docedit/model/definition';
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { type StaleCache, fieldTexts } from '../captions-refs.ts';
import { formatFieldValue, type FieldFormat } from '../field-display.ts';
import { computedFieldView } from './computed-field-view.ts';
import { rolesOf, type FieldEntryState } from '../field-entries.ts';
import type { FieldRuleState } from '../field-rules.ts';

/** What the views need from the core. */
export interface FormFieldPort {
  entry(id: string): FieldEntryState | null;
  check(id: string, value: JsonValue): ReadonlyArray<{ readonly message: string }>;
  enter(id: string, value: JsonValue): void;
  fillable(id: string): boolean;
  /** What the rules say about the field now (FRW-023); null when none applies. */
  rules?(id: string): FieldRuleState | null;
  /** The control of the field took focus: the field is the one the person selected (FRW-073). */
  focused?(id: string): void;
  /** Whether the person may sign the signature or initials field now (FRW-046). */
  signable?(id: string): boolean;
  /** The person activated a signature or initials field: the shell opens the signing step (FRW-046). */
  signRequest?(id: string): void;
}

/** The kinds drawn as a native control. */
const CONTROL_KINDS = new Set(['text', 'number', 'date', 'checkbox', 'choice', 'formula']);

type Control = HTMLInputElement | HTMLSelectElement;

/** What a screen reader is told of the kind of a field, beside the control's own role. */
const KIND_NAMES: Readonly<Record<string, string>> = {
  text: 'Text field',
  number: 'Number field',
  date: 'Date field',
  checkbox: 'Checkbox field',
  choice: 'Choice field',
  formula: 'Calculated field',
};

/** The number of code points in `text`. */
function codePointsIn(text: string): number {
  return text.length - pairsIn(text);
}

/** The first `count` code points of `text` (none for a count of zero or less). */
function firstCodePoints(text: string, count: number): string {
  let out = '';
  let n = 0;
  for (const ch of text) {
    if (n >= count) break;
    out += ch;
    n++;
  }
  return out;
}

/** The notice of a paste that was cut at the limit; the limit is in code points (FRW-080 criterion 4). */
const cutNotice = (limit: number): string =>
  `The pasted text was cut at ${limit} character${limit === 1 ? '' : 's'}.`;

/** The number of pairs of UTF-16 units in `text`: code points beyond U+FFFF. */
function pairsIn(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) n++;
  }
  return n;
}

interface Refreshable {
  /**
   * Draws the view again from `doc`. With `valuesOnly`, the change was of field values and nothing
   * else (the access, the mode, the definitions and the structure are as they were), so a view
   * whose field and rule state are as it drew them has nothing to draw (FRW-023 criterion 6).
   */
  refresh(doc: PMNode, valuesOnly?: boolean): void;
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

  #textsDoc: PMNode | null = null;
  #texts: ReadonlyMap<number, StaleCache> = new Map();

  /**
   * The computed text of every `seq` and `ref` field of `doc`, by position (FE-134 criterion 3);
   * computed once for each version of the document, and only when a view asks.
   */
  textsOf(doc: PMNode): ReadonlyMap<number, StaleCache> {
    if (this.#textsDoc === doc) return this.#texts;
    this.#texts = new Map(fieldTexts(doc).map((f) => [f.pos, f]));
    this.#textsDoc = doc;
    return this.#texts;
  }

  /**
   * Draws every live view again from `doc`: after a change of the document, the access or the mode.
   * With `valuesOnly`, only the views whose field or rule state changed are drawn (see `Refreshable`).
   */
  refresh(doc: PMNode, valuesOnly = false): void {
    for (const view of this.#views) view.refresh(doc, valuesOnly);
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
  /** The visible marker of a required field (FRW-023 criterion 2). */
  readonly #marker: HTMLElement;
  /** Says that a paste was cut at the limit (a polite live region). */
  readonly #notice: HTMLElement;
  #node: PMNode;
  /** The person typed since the last submitted entry. */
  #dirty = false;
  /** The control has focus: it shows the stored value, not the formatted one. */
  #editing = false;
  /** The name of the role the field belongs to, for the description. */
  #role: string | null = null;
  /** The control's type is being changed: the focus events of that are not the person's. */
  #swapping = false;
  /** The definitions the roles were read from. */
  #defs: PMNode | null = null;
  /** What the last draw used; null before the first. */
  #drawn: {
    readonly node: PMNode;
    readonly rule: FieldRuleState | null;
    readonly defs: PMNode | null;
  } | null = null;

  constructor(node: PMNode, doc: PMNode, port: FormFieldPort, views: FormFieldViews) {
    this.#node = node;
    this.#role = this.#roleIn(doc);
    this.#defs = doc.firstChild;
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
    const notice = document.createElement('span');
    notice.className = 'de-form-field-notice';
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    this.#notice = notice;
    const marker = document.createElement('span');
    marker.className = 'de-form-field-required';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = '*';
    marker.hidden = true;
    this.#marker = marker;
    dom.append(this.#control, marker, message, notice);
    this.#box(dom, message, notice);
    marker.style.position = 'absolute';
    marker.style.right = '0.1em';
    marker.style.top = '0';
    marker.style.pointerEvents = 'none';

    this.#control.addEventListener('paste', this.#pasted);
    this.#control.addEventListener('input', this.#typed);
    this.#control.addEventListener('change', this.#changed);
    this.#control.addEventListener('focus', this.#focused);
    this.#control.addEventListener('blur', this.#blurred);
    views.add(this);
    this.#draw();
  }

  /**
   * The field's box (12 §3.2; FRW-080): as wide as its `width`, or the default of its kind, whatever
   * the control holds, and no wider. The control fills the box and cannot grow it. The messages are
   * taken out of the flow, so a problem or a notice moves no line of the text around the field.
   * Set through the style object, which a content security policy does not restrict.
   */
  #box(dom: HTMLElement, ...floating: HTMLElement[]): void {
    const kind = String(this.#node.attrs['kind']);
    const twips = fieldWidth(kind, this.#node.attrs['width']);
    dom.style.display = 'inline-block';
    dom.style.position = 'relative';
    dom.style.verticalAlign = 'baseline';
    dom.style.boxSizing = 'border-box';
    dom.style.width = `${twips / 20}pt`;
    dom.style.maxWidth = 'none';
    this.#control.style.boxSizing = 'border-box';
    this.#control.style.width = '100%';
    this.#control.style.maxWidth = '100%';
    for (const el of floating) {
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.top = '100%';
      el.style.zIndex = '1';
      el.style.width = 'max-content';
      el.style.maxWidth = '24em';
      el.style.font = 'inherit';
      el.style.fontSize = '0.85em';
      el.style.background = 'Canvas';
      el.style.color = 'CanvasText';
      el.style.border = '1px solid currentColor';
      el.style.padding = '0 0.25em';
    }
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

  #roleIn(doc: PMNode): string | null {
    const assignee = this.#node.attrs['assignee'];
    return typeof assignee === 'string' ? (rolesOf(doc).get(assignee)?.name ?? null) : null;
  }

  readonly #typed = (): void => {
    const kind = String(this.#node.attrs['kind']);
    if (kind !== 'text' && kind !== 'number') return;
    if (!this.#port.fillable(this.#id)) return this.#draw();
    this.#clearNotice();
    this.#dirty = true;
    this.#limitLength();
    this.#showProblems(this.#port.check(this.#id, this.#entry()));
  };

  /** The limit of a text field's entry, in code points; null when it has none or is not text. */
  #limit(): number | null {
    const limit = (this.#node.attrs['validation'] as { maxLength?: unknown } | null)?.maxLength;
    return this.#node.attrs['kind'] === 'text' && typeof limit === 'number' ? limit : null;
  }

  /**
   * A paste into a text field with a `maxLength` is set by this code and not by the browser, which
   * counts UTF-16 units: what fits is kept, the rest is cut, and a live region says so (FRW-080
   * criterion 4). A paste that fits is set the same way, so one rule counts both. Line breaks in
   * the pasted text become spaces, as a single-line control would have them.
   */
  readonly #pasted = (e: Event): void => {
    const event = e as ClipboardEvent;
    const c = this.#control;
    const limit = this.#limit();
    if (limit === null || !(c instanceof HTMLInputElement) || c.readOnly) return;
    if (!this.#port.fillable(this.#id)) return;
    const pasted = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n|[\r\n]/g, ' ');
    event.preventDefault();
    const start = c.selectionStart ?? c.value.length;
    const end = c.selectionEnd ?? start;
    const kept = c.value.slice(0, start) + c.value.slice(end);
    const room = Math.max(0, limit - codePointsIn(kept));
    const inserted = firstCodePoints(pasted, room);
    if (inserted !== '') {
      // `setRangeText` does not apply `maxlength`, and the control then reports an input.
      c.setRangeText(inserted, start, end, 'end');
      c.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (codePointsIn(inserted) < codePointsIn(pasted)) this.#say(cutNotice(limit));
  };

  /** Shows a notice in the field's live region; the next entry or leaving the field clears it. */
  #say(text: string): void {
    this.#notice.hidden = false;
    this.#notice.textContent = '';
    this.#notice.textContent = text;
  }

  #clearNotice(): void {
    if (this.#notice.hidden) return;
    this.#notice.textContent = '';
    this.#notice.hidden = true;
  }

  readonly #focused = (): void => {
    if (this.#swapping) return;
    this.#editing = true;
    this.#draw();
    this.#port.focused?.(this.#id);
  };

  readonly #blurred = (): void => {
    if (this.#swapping) return;
    this.#editing = false;
    this.#clearNotice();
    // A paste set by `#pasted` is not an edit by the person for the control: it reports no change of
    // its own, so the entry is submitted here. After typing, the control reported it before this.
    if (this.#dirty) return this.#changed();
    this.#draw();
  };

  /**
   * The control stops at the `maxLength` of the field. The browser counts UTF-16 units and the
   * limit counts code points (03 §11), so the allowance grows by one for each pair in the entry.
   */
  #limitLength(): void {
    const c = this.#control;
    if (!(c instanceof HTMLInputElement) || c.type === 'checkbox') return;
    const limit = (this.#node.attrs['validation'] as { maxLength?: unknown } | null)?.maxLength;
    if (this.#node.attrs['kind'] !== 'text' || typeof limit !== 'number') {
      c.removeAttribute('maxlength');
      return;
    }
    c.maxLength = limit + pairsIn(c.value);
  }

  /** Changes the type of an input, and keeps the focus it had: some engines drop it on the change. */
  #setType(c: HTMLInputElement, type: string): void {
    if (c.type === type) return;
    const root = c.getRootNode() as Document | ShadowRoot;
    const focused = root.activeElement === c;
    this.#swapping = true;
    try {
      c.type = type;
      if (focused && root.activeElement !== c) c.focus({ preventScroll: true });
    } finally {
      this.#swapping = false;
    }
  }

  /** What the control is described by: its kind, its role, and the message of its problem. */
  #describe(message: string): string {
    const kind = KIND_NAMES[String(this.#node.attrs['kind'])] ?? 'Field';
    const info = this.#role === null ? kind : `${kind} for ${this.#role}`;
    return message === '' ? info : `${info}. ${message}`;
  }

  readonly #changed = (): void => {
    this.#dirty = false;
    if (this.#port.fillable(this.#id)) this.#port.enter(this.#id, this.#entry());
    this.#draw();
  };

  #showProblems(problems: ReadonlyArray<{ readonly message: string }>): void {
    const c = this.#control;
    if (problems.length === 0) {
      c.removeAttribute('aria-invalid');
      c.setAttribute('aria-description', this.#describe(''));
      this.#message.textContent = '';
      this.#message.hidden = true;
      return;
    }
    const text = problems.map((p) => p.message).join('; ');
    c.setAttribute('aria-invalid', 'true');
    // The description is text, not a reference to the message's id: no ID reference is set from
    // script (FE-108 criterion 2). It ends with the message's text.
    c.setAttribute('aria-description', this.#describe(text));
    this.#message.textContent = text;
    this.#message.hidden = false;
  }

  /** Draws the control from what the core says the field shows, and notes what it drew from. */
  #draw(): void {
    this.#paint();
    this.#drawn = {
      node: this.#node,
      rule: this.#port.rules?.(this.#id) ?? null,
      defs: this.#defs,
    };
  }

  #paint(): void {
    const node = this.#node;
    const c = this.#control;
    const state = this.#port.entry(this.#id);
    const label = node.attrs['label'];
    c.setAttribute(
      'aria-label',
      typeof label === 'string' && label !== '' ? label : String(node.attrs['key']),
    );
    // The rules decide what is required now, hidden or shown (FRW-023); without any, the field says.
    const rule = this.#port.rules?.(this.#id) ?? null;
    const required = rule === null ? node.attrs['required'] === true : rule.required;
    if (required) c.setAttribute('aria-required', 'true');
    else c.removeAttribute('aria-required');
    this.#marker.hidden = !required;
    // A hidden field is neither drawn nor reachable by keyboard (FRW-023 criterion 1).
    const hidden = rule !== null && !rule.visible;
    this.dom.style.display = hidden ? 'none' : 'inline-block';
    if (hidden) this.dom.setAttribute('data-hidden', 'true');
    else this.dom.removeAttribute('data-hidden');
    this.dom.toggleAttribute('data-required', required);

    const fillable = this.#port.fillable(this.#id);
    if (c instanceof HTMLSelectElement || c.type === 'checkbox') c.disabled = !fillable;
    else c.readOnly = !fillable;
    // Tab walks through the fields a person may fill, in document order (FRW-076 criterion 3). A
    // field of another role is still read by a screen reader, which does not need the tab stop.
    if (fillable) c.removeAttribute('tabindex');
    else c.tabIndex = -1;

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
    // The messages of the `validate` effects that fail are problems of the field too, and are
    // announced like the entry's own (FRW-023 criterion 3).
    const problems = [
      ...(state ? state.problems : []),
      ...(rule?.messages ?? []).map((message) => ({ message })),
    ];
    // A computed field shows what the rules compute, and nothing can be entered in it (criterion 4).
    if (String(node.attrs['kind']) === 'formula' && c instanceof HTMLInputElement) {
      c.readOnly = true;
      c.tabIndex = -1;
      c.value = rule?.value ?? (typeof value === 'string' ? value : '');
      this.#showProblems(problems);
      return;
    }
    // The format changes the display only, and only while nobody edits a clean value (criterion 4).
    const shown =
      this.#editing || problems.length > 0
        ? null
        : formatFieldValue(
            String(node.attrs['kind']),
            value,
            node.attrs['format'] as FieldFormat | null,
          );
    // A native date control shows no pattern, so a pattern is shown in a text control until the
    // person edits the date.
    if (c instanceof HTMLInputElement && String(node.attrs['kind']) === 'date')
      this.#setType(c, shown === null ? 'date' : 'text');
    if (c instanceof HTMLInputElement && c.type === 'checkbox') c.checked = value === true;
    else c.value = shown ?? (typeof value === 'string' ? value : '');
    this.#limitLength();
    this.#showProblems(problems);
  }

  refresh(doc: PMNode, valuesOnly = false): void {
    // What a draw reads that a change of values can change: the node, and what the rules say of it.
    // The access, the mode, the roles and the structure are the same, as `valuesOnly` says.
    if (
      valuesOnly &&
      !this.#dirty &&
      this.#drawn !== null &&
      this.#drawn.node === this.#node &&
      this.#drawn.rule === (this.#port.rules?.(this.#id) ?? null) &&
      this.#drawn.defs === doc.firstChild
    )
      return;
    this.#role = this.#roleIn(doc);
    this.#defs = doc.firstChild;
    this.#draw();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.#node.type) return false;
    if (node.attrs['kind'] !== this.#node.attrs['kind']) return false;
    if (node.attrs['id'] !== this.#node.attrs['id']) return false;
    if (isRedactionMarker(node.attrs['value'] as JsonValue | undefined)) return false;
    this.#node = node;
    this.dom.style.width = `${fieldWidth(node.attrs['kind'], node.attrs['width']) / 20}pt`;
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
    this.#control.removeEventListener('paste', this.#pasted);
    this.#control.removeEventListener('input', this.#typed);
    this.#control.removeEventListener('change', this.#changed);
    this.#control.removeEventListener('focus', this.#focused);
    this.#control.removeEventListener('blur', this.#blurred);
  }
}

/** Whether a stored signature value is set: `{ asset, mode }` (12 §3.3). */
function isSigned(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { asset?: unknown }).asset === 'string'
  );
}

/**
 * A signature or initials field (FRW-046 criterion 1): a button. Activating it, by click or by
 * Enter or Space, asks the shell to open the adoption and signing step. The state is a word on the
 * button ("Sign here", "Signed", "Not yet your turn"), never colour alone. A field that is signed, or
 * that the person may not sign, is not a tab stop; the shell shows the signature image itself.
 */
class SignFieldView implements NodeView, Refreshable {
  readonly dom: HTMLElement;
  readonly #button: HTMLButtonElement;
  readonly #port: FormFieldPort;
  readonly #views: FormFieldViews;
  #node: PMNode;

  constructor(node: PMNode, port: FormFieldPort, views: FormFieldViews) {
    this.#node = node;
    this.#port = port;
    this.#views = views;
    const dom = document.createElement('span');
    dom.className = 'de-form-field de-sign-field';
    dom.setAttribute('data-kind', String(node.attrs['kind']));
    dom.setAttribute('data-field', String(node.attrs['id']));
    dom.contentEditable = 'false';
    dom.style.display = 'inline-block';
    dom.style.verticalAlign = 'baseline';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'de-sign-button';
    button.style.font = 'inherit';
    button.style.border = '1px solid currentColor';
    button.style.padding = '0 0.4em';
    button.addEventListener('click', this.#clicked);
    dom.append(button);
    this.dom = dom;
    this.#button = button;
    views.add(this);
    this.#draw();
  }

  readonly #clicked = (): void => {
    if (isSigned(this.#node.attrs['value'])) return;
    this.#port.signRequest?.(String(this.#node.attrs['id']));
  };

  #draw(): void {
    const node = this.#node;
    const kind = String(node.attrs['kind']);
    const noun = kind === 'initials' ? 'initials' : 'signature';
    const label = node.attrs['label'];
    const named = typeof label === 'string' && label !== '' ? label : String(node.attrs['key']);
    const signed = isSigned(node.attrs['value']);
    const signable = !signed && (this.#port.signable?.(String(node.attrs['id'])) ?? false);
    const word = signed ? 'Signed' : signable ? `Sign ${noun}` : 'Not signed';
    this.#button.textContent = word;
    this.#button.setAttribute('aria-label', `${named}: ${word.toLowerCase()}`);
    this.#button.disabled = !signable;
    this.dom.toggleAttribute('data-signed', signed);
    if (signed) this.#button.setAttribute('aria-disabled', 'true');
    else this.#button.removeAttribute('aria-disabled');
  }

  refresh(): void {
    this.#draw();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.#node.type) return false;
    if (node.attrs['kind'] !== this.#node.attrs['kind']) return false;
    if (node.attrs['id'] !== this.#node.attrs['id']) return false;
    this.#node = node;
    this.#draw();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.dom.contains(event.target);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.#views.remove(this);
    this.#button.removeEventListener('click', this.#clicked);
  }
}

/** The node view of a `form_field`: a native control for the kinds a person fills by hand. */
export function formFieldView(port: FormFieldPort, views: FormFieldViews): NodeViewConstructor {
  return (node, view) => {
    const kind = String(node.attrs['kind']);
    if (
      (kind === 'signature' || kind === 'initials') &&
      typeof node.attrs['id'] === 'string' &&
      port.signRequest !== undefined &&
      !isRedactionMarker(node.attrs['value'] as JsonValue | undefined)
    )
      return new SignFieldView(node, port, views);
    const drawn =
      CONTROL_KINDS.has(String(node.attrs['kind'])) &&
      typeof node.attrs['id'] === 'string' &&
      !isRedactionMarker(node.attrs['value'] as JsonValue | undefined);
    return drawn ? new FormFieldView(node, view.state.doc, port, views) : { dom: schemaDOM(node) };
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

/**
 * The node view of a `field`: a mirror for `formValue`, the computed text for `seq` and `ref`
 * (FE-134 criterion 3), the schema's drawing for the others.
 */
export function fieldView(views: FormFieldViews): NodeViewConstructor {
  const computed = computedFieldView(views, schemaDOM);
  return (node, view, getPos, decorations, innerDecorations) => {
    const kind = node.attrs['kind'];
    if (kind === 'formValue') return new MirrorView(node, view.state.doc, views);
    if (kind === 'seq' || kind === 'ref')
      return computed(node, view, getPos, decorations, innerDecorations);
    return { dom: schemaDOM(node) };
  };
}
