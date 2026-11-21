/**
 * The shell's roles port over the core (FRW-074; ui `RolesService`): the document's roles with the
 * fields assigned to each, and the changes to them. Every change is the core's `editRole`, a
 * transaction on the definitions, so the region guard decides (`defs` needs `structure`, 07 §4) and
 * the change leaves as a commit. A new role gets an identifier no role of the document uses.
 *
 * The list is read again when the core's revision moves and only replaced when it differs, so the
 * pane does not redraw for a change elsewhere in the document.
 */
import type { EditorCore } from '@docedit/engine';
import { loadParts } from '@docedit/engine/headless';
import type { RoleChangeResult, RoleSummary, RolesService } from '@docedit/ui';

type Outcome = ReturnType<EditorCore['editRole']>;

function result(outcome: Outcome): RoleChangeResult {
  if (outcome.ok) return { ok: true };
  if (outcome.reason === 'invalid')
    return {
      ok: false,
      reason: 'invalid',
      fields: [...new Set(outcome.problems.map((p) => p.field))],
    };
  return { ok: false, reason: outcome.reason };
}

/** A colour control gives lower-case digits; the CDM's colour grammar takes upper-case ones. */
function upper<T extends { readonly color?: string }>(values: T): T {
  return values.color === undefined ? values : { ...values, color: values.color.toUpperCase() };
}

export function rolesService(core: EditorCore): RolesService {
  let last: readonly RoleSummary[] = [];
  let lastKey = '[]';
  const read = (): readonly RoleSummary[] => {
    const now: RoleSummary[] = core.roles().map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      order: r.order,
      fields: r.fields.map((f) => ({ id: f.id, label: f.label })),
    }));
    const key = JSON.stringify(now);
    if (key !== lastKey) {
      lastKey = key;
      last = now;
    }
    return last;
  };
  // A role with valid values stands for "a role": the check asks only about the definitions.
  const canChange = (): boolean => {
    const outcome = core.editRole(
      { op: 'add', id: core.nextRoleId(), values: { name: 'Role', color: '#000000' } },
      true,
    );
    return outcome.ok;
  };
  return {
    // The grammar checks of the changes load with the pane (FND-008).
    prepare: () => loadParts(['authoring']),
    list: { get: read, subscribe: (listener) => core.revision.subscribe(listener) },
    canChange: {
      get: canChange,
      subscribe(listener) {
        const stops = [core.revision.subscribe(listener), core.permissions.subscribe(listener)];
        return () => {
          for (const stop of stops) stop();
        };
      },
    },
    add: (values) =>
      result(core.editRole({ op: 'add', id: core.nextRoleId(), values: upper(values) })),
    update: (id, values) => result(core.editRole({ op: 'update', id, values: upper(values) })),
    remove: (id) => result(core.editRole({ op: 'delete', id })),
  };
}
