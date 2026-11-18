// BE-098 (ADR 0019 decision item 2): a page of stored commits as a read-restricted class receives it.
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { projectCommitPage, visibleScopes } from '../src/projection/page.ts';
import {
  type HiddenSet,
  NOTHING_HIDDEN,
  project,
  projectionSchema,
} from '../src/projection/projection.ts';
import { applySteps } from '../src/rebase.ts';
import type { StoredCommit } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { posInside, schema } from './fixtures.ts';
import { INCOME, LEGAL, SECRET_REGION, secretDoc } from './harness/projection-sim.ts';

const pschema = projectionSchema();
const hidden: HiddenSet = { regions: new Set([LEGAL]), values: new Set([INCOME]), titles: false };

function insert(at: number, text: string): Step {
  return new ReplaceStep(at, at, new Slice(Fragment.from(schema.text(text)), 0, 0));
}

/** Stored commits, each made on the document the previous one left. */
function log(start: Node, makers: Array<(d: Node) => [Step, string[]]>): StoredCommit[] {
  let doc = start;
  return makers.map((make, i) => {
    const [step, scopes] = make(doc);
    const r = applySteps(doc, [step]);
    if (!r.ok) throw new Error('fixture step does not apply');
    doc = r.value.doc;
    return {
      seq: i + 1,
      id: `c${i + 1}`,
      kind: 'steps',
      steps: stepsToJson([step]),
      user: 'u',
      session: 's',
      time: 1,
      origin: 'input',
      scopes,
      revision: 1,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: i === 1 ? [LEGAL] : [],
      claimed: [],
    };
  });
}

describe('projectCommitPage (BE-098 criterion 1)', () => {
  const start = secretDoc();
  const commits = log(start, [
    (d) => [insert(posInside(d, 'pIntro0000000001'), 'visible-1'), ['body']],
    (d) => [insert(posInside(d, 'pSecret00000001B'), SECRET_REGION), [`region:${LEGAL}`]],
    (d) => [insert(posInside(d, 'pIntro0000000001'), 'visible-2'), ['body']],
  ]);

  it('gives the class mapped steps, an empty commit for hidden-only changes and no hidden scope', () => {
    const page = projectCommitPage(schema, start, hidden, commits);
    expect(page.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(page[0]!.steps).toHaveLength(1);
    expect(page[1]!.steps).toEqual([]);
    expect(page[2]!.steps).toHaveLength(1);
    expect(page[1]!.scopes).toEqual([]);
    expect(page[1]!.retired).toEqual([]);
    expect(page[0]!.scopes).toEqual(['body']);
    expect(JSON.stringify(page)).not.toContain(SECRET_REGION);
    expect(JSON.stringify(page)).not.toContain(LEGAL);
  });

  it("applied to the class's projection before the page, the steps give its projection after it", () => {
    const page = projectCommitPage(schema, start, hidden, commits);
    let view = project(start, hidden, pschema).doc;
    for (const c of page) {
      const steps = c.steps.map((s) => ReplaceStep.fromJSON(pschema, s) as Step);
      const next = applySteps(view, steps);
      expect(next.ok).toBe(true);
      if (next.ok) view = next.value.doc;
    }
    let full = start;
    for (const c of commits) {
      const r = applySteps(
        full,
        c.steps.map((s) => ReplaceStep.fromJSON(schema, s) as Step),
      );
      if (r.ok) full = r.value.doc;
    }
    expect(view.eq(project(full, hidden, pschema).doc)).toBe(true);
  });

  it('leaves the steps of the full class as stored', () => {
    const page = projectCommitPage(schema, start, NOTHING_HIDDEN, commits);
    expect(page.map((c) => c.steps)).toEqual(commits.map((c) => c.steps));
    expect(page[1]!.scopes).toEqual([`region:${LEGAL}`]);
  });

  it('drops the scopes of hidden regions and hidden fields only', () => {
    expect(
      visibleScopes(
        ['body', `region:${LEGAL}`, 'region:rOther', `field:${INCOME}`, 'field:x'],
        hidden,
      ),
    ).toEqual(['body', 'region:rOther', 'field:x']);
  });
});
