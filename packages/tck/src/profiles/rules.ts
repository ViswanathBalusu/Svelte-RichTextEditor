/**
 * The `rules` profile (FRW-020; 12 §5, §10; 05 §9, §11). It maps to the feature `rules`. Every
 * `rules` case of the published fixtures (`spec/rules/rules-1.fixtures.json`, the kit's copy) is one
 * scenario named by the fixture's identifier, so a report lists each failing fixture by identifier.
 *
 * The shape is the one ADR 0340 (round 7, proposed, accepted with the workflow design ADRs by owner
 * decision 184) proposes: the case's rules are put in the definitions of a document and the verdict
 * is read through DEP, as the `fields` profile does.
 *
 * - A case that gives field states: the document is created with the case's fields, roles and rules.
 *   For each fillable field the case judges, a fill-only participant with the case's roles (the `wfr`
 *   claim, 05 §3.1) submits a value. The fill is accepted when the case says the field is visible and
 *   enabled, and refused with `permission_denied` otherwise, naming the rule the case names (12
 *   §5.3). A fresh document is made for each field, so one fill never changes the state another is
 *   judged on.
 * - A negative case (a rule set with problems): the owner submits the rules to a valid document and
 *   the commit is refused with `invalid_op`, whatever the problem (owner decision 185).
 *
 * What DEP does not show is not judged here: the values of formulas, validation messages and
 * required flags have no observable effect on a fill, and a case with an instant (`given.now`) needs
 * the server's clock. The authority service's `evaluateRules` shows those (profile
 * `authority-service`, scenario `evaluate-rules`); the expression, pattern and value cases have no
 * call over DEP and run in the rules package in Node.js and in the browsers.
 */
import { KitFailure, check, equal } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { contractDocument, posBefore, type JsonNode } from '../documents.ts';
import { type RulesCase, rulesFixtures } from '../rules-fixtures.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { join, submit } from './support.ts';

/** The role every field of a case is assigned to, and which the participant always has. */
export const RULES_FILL_ROLE = 'role_rules_fill';
const PARA = 'pRulesFields0001';
const AFTER = 'pRulesAfter00001';

interface FixtureField {
  key: string;
  kind: string;
  options?: string[];
  required?: boolean;
  readOnly?: boolean;
}

interface Given {
  fields?: FixtureField[];
  values?: Record<string, unknown>;
  roleDefs?: string[];
  roles?: string[];
  now?: unknown;
}

interface StateExpect {
  visible: boolean;
  enabled: boolean;
  by?: { visible?: string; enabled?: string };
}

/** The kinds a participant fills; formulas, signatures and the like are written by the server. */
const FILLABLE = new Set(['text', 'number', 'date', 'choice', 'checkbox']);

/** The attributes of `rule_def` (12 §3.5). */
const RULE_DEF_ATTRS = new Set(['id', 'when', 'then', 'else', 'ext']);

const fieldId = (i: number) => `fRules${String(i).padStart(10, '0')}`;

const givenOf = (c: RulesCase): Given => (c['given'] ?? {}) as Given;

/** The roles a case needs defined: its role definitions, the roles it evaluates under, and ours. */
function rolesOf(c: RulesCase): string[] {
  const g = givenOf(c);
  return [...new Set([RULES_FILL_ROLE, ...(g.roleDefs ?? []), ...(g.roles ?? [])])];
}

/** A valid document with the case's roles and fields, and with the case's rules when `withRules`. */
function documentOf(c: RulesCase, withRules: boolean) {
  const g = givenOf(c);
  const env = contractDocument();
  (env as unknown as { requires: string[] }).requires = ['fields'];
  const root = env.doc as unknown as JsonNode;
  const defs = root.content!.find((n) => n.type === 'defs')!;
  const have = new Set(
    defs.content!.filter((n) => n.type === 'role_def').map((n) => String(n.attrs?.['id'])),
  );
  const roles = rolesOf(c).filter((r) => !have.has(r));
  for (const r of roles)
    defs.content!.push({ type: 'role_def', attrs: { id: r, name: r, color: '#1F77B4' } });
  if (withRules)
    for (const rule of (c['rules'] as Array<Record<string, unknown>>) ?? [])
      defs.content!.push({ type: 'rule_def', attrs: rule });
  const values = g.values ?? {};
  const fields = (g.fields ?? []).map((f, i) => ({
    type: 'form_field',
    attrs: {
      id: fieldId(i),
      key: f.key,
      kind: f.kind,
      label: f.key,
      assignee: RULES_FILL_ROLE,
      value: values[f.key] ?? null,
      ...(f.options ? { options: f.options.map((o) => ({ id: o, label: o })) } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.readOnly ? { readOnly: true } : {}),
    },
  }));
  const body = root.content!.find((n) => n.type === 'body')!;
  body.content!.unshift({
    type: 'paragraph',
    attrs: { id: PARA },
    content: fields.flatMap((f) => [{ type: 'text', text: ' ' }, f]),
  });
  body.content!.push({ type: 'paragraph', attrs: { id: AFTER }, content: [] });
  return { env, roles, fields: g.fields ?? [] };
}

/** A value that differs from the stored one and is valid for the kind. */
function valueFor(f: FixtureField, stored: unknown): unknown {
  switch (f.kind) {
    case 'number':
      return stored === '7' ? '8' : '7';
    case 'date':
      return stored === '2026-03-04' ? '2026-03-05' : '2026-03-04';
    case 'checkbox':
      return stored !== true;
    case 'choice':
      return (f.options ?? []).find((o) => o !== stored) ?? stored;
    default:
      return stored === 'filled' ? 'filled again' : 'filled';
  }
}

