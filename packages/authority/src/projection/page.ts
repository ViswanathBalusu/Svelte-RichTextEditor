/**
 * A page of stored commits as one visibility class receives it (BE-098; ADR 0019 decision item 2).
 *
 * The commits resource (05 §6.2) serves a reader whose class hides content the same steps the
 * gateway would have sent over a channel: mapped steps where a commit does not touch hidden
 * content, a local diff step where it does, and none where it changed only hidden content. The
 * scopes and the retired identifiers name nothing the class may not see.
 */
import type { Node, Schema } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { applySteps } from '../rebase.ts';
import type { StoredCommit } from '../room/types.ts';
import { stepsToJson } from '../steps.ts';
import { type HiddenSet, project, projectCommit, projectionSchema } from './projection.ts';

/** The scopes a class may know about: those of hidden regions and hidden fields are dropped. */
export function visibleScopes(scopes: readonly string[], hidden: HiddenSet): string[] {
  return scopes.filter(
    (s) =>
      !(s.startsWith('region:') && hidden.regions.has(s.slice(7))) &&
      !(s.startsWith('field:') && hidden.values.has(s.slice(6))),
  );
}

/**
 * The commits of a page as the class receives them.
 *
 * @param fschema the full CDM schema the stored steps are written against
 * @param before the full document before the first commit of the page
 * @param commits consecutive stored commits after `before`; none is a snapshot commit
 * @throws when a stored step does not apply: the log is then damaged, and nothing is served
 */
export function projectCommitPage(
  fschema: Schema,
  before: Node,
  hidden: HiddenSet,
  commits: readonly StoredCommit[],
  pschema: Schema = projectionSchema(),
): StoredCommit[] {
  let full = before;
  let view = project(full, hidden, pschema);
  const out: StoredCommit[] = [];
  for (const c of commits) {
    const steps = c.steps.map((s) => Step.fromJSON(fschema, s));
    const r = projectCommit(view, full, steps, hidden, pschema);
    const applied = applySteps(full, steps);
    if (!applied.ok) throw new Error(`projectCommitPage: commit ${c.seq} does not apply`);
    full = applied.value.doc;
    view = r.view;
    out.push({
      ...c,
      steps: stepsToJson(r.steps),
      scopes: visibleScopes(c.scopes, hidden),
      retired: c.retired.filter((id) => !hidden.regions.has(id)),
    });
  }
  return out;
}
