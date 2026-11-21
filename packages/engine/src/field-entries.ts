/**
 * The entries a person types into form fields (FRW-004; 12 §3.2, §11).
 *
 * - An entry is checked by `checkEntry` of `@docedit/rules` (reached through `@docedit/authority`),
 *   the one implementation of the static checks (ADR 0030 §6): the type of the kind, then the
 *   limits and presets of `validation`.
 * - An entry is submitted as the field's `value`, one `attr` step. The region guard and then the
 *   authority decide whether it stands (12 §4.2, rule P7; FRW-008).
 * - An entry with a problem is kept after it is submitted. If the authority drops it
 *   (`field_invalid`), the stored value goes back, and the field still shows the entry and its
 *   message until the person enters something else (FRW-004 criterion 5).
 * - A kept entry ends when someone else changes the stored value.
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import {
  type EntryProblem,
  type FieldInfo,
  type FieldReport,
  checkEntry,
  fieldFrom,
  isEmptyValue,
  validateFields,
} from '@docedit/authority';
import type { JsonValue } from '@docedit/model';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { sameJson } from './read-value.ts';

/** What a field shows: the entry, the stored value and the problems of the entry. */
export interface FieldEntryState {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly label: string | null;
  readonly required: boolean;
  /** The entry the field shows: the kept entry when there is one, the stored value otherwise. */
  readonly value: JsonValue;
  /** The value of the document. */
  readonly stored: JsonValue;
  /** The static problems of the entry (`checkEntry`); `required` is reported by `validate`. */
  readonly problems: readonly EntryProblem[];
}

export type EnterResult =
  | { readonly ok: true; readonly problems: readonly EntryProblem[] }
  | { readonly ok: false; readonly reason: 'no-field' | 'refused' };

/**
 * What `de-field-change` carries (12 §10; FRW-070): which field, and the state of its entry. Never
 * the value.
 */
export interface FieldChange {
  readonly fieldId: string;
  readonly key: string;
  /** False when the entry has a problem, or the field is required and the entry is empty. */
  readonly valid: boolean;
  readonly empty: boolean;
}

/** A role as a field shows it: its name, colour and place among the document's roles. */
export interface FieldRole {
  readonly name: string;
  readonly color: string;
  readonly order: number;
}

/** A form field as fill mode lists it (12 §11; FRW-076 to FRW-078). It holds no value. */
export interface FieldStatus {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly filled: boolean;
  /** Why the entry is not valid (`format`, `range` or `other`); null for a valid or empty entry. */
  readonly invalid: 'format' | 'range' | 'other' | null;
  /** The `role_def` the field is assigned to; null for a field only authors set. */
  readonly assignee: string | null;
  readonly role: FieldRole | null;
}

const FORMAT_CODES = new Set(['type', 'pattern', 'preset', 'not_an_option']);
const RANGE_CODES = new Set(['min', 'max', 'min_length', 'max_length', 'too_large']);

function invalidReason(problems: readonly EntryProblem[]): FieldStatus['invalid'] {
  const first = problems[0];
  if (!first) return null;
  if (FORMAT_CODES.has(first.code)) return 'format';
  return RANGE_CODES.has(first.code) ? 'range' : 'other';
}

/** The roles of the document by identifier, in the order of its definitions (12 §3.1). */
export function rolesOf(doc: PMNode): Map<string, FieldRole> {
  const roles = new Map<string, FieldRole>();
  doc.firstChild?.forEach((child) => {
    if (child.type.name !== 'role_def') return;
    const { id, name, color } = child.attrs as { id?: unknown; name?: unknown; color?: unknown };
    if (typeof id !== 'string') return;
    roles.set(id, {
      name: typeof name === 'string' ? name : id,
      color: typeof color === 'string' ? color : '',
      order: roles.size,
    });
  });
  return roles;
}

export interface FieldEntryHost {
  state(): EditorState;
  dispatch(tr: Transaction): void;
}

interface Kept {
  /** The entry with a problem. */
  readonly value: JsonValue;
  /** The stored value before the entry was submitted. */
  readonly base: JsonValue;
}

const storedValue = (node: PMNode): JsonValue => (node.attrs['value'] ?? null) as JsonValue;

const infoOf = (node: PMNode): FieldInfo | null =>
  fieldFrom(node.attrs as Record<string, JsonValue>);

/** A form field of a document with its position. */
export interface FieldAt {
  readonly node: PMNode;
  readonly pos: number;
}