const rl = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('rules', def);

/** A positive case: each fillable field is filled in a document of its own and judged. */
function stateScenario(c: RulesCase): ScenarioDef {
  const g = givenOf(c);
  const expected = (c.expect as { fields: Record<string, StateExpect> }).fields;
  return rl({
    id: c.id,
    title: `${c.id}: a fill is accepted or refused as the fixture says`,
    spec: '12 §5, §4 P7; FRW-020',
    covers: { messages: ['sync.submit'] },
    async run(ctx: ScenarioContext) {
      const { fields } = documentOf(c, true);
      let judged = 0;
      for (const [i, f] of fields.entries()) {
        const want = expected[f.key];
        if (want === undefined || !FILLABLE.has(f.kind) || f.readOnly) continue;
        const { env } = documentOf(c, true);
        const doc = await ctx.document(env);
        const mine = await join(ctx, 'rules-fill', doc, 'filler', {
          token: { wfr: rolesOf(c).filter((r) => r === RULES_FILL_ROLE || g.roles?.includes(r)) },
        });
        try {
          const stored = (g.values ?? {})[f.key] ?? null;
          const steps = [
            {
              stepType: 'attr',
              pos: posBefore(mine.content.doc, fieldId(i)),
              attr: 'value',
              value: valueFor(f, stored),
            },
          ];
          const r = await submit(mine.wire, mine.ch, {
            base: mine.content.seq,
            steps: steps as never,
          });
          const should = want.visible && want.enabled;
          const what = `${c.id}: the fill of ${f.key} (visible ${want.visible}, enabled ${want.enabled})`;
          if (should) {
            if (r.t !== 'sync.ack') throw new KitFailure(`${what} is accepted`, 'sync.ack', r);
          } else {
            if (r.t !== 'sync.reject')
              throw new KitFailure(`${what} is refused`, 'sync.reject permission_denied', r);
            equal(r.d.code, 'permission_denied', `${what}: the code (12 §4 P7)`);
            const named = want.by?.visible ?? want.by?.enabled;
            if (named !== undefined)
              equal(
                (r.d as { rule?: string }).rule,
                named,
                `${what}: the rule the rejection names (12 §5.3)`,
              );
          }
          judged++;
        } finally {
          await mine.wire.close();
        }
      }
      check(judged > 0, `${c.id}: at least one fillable field is judged`, '> 0', judged);
      ctx.note(`${judged} fills judged`);
    },
  });
}

/** A negative case: the owner submits the rules and the commit is refused (owner decision 185). */
function problemScenario(c: RulesCase): ScenarioDef {
  return rl({
    id: c.id,
    title: `${c.id}: a rule set with problems is refused at save`,
    spec: '12 §5.2; FRW-020; owner decision 185',
    covers: { messages: ['sync.reject'] },
    async run(ctx: ScenarioContext) {
      // A member that is not an attribute of `rule_def` (12 §3.5) is not part of the node: it is
      // dropped when the step is read, so no commit can carry it and DEP cannot show its refusal.
      for (const rule of (c['rules'] as unknown[]) ?? []) {
        if (typeof rule !== 'object' || rule === null || Array.isArray(rule))
          ctx.skip('a rule that is not an object is not the attributes of a rule_def (12 §3.5)');
        for (const member of Object.keys(rule as object))
          if (!RULE_DEF_ATTRS.has(member))
            ctx.skip(
              `${member} is not an attribute of rule_def, so a commit cannot carry it (12 §3.5)`,
            );
      }
      const { env, roles } = documentOf(c, false);
      const doc = await ctx.document(env);
      const owner = await join(ctx, 'rules-owner', doc, 'owner');
      try {
        const last = roles[roles.length - 1] ?? RULES_FILL_ROLE;
        const at = posBefore(owner.content.doc, last) + 1;
        const r = await submit(owner.wire, owner.ch, {
          base: owner.content.seq,
          steps: [
            {
              stepType: 'replace',
              from: at,
              to: at,
              slice: {
                content: ((c['rules'] as Array<Record<string, unknown>>) ?? []).map((attrs) => ({
                  type: 'rule_def',
                  attrs,
                })),
              },
            },
          ] as never,
        });
        if (r.t !== 'sync.reject')
          throw new KitFailure(`${c.id}: the rule set with problems is refused`, 'sync.reject', r);
        equal(r.d.code, 'invalid_op', `${c.id}: the code (12 §5.2; owner decision 185)`);
      } finally {
        await owner.wire.close();
      }
    },
  });
}

/** The cases this profile judges, by identifier. */
export function rulesProfileCases(): { states: RulesCase[]; problems: RulesCase[] } {
  const cases = rulesFixtures().cases.filter((c) => c['kind'] === 'rules');
  const states = cases.filter(
    (c) =>
      (c.expect as { fields?: unknown }).fields !== undefined &&
      (givenOf(c).now === undefined || givenOf(c).now === null) &&
      (givenOf(c).fields ?? []).some((f) => FILLABLE.has(f.kind) && !f.readOnly),
  );
  const problems = cases.filter((c) => (c.expect as { problems?: unknown }).problems !== undefined);
  return { states, problems };
}

const { states, problems } = rulesProfileCases();

export const RULES_PROFILE: ProfileDef = {
  id: 'rules',
  title: 'Rules: the fixtures of the rules language, judged through fills and saves',
  spec: '12 §5, §10; 05 §9, §11',
  stories: ['FRW-020'],
  requires: { kind: 'features', features: ['rules', 'fields'] },
  scenarios: [...states.map(stateScenario), ...problems.map(problemScenario)],
};
