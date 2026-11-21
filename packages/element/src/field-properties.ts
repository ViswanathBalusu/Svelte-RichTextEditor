/**
 * The shell's field properties port over the core (FRW-073; ui `FieldPropertiesService`): the
 * form fields of the document, the one the person selected, the properties of a field as the
 * panel edits them, and the change of them. A change is the core's `editField`, one transaction
 * of attribute changes, so the region guard decides and the change leaves as one commit.
 *
 * The panel's draft and the CDM differ in three places, converted here:
 * - `width` is points in the panel and twips in the document (03 §4.4);
 * - `default` is text in the panel and a value typed by the field's kind in the document: a
 *   checkbox takes `true` or `false`, the other kinds take the text;
 * - an empty list of options is `null` in the document.
 */
import type { EditorCore } from '@docedit/engine';
import { loadParts } from '@docedit/engine/headless';
import type { FieldChangeResult, FieldDraft, FieldPropertiesService } from '@docedit/ui';

type Patch = Parameters<EditorCore['editField']>[1];
type Properties = NonNullable<ReturnType<EditorCore['fieldProperties']>>;
type Json = Patch[keyof Patch];

const TWIPS_PER_POINT = 20;

function draftOf(p: Properties): FieldDraft {
  const text = (v: unknown): string | null =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);
  const object = (v: unknown): Readonly<Record<string, unknown>> | null =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const options = Array.isArray(p.options)
    ? (p.options as Array<{ id?: unknown; label?: unknown }>).map((o) => ({
        id: String(o.id ?? ''),
        label: String(o.label ?? ''),
      }))
    : [];
  return {
    key: String(p.key ?? ''),
    kind: String(p.kind ?? 'text'),
    label: String(p.label ?? ''),
    assignee: typeof p.assignee === 'string' ? p.assignee : null,
    required: p.required === true,
    readOnly: p.readOnly === true,
    default: text(p.default),
    placeholder: typeof p.placeholder === 'string' ? p.placeholder : null,
    options,
    format: object(p.format),
    validation: object(p.validation),
    width: typeof p.width === 'number' ? p.width / TWIPS_PER_POINT : null,
  };
}

/** The attribute changes a patch of the panel's draft stands for, for a field of `kind`. */
export function attrsOf(patch: Partial<FieldDraft>, kind: string): Patch {
  const out: Record<string, Json> = {};
  for (const [name, value] of Object.entries(patch)) {
    if (name === 'width')
      out[name] = typeof value === 'number' ? Math.round(value * TWIPS_PER_POINT) : null;
    else if (name === 'options')
      out[name] = Array.isArray(value) && value.length > 0 ? (value as Json) : null;
    else if (name === 'default') {
      if (value === null || value === '') out[name] = null;
      else if (kind === 'checkbox' && (value === 'true' || value === 'false'))
        out[name] = value === 'true';
      else out[name] = value as Json;
    } else if (name === 'assignee' || name === 'placeholder')
      out[name] = value === '' ? null : (value as Json);
    else out[name] = value as Json;
  }
  return out as Patch;
}

export function fieldPropertiesService(core: EditorCore): FieldPropertiesService {
  let last: readonly { id: string; key: string; label: string }[] = [];
  let lastKey = '[]';
  const list = (): readonly { id: string; key: string; label: string }[] => {
    const now = core.formFields();
    const key = JSON.stringify(now);
    if (key !== lastKey) {
      lastKey = key;
      last = now;
    }
    return last;
  };
  return {
    // The grammar and invariant checks of the changes load with the pane (FND-008).
    prepare: () => loadParts(['authoring']),
    fields: { get: list, subscribe: (listener) => core.revision.subscribe(listener) },
    selected: {
      get: () => core.selectedField(),
      subscribe: (listener) => core.revision.subscribe(listener),
    },
    read(id) {
      const properties = core.fieldProperties(id);
      return properties ? draftOf(properties) : null;
    },
    canChange: (id) => core.canEditField(id),
    apply(id, patch): FieldChangeResult {
      const kind = patch.kind ?? String(core.fieldProperties(id)?.kind ?? 'text');
      const outcome = core.editField(id, attrsOf(patch, kind));
      if (outcome.ok) return { ok: true };
      if (outcome.reason === 'invalid')
        return {
          ok: false,
          reason: 'invalid',
          properties: [...new Set(outcome.problems.map((p) => p.field).filter((f) => f !== ''))],
        };
      return { ok: false, reason: outcome.reason };
    },
  };
}
