/**
 * The shell's sources port over the core (UX-103; ui `SourcesService`): the document's sources with
 * where each is cited, and the changes to them. Every change is the core's `editSource`, a
 * transaction on the definitions, so the region guard decides (`defs` needs `structure`, 07 §4) and
 * the change leaves as a commit. Citing is the core's `insertCitation` at the caret.
 *
 * The list is read again when the core's revision moves and only replaced when it differs, so the
 * pane does not redraw for a change elsewhere in the document.
 */
import type { EditorCore } from '@docedit/engine';
import { loadParts } from '@docedit/engine/headless';
import type { SourceChangeResult, SourceSummary, SourceValues, SourcesService } from '@docedit/ui';

type Edit = Parameters<EditorCore['editSource']>[0];
type Outcome = ReturnType<EditorCore['editSource']>;
type Values = Extract<Edit, { op: 'add' }>['values'];

function result(outcome: Outcome): SourceChangeResult {
  if (outcome.ok) return { ok: true };
  if (outcome.reason === 'invalid')
    return {
      ok: false,
      reason: 'invalid',
      fields: [...new Set(outcome.problems.map((p) => p.field))],
    };
  return { ok: false, reason: outcome.reason };
}

export function sourcesService(core: EditorCore): SourcesService {
  let last: readonly SourceSummary[] = [];
  let lastKey = '[]';
  const read = (): readonly SourceSummary[] => {
    const now: SourceSummary[] = core.sources().map((s) => ({
      id: s.id,
      values: s.values as SourceValues,
      citedAt: s.citedAt.map((c) => ({ excerpt: c.excerpt })),
    }));
    const key = JSON.stringify(now);
    if (key !== lastKey) {
      lastKey = key;
      last = now;
    }
    return last;
  };
  // Any source the document has stands for "a source": the check asks only about the definitions.
  const probe: Edit = { op: 'add', id: 'probe', values: {} };
  const canChange = (): boolean => {
    const outcome = core.editSource(probe, true);
    return outcome.ok || outcome.reason !== 'read-only';
  };
  const first = (): string | undefined => core.sources()[0]?.id;
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
    check(id, values) {
      const outcome = core.editSource(
        { op: 'add', id: id ?? 'probe', values: values as Values },
        true,
      );
      if (outcome.ok || outcome.reason !== 'invalid') return [];
      return [...new Set(outcome.problems.map((p) => p.field))];
    },
    add: (id, values) => result(core.editSource({ op: 'add', id, values: values as Values })),
    update: (id, values) => result(core.editSource({ op: 'update', id, values: values as Values })),
    remove: (id) => result(core.editSource({ op: 'delete', id })),
    canCite() {
      const source = first();
      if (source === undefined) return false;
      return core.queryCommand('insertCitation', { citation: { items: [{ source }] } }).enabled;
    },
    cite: (id) => core.run('insertCitation', { citation: { items: [{ source: id }] } }),
  };
}