/** The form fields of a document: every one in document order, and the first of each identifier. */
export interface FormFields {
  readonly list: readonly FieldAt[];
  readonly byId: ReadonlyMap<string, FieldAt>;
}

const fieldIndexes = new WeakMap<PMNode, FormFields>();

/**
 * The form fields of `doc`. The document is walked once, whoever asks and however often: the
 * control of each field, the state of the entries, the rules and the fill list all read this one
 * list, so a change of the document costs one walk and not one for each reader (FRW-023 criterion 6).
 */
export function formFieldsOf(doc: PMNode): FormFields {
  let index = fieldIndexes.get(doc);
  if (index === undefined) {
    const list: FieldAt[] = [];
    const byId = new Map<string, FieldAt>();
    doc.descendants((node, pos) => {
      if (node.type.name !== 'form_field') return true;
      const at = { node, pos };
      list.push(at);
      const fieldId = node.attrs['id'];
      if (typeof fieldId === 'string' && !byId.has(fieldId)) byId.set(fieldId, at);
      return false;
    });
    fieldIndexes.set(doc, (index = { list, byId }));
  }
  return index;
}

/**
 * The form field with `id` in `doc`, with its position (the first, in document order). The fields
 * of a document are found in one walk, however many are asked for, so that drawing 2,000 fields
 * does not walk the document 2,000 times (FRW-023 criterion 6).
 */
export function findFormField(doc: PMNode, id: string): FieldAt | null {
  return formFieldsOf(doc).byId.get(id) ?? null;
}

export class FieldEntries {
  readonly #host: FieldEntryHost;
  readonly #kept = new Map<string, Kept>();
  /** Counts the changes of the kept entries, so that a list made from them knows when it is old. */
  #keptVersion = 0;
  readonly #listeners = new Set<(change: FieldChange) => void>();
  /**
   * The status of a field as it was last computed from its node alone (no kept entry), with the
   * definitions its role was read from. A node the document still holds keeps its status.
   */
  readonly #statusOf = new WeakMap<PMNode, { defs: PMNode | null; status: FieldStatus }>();
  /** The last list `status()` made, and what it was made from. */
  #statusList: { doc: PMNode; kept: number; out: readonly FieldStatus[] } | null = null;

  constructor(host: FieldEntryHost) {
    this.#host = host;
  }

  /** Forgets every kept entry: what the fields show is what they store (the end of a preview, FRW-075). */
  clear(): void {
    if (this.#kept.size === 0) return;
    this.#kept.clear();
    this.#keptVersion++;
  }

  #keep(id: string, entry: Kept): void {
    this.#kept.set(id, entry);
    this.#keptVersion++;
  }

  #unkeep(id: string): void {
    if (this.#kept.delete(id)) this.#keptVersion++;
  }

