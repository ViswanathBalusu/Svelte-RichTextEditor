/**
 * Fill mode over the core (12 §10, §11; FRW-070, FRW-078): the summary the shell's guided bar and
 * its fill pane read, and the two events of the embedding API that report filling.
 *
 * - `fillView` is the shell's `CoreApi.fill`: null outside the fill mode, else every form field of
 *   the document in order with the state of its entry, and the roles this participant holds. It
 *   holds no value. It is read again when the core's revision, mode or access moves and replaced
 *   only when it differs. A field that did not change keeps its object, and the comparison is field
 *   by field, so a change of one value in a document of 2,000 fields costs one field (FRW-023
 *   criterion 6).
 * - `de-field-change` is raised for each entry this person submitted that changed what a field
 *   shows, with `{ fieldId, key, valid, empty }`. The detail is built here from those four
 *   members, so no value can travel in it.
 * - `de-fill-progress` carries what the bar shows, computed by the bar's own function
 *   (`fillProgress` of `@docedit/ui`): the required fields of this participant that are filled and
 *   valid, and how many they must fill. It is raised when the bar first shows a count and then
 *   whenever the count changes.
 *
 * `FillEvents` touches no DOM, so its logic runs in Node.js tests.
 */
import type { FillSummary } from '@docedit/ui';
// The counting module alone, without the shell's components, so this file runs in Node.js too.
import { fillProgress } from '@docedit/ui/fill';
import type { FieldChangeDetail, FillProgressDetail } from './events.ts';

interface View<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

/** A form field without its value, as the core's `fillFields()` lists it. */
export interface FillFieldSource {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly filled: boolean;
  readonly invalid: string | null;
  readonly assignee: string | null;
  readonly role: { readonly name: string; readonly color: string; readonly order: number } | null;
}

/** What the fill view reads from the core. */
export interface FillSource {
  readonly revision: View<number>;
  readonly mode: View<{ readonly effective: string }>;
  readonly permissions: View<{
    readonly fill: { readonly roles: readonly string[]; readonly active: boolean } | null;
  } | null>;
  fillFields(): readonly FillFieldSource[];
}

/** The shell's fill summary over the core: null outside the fill mode. */
export function fillView(
  core: FillSource,
  workflow?: View<{ readonly participant?: { readonly state: string } | undefined } | null>,
): View<FillSummary | null> {
  type Field = FillSummary['fields'][number];
  let last: FillSummary | null = null;
  /** The list the core gave last, and the fields made from it. */
  let lastSource: readonly FillFieldSource[] | null = null;
  let lastFields: readonly Field[] = [];
  /** The copy made of each field the core listed; a field the core lists again keeps its copy. */
  const copies = new WeakMap<FillFieldSource, Field>();
  // Copied member by member: whatever else the core's object holds, a value above all, stays behind.
  const copyOf = (f: FillFieldSource): Field => {
    let copy = copies.get(f);
    if (copy === undefined) {
      copy = {
        id: f.id,
        label: f.label,
        required: f.required,
        filled: f.filled,
        invalid: f.invalid,
        assignee: f.assignee,
        role: f.role ? { name: f.role.name, color: f.role.color, order: f.role.order } : null,
      };
      copies.set(f, copy);
    }
    return copy;
  };
  const sameField = (a: Field, b: Field): boolean =>
    a === b || JSON.stringify(a) === JSON.stringify(b);
  const read = (): FillSummary | null => {
    if (core.mode.get().effective !== 'fill') {
      last = null;
      return null;
    }
    const fill = core.permissions.get()?.fill ?? null;
    const active = fill?.active ?? false;
    // Why the participant may not fill: the server's own word for them (`wf.changed`, FRW-035),
    // `paused` while the owner corrects, `unverified` until the access code is right (FRW-039);
    // every other reason reads as waiting.
    const own = workflow?.get()?.participant?.state;
    const inactive = own === 'paused' ? 'paused' : own === 'unverified' ? 'unverified' : 'waiting';
    const roles = fill?.roles ?? [];
    // The fields are compared with the last ones field by field, and a field the core lists again
    // unchanged is the same object, so a change of one value compares one field and copies one
    // (FRW-023 criterion 6: the core keeps its list while nothing changes it).
    const source = core.fillFields();
    if (source !== lastSource) {
      const next = source.map(copyOf);
      const same =
        next.length === lastFields.length && next.every((f, i) => sameField(f, lastFields[i]!));
      lastSource = source;
      if (!same) lastFields = next;
    }
    const fields = lastFields;
    if (
      last !== null &&
      last.fields === fields &&
      last.active === active &&
      (active || last.inactive === inactive) &&
      last.roles !== undefined &&
      last.roles.length === roles.length &&
      last.roles.every((r, i) => r === roles[i])
    )
      return last;
    last = { active, ...(active ? {} : { inactive }), roles: [...roles], fields };
    return last;
  };
  return {
    get: read,
    subscribe(listener) {
      const stops = [
        core.revision.subscribe(listener),
        core.mode.subscribe(listener),
        core.permissions.subscribe(listener),
        ...(workflow ? [workflow.subscribe(listener)] : []),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

/** The progress the guided bar shows for `summary`; null where the bar shows no count. */
export function progressDetail(summary: FillSummary | null): FillProgressDetail | null {
  if (!summary || !summary.active) return null;
  const progress = fillProgress(summary);
  return { filled: progress.done, total: progress.total };
}

/** What the reporter reads from the editor. */
export interface FillWatch {
  /** Calls the listener after each entry this person submitted; returns the function that stops it. */
  onFieldChange(listener: (change: FieldChangeDetail) => void): () => void;
  readonly fill: View<FillSummary | null>;
}

export interface FillRaise {
  fieldChange(detail: FieldChangeDetail): void;
  fillProgress(detail: FillProgressDetail): void;
}

export class FillEvents {
  readonly #watch: FillWatch;
  readonly #raise: FillRaise;
  #last = 'null';

  constructor(watch: FillWatch, raise: FillRaise) {
    this.#watch = watch;
    this.#raise = raise;
  }

  /** Raises the progress the bar shows now, if it shows one, then subscribes. */
  start(): () => void {
    this.check();
    const stops = [
      this.#watch.onFieldChange((change) =>
        // Copied member by member: whatever else the core's object holds stays behind.
        this.#raise.fieldChange({
          fieldId: change.fieldId,
          key: change.key,
          valid: change.valid,
          empty: change.empty,
        }),
      ),
      this.#watch.fill.subscribe(() => this.check()),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  /** Compares the progress with the last one raised; raises it when it changed. */
  check(): void {
    const now = progressDetail(this.#watch.fill.get());
    const key = JSON.stringify(now);
    if (key === this.#last) return;
    this.#last = key;
    if (now) this.#raise.fillProgress(now);
  }
}
