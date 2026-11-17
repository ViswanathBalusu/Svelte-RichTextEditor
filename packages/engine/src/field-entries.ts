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

/** The form field with `id` in `doc`, with its position. */
export function findFormField(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
  let hit: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.type.name === 'form_field' && node.attrs['id'] === id) hit = { node, pos };
    return !hit;
  });
  return hit;
}

export class FieldEntries {
  readonly #host: FieldEntryHost;
  readonly #kept = new Map<string, Kept>();

  constructor(host: FieldEntryHost) {
    this.#host = host;
  }

  /** The kept entry of a field, dropped once someone else changed the stored value. */
  #keptFor(id: string, stored: JsonValue): Kept | null {
    const kept = this.#kept.get(id);
    if (!kept) return null;
    if (sameJson(stored, kept.value) || sameJson(stored, kept.base)) return kept;
    this.#kept.delete(id);
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
    const base = this.#keptFor(id, before)?.base ?? before;
    if (!sameJson(before, value)) {
      this.#host.dispatch(state.tr.setNodeAttribute(hit.pos, 'value', value));
      const after = findFormField(this.#host.state().doc, id);
      if (!after || !sameJson(storedValue(after.node), value))
        return { ok: false, reason: 'refused' };
    }
    const problems = checkEntry(info, value);
    if (problems.length > 0) this.#kept.set(id, { value, base });
    else this.#kept.delete(id);
    return { ok: true, problems };
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
    this.#host.state().doc.descendants((node) => {
      if (node.type.name !== 'form_field') return true;
      const info = infoOf(node);
      if (!info || seen.has(info.key)) return false;
      seen.add(info.key);
      fields.push(info);
      const stored = storedValue(node);
      const kept = typeof info.id === 'string' ? this.#keptFor(info.id, stored) : null;
      values[info.key] = kept ? kept.value : stored;
      return false;
    });
    return validateFields(fields, values);
  }
}