  /** The kept entry of a field, dropped once someone else changed the stored value. */
  #keptFor(id: string, stored: JsonValue): Kept | null {
    const kept = this.#kept.get(id);
    if (!kept) return null;
    if (sameJson(stored, kept.value) || sameJson(stored, kept.base)) return kept;
    this.#unkeep(id);
    return null;
  }

  /** The problems of `value` as an entry of the field `id` (the checks made while typing). */
  check(id: string, value: JsonValue): readonly EntryProblem[] {
    const hit = findFormField(this.#host.state().doc, id);
    const info = hit ? infoOf(hit.node) : null;
    return info ? checkEntry(info, value) : [];
  }

  /** What the field `id` shows now, or null when the document has no such field. */
  entry(id: string): FieldEntryState | null {
    const hit = findFormField(this.#host.state().doc, id);
    const info = hit ? infoOf(hit.node) : null;
    if (!hit || !info) return null;
    const stored = storedValue(hit.node);
    const kept = this.#keptFor(id, stored);
    const value = kept ? kept.value : stored;
    const label = hit.node.attrs['label'];
    return {
      id,
      key: info.key,
      kind: info.kind,
      label: typeof label === 'string' && label !== '' ? label : null,
      required: info.required === true,
      value,
      stored,
      problems: checkEntry(info, value),
    };
  }

  /**
   * A transaction that changes the value of the field `id`, for asking the guard whether the
   * person may fill the field. Null when the document has no such field.
   */
  probe(id: string): Transaction | null {
    const state = this.#host.state();
    const hit = findFormField(state.doc, id);
    if (!hit) return null;
    const other: JsonValue = storedValue(hit.node) === null ? '' : null;
    return state.tr.setNodeAttribute(hit.pos, 'value', other);
  }

  /**
   * Submits `value` as the entry of the field `id`: one `attr` step on `value`. An entry with a
   * problem is submitted too, and kept, so that the field shows it until it changes.
   */
  enter(id: string, value: JsonValue): EnterResult {
    const state = this.#host.state();
    const hit = findFormField(state.doc, id);
    const info = hit ? infoOf(hit.node) : null;
    if (!hit || !info) return { ok: false, reason: 'no-field' };
    const before = storedValue(hit.node);
    const keptBefore = this.#keptFor(id, before);
    const base = keptBefore?.base ?? before;
    const shown = keptBefore ? keptBefore.value : before;
    if (!sameJson(before, value)) {
      this.#host.dispatch(state.tr.setNodeAttribute(hit.pos, 'value', value));
      const after = findFormField(this.#host.state().doc, id);
      if (!after || !sameJson(storedValue(after.node), value))
        return { ok: false, reason: 'refused' };
    }
    const problems = checkEntry(info, value);
    if (problems.length > 0) this.#keep(id, { value, base });
    else this.#unkeep(id);
    if (!sameJson(shown, value)) {
      const empty = isEmptyValue(info, value);
      const change: FieldChange = {
        fieldId: id,
        key: info.key,
        valid: problems.length === 0 && !(info.required === true && empty),
        empty,
      };
      for (const listener of [...this.#listeners]) listener(change);
    }
    return { ok: true, problems };
  }

  /**
   * Calls `listener` after each entry this person submitted that changed what the field shows
   * (FRW-070). A change that arrives from someone else is not reported here. Returns the function
   * that stops it.
   */
  onChange(listener: (change: FieldChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Every form field in document order with the state of its entry and its role; no value.
   *
   * The list is the same object until the document or a kept entry changes, and the status of a
   * field is the same object while its node, the definitions and its entry are as they were. So a
   * reader can tell what changed by identity, and a change of one value checks one entry and not
   * 2,000 (FRW-023 criterion 6). The list and its members are not to be changed by the caller.
   */
  status(): readonly FieldStatus[] {
    const doc = this.#host.state().doc;
    const last = this.#statusList;
    if (last !== null && last.doc === doc && last.kept === this.#keptVersion) return last.out;
    const defs = doc.firstChild;
    let roles: Map<string, FieldRole> | null = null;
    const out: FieldStatus[] = [];
    for (const { node } of formFieldsOf(doc).list) {
      const id = node.attrs['id'];
      if (typeof id !== 'string') continue;
      const stored = storedValue(node);
      const kept = this.#kept.has(id) ? this.#keptFor(id, stored) : null;
      if (kept === null) {
        // The node says everything: its attributes, and its role from the same definitions.
        const known = this.#statusOf.get(node);
        if (known !== undefined && known.defs === defs) {
          out.push(known.status);
          continue;
        }
      }
      const info = infoOf(node);
      if (!info) continue;
      const value = kept ? kept.value : stored;
      const label = node.attrs['label'];
      const assignee = node.attrs['assignee'];
      roles ??= rolesOf(doc);
      const status: FieldStatus = {
        id,
        key: info.key,
        label: typeof label === 'string' && label !== '' ? label : info.key,
        required: info.required === true,
        filled: !isEmptyValue(info, value),
        invalid: invalidReason(checkEntry(info, value)),
        assignee: typeof assignee === 'string' && assignee !== '' ? assignee : null,
        role: typeof assignee === 'string' ? (roles.get(assignee) ?? null) : null,
      };
      if (kept === null) this.#statusOf.set(node, { defs, status });
      out.push(status);
    }
    // A kept entry that ended while the list was made is already counted in the version.
    this.#statusList = { doc, kept: this.#keptVersion, out };
    return out;
  }

  /**
   * `validateFields()` (12 §10): every field that is required and empty or whose entry has a
   * problem, in document order. The entries are what the fields show, so an entry the authority
   * dropped is still reported.
   */
  validate(): FieldReport[] {
    const fields: FieldInfo[] = [];
    const values: Record<string, JsonValue> = {};
    const seen = new Set<string>();
    for (const { node } of formFieldsOf(this.#host.state().doc).list) {
      const info = infoOf(node);
      if (!info || seen.has(info.key)) continue;
      seen.add(info.key);
      fields.push(info);
      const stored = storedValue(node);
      const kept = typeof info.id === 'string' ? this.#keptFor(info.id, stored) : null;
      values[info.key] = kept ? kept.value : stored;
    }
    return validateFields(fields, values);
  }
}
