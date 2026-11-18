/**
 * The `authority-service` profile (PRO-125; 05 §10, §11): the conformance profile of the authority
 * service itself, so that an alternative implementation of the interface can be certified. It is not
 * reached over DEP. The kit is given the service's address (`--authority-service`, optionally a
 * bearer token) and speaks the HTTP binding of ADR 0314 (`authority-client.ts`).
 *
 * What it runs:
 * - the calls of 05 §10 one by one: `open`, `materialise`, `applyCommit`, `restoreSteps`, `diff`,
 *   `attribution`, `evaluateRules` and `migrate` (a service that does not announce `migrate` must
 *   refuse it with `migration_not_enabled`);
 * - the step-semantics fixtures of the pinned engine release, the canonical-hash fixtures of the
 *   model and the rules fixtures, each through the service, with the result of the fixture;
 * - a restart of the service between calls, when the caller can restart it.
 *
 * `mapRanges` has no HTTP route yet (PRO-105), so its scenario is always skipped, with that reason.
 */
import {
  canonicalEnvelope,
  canonicalNodeText,
  canonicalText,
  uuid7,
  type CdmEnvelope,
} from '@docedit/model';
import { readDocument, validate } from '@docedit/model/validate';
import {
  AUTHORITY_API,
  AUTHORITY_CALLS,
  AuthorityClient,
  expectOk,
  expectProblem,
} from '../authority-client.ts';
import { KitFailure, check, equal, isObject, jsonEqual } from '../assert.ts';
import { IDS, contractDocument, insertText, posIn } from '../documents.ts';
import { canonicalFixtures, engineDefinition, engineFixture, type ApplyCase } from '../fixtures.ts';
import { sha256Hex } from '../jcs.ts';
import { rulesFixtures, type RulesCase } from '../rules-fixtures.ts';
import type { ScenarioContext } from '../context.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('authority-service', def);

/** The calls a service must implement; `migrate` is the operator's choice and `mapRanges` has no route yet. */
const REQUIRED_CALLS = [
  'open',
  'materialise',
  'applyCommit',
  'restoreSteps',
  'diff',
  'attribution',
  'evaluateRules',
];

const ZERO = '0'.repeat(64);
const PERMS = { revision: 0, grants: [] };
const OWNER = { sub: 'tck-owner', session: 's-owner', role: 'owner' };
const EDITOR = { sub: 'tck-editor', session: 's-editor', role: 'editor' };
const VIEWER = { sub: 'tck-viewer', session: 's-viewer', role: 'viewer' };
const T0 = 1_700_000_000_000;

/**
 * The contract document, made unique by the name of its Normal style. A state is named by the hash
 * of its content, so two documents with the same content are one state; this keeps a run's states
 * its own, and a repeated run against a long-lived service apart from the one before. Attributes
 * only: no position moves.
 */
function contract(tag = ''): CdmEnvelope {
  const env = contractDocument() as unknown as CdmEnvelope;
  if (!tag) return env;
  const defs = (
    env.doc as { content: Array<{ content: Array<{ type: string; attrs: { name?: string } }> }> }
  ).content[0]!.content;
  const normal = defs.find((n) => n.type === 'style_def');
  if (normal) normal.attrs.name = `Normal ${tag}`;
  return env;
}

/** What a call answered, as a JSON object. */
function body(res: { json: unknown; text: string }, what: string): Record<string, unknown> {
  if (!isObject(res.json))
    throw new KitFailure(`${what}: the body is not a JSON object`, 'a JSON object', res.text);
  return res.json;
}

async function open(ctx: ScenarioContext, doc: string, content: CdmEnvelope = contract(doc)) {
  const res = await ctx.authority.openContent(doc, content);
  expectOk(res, 201, `open ${doc}`);
  const b = body(res, 'open');
  check(typeof b['stateId'] === 'string', 'open answers a stateId', 'a string', b);
  equal(b['seq'], 0, 'a document with no log opens at seq 0');
  check(typeof b['doc'] === 'string', 'open answers the document of the state', 'a string', b);
  return b['stateId'] as string;
}

/** The content of a state: the envelope, its text and the headers of the answer. */
async function content(ctx: ScenarioContext, stateId: string, seq?: number) {
  const res = await ctx.authority.materialise(stateId, seq);
  expectOk(res, 200, 'materialise');
  const env = body(res, 'materialise');
  return { env, text: res.text, etag: res.headers.get('etag'), res };
}

const apply = (
  ctx: ScenarioContext,
  stateId: string,
  steps: unknown,
  author: Record<string, unknown> = OWNER,
  extra: Record<string, unknown> = {},
  base = 0,
) =>
  ctx.authority.onState(stateId, 'commits', {
    commit: { id: uuid7(), base, steps, author, time: T0 },
    permissions: PERMS,
    ...extra,
  });

const introPos = () => posIn((contract() as { doc: unknown }).doc, IDS.intro, 0);

/** A rules case as a CDM document: its roles and rules in the definitions, its fields in the body. */
function rulesDocument(c: RulesCase): CdmEnvelope {
  const given = (c['given'] ?? {}) as {
    fields?: Array<{
      key: string;
      kind: string;
      options?: string[];
      required?: boolean;
      readOnly?: boolean;
    }>;
    values?: Record<string, unknown>;
    roleDefs?: string[];
  };
  const para = (id: string, text: string, extra: unknown[] = []) => ({
    type: 'paragraph',
    attrs: { id },
    content: [...(text ? [{ type: 'text', text }] : []), ...extra],
  });
  const fields = (given.fields ?? []).map((f, i) => ({
    type: 'form_field',
    attrs: {
      id: `fFx${String(i).padStart(13, '0')}`,
      key: f.key,
      kind: f.kind,
      label: f.key,
      assignee: null,
      value: given.values?.[f.key] ?? null,
      ...(f.options ? { options: f.options.map((o) => ({ id: o, label: o })) } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.readOnly ? { readOnly: true } : {}),
    },
  }));
  return {
    cdm: 1,
    requires: ['fields'],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
            ...(given.roleDefs ?? []).map((role) => ({
              type: 'role_def',
              attrs: { id: role, name: role, color: '#000000' },
            })),
            ...((c['rules'] as unknown[]) ?? []).map((rule) => ({ type: 'rule_def', attrs: rule })),
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para(
              'pOne000000000001',
              'First paragraph.',
              fields.flatMap((f) => [{ type: 'text', text: ' ' }, f]),
            ),
            para('pTwo000000000001', 'Second paragraph.'),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

interface FieldState {
  key: string;
  visible: boolean;
  enabled: boolean;
  required?: boolean;
  value?: unknown;
}

/**
 * Problems as a set of `{ code, construct, keys }`. The fixtures also carry a path into the rule list; the
 * service holds the rules in the nodes of a document, so its path is a path into the document and is
 * not compared (the story's notes say so).
 */
function problemSet(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => {
      const o = isObject(p) ? p : {};
      return JSON.stringify([o['code'], o['construct'] ?? null, o['keys'] ?? null]);
    })
    .sort();
}

export const AUTHORITY_SERVICE: ProfileDef = {
  id: 'authority-service',
  title: 'The authority service interface: the calls of 05 §10 and the golden fixtures through it',
  spec: '05 §10, §11',
  stories: ['PRO-125'],
  requires: { kind: 'authority-service' },
  scenarios: [
    s({
      id: 'capabilities',
      title: 'the service lists the calls it implements, and answers its probes',
      spec: '05 §10; ADR 0314',
      covers: {},
      async run(ctx) {
        const a = ctx.authority;
        const caps = body(expectOk(await a.capabilities(), 200, 'capabilities'), 'capabilities');
        const calls = caps['calls'];
        check(
          Array.isArray(calls) && calls.every((c) => typeof c === 'string'),
          'capabilities lists the calls as strings',
          'calls: string[]',
          caps,
        );
        for (const c of calls as string[])
          check(
            (AUTHORITY_CALLS as readonly string[]).includes(c),
            `the service announces a call 05 §10 does not name: ${c}`,
            AUTHORITY_CALLS,
            calls,
          );
        for (const c of REQUIRED_CALLS)
          check((calls as string[]).includes(c), `the service implements ${c} (05 §10)`, c, calls);
        check(
          Array.isArray(caps['features']) && caps['features'].every((f) => typeof f === 'string'),
          'capabilities lists the features a backend that delegates to it may announce',
          'features: string[]',
          caps['features'],
        );
        const health = await a.call('GET', `${AUTHORITY_API}/health`);
        expectOk(health, 200, 'health');
        const ready = await a.call('GET', `${AUTHORITY_API}/ready`);
        expectOk(ready, 200, 'ready');
        ctx.note(`the service announces ${(calls as string[]).join(', ')}`);
      },
    }),
    s({
      id: 'access',
      title: 'a service with a token refuses a call without it, and still answers its probes',
      spec: '05 §10; ADR 0314',
      covers: {},
      async run(ctx) {
        const given = ctx.config.authorityService;
        if (!given?.token) ctx.skip('the service was given no bearer token (--authority-token)');
        const bare = new AuthorityClient(ctx.authority.url);
        expectProblem(await bare.capabilities(), 401, 'unauthorized', 'a call without the token');
        expectOk(await bare.call('GET', `${AUTHORITY_API}/health`), 200, 'health without a token');
      },
    }),
    s({
      id: 'open-materialise',
      title: 'open loads a document by its state identifier, and materialise returns it unchanged',
      spec: '05 §10; 08 §2',
      covers: {},
      async run(ctx) {
        const a = ctx.authority;
        const env = contract(`open-${ctx.config.run}`);
        const stateId = await open(ctx, `tck-${ctx.config.run}-open`, env);
        const got = await content(ctx, stateId);
        equal(got.env['cdm'], 1, 'the content is CDM 1');
        equal(
          got.text,
          canonicalText(canonicalEnvelope(env as never)),
          'materialise returns the canonical form of the document that was opened (03 §2)',
        );
        check(
          got.etag === `"${sha256Hex(got.text)}"`,
          'the ETag of a state is the hash of its canonical text',
          `"${sha256Hex(got.text)}"`,
          got.etag,
        );
        equal(got.res.headers.get('x-state-id'), stateId, 'the answer names the state');
        // A state the service does not hold is `unknown_state`, so the caller can open it again.
        expectProblem(await a.materialise(ZERO), 404, 'unknown_state', 'an unknown state');
        expectProblem(
          await a.materialise('not-a-state'),
          400,
          'invalid_request',
          'a state that is not 64 hexadecimal digits',
        );
        expectProblem(
          await a.materialise(stateId, 9),
          404,
          'not_found',
          'a sequence number past the head',
        );
        // The state identifier is the hash of what was opened: any other claim is refused.
        const doc = `tck-${ctx.config.run}-mismatch`;
        const wrong = await a.open(doc, {
          checkpointRef: {
            seq: 0,
            chainHead: null,
            contentHash: stateId,
            content: env,
          },
          commits: [],
          stateId: '1'.repeat(64),
        });
        expectProblem(wrong, 409, 'state_mismatch', 'open with a stateId that is not the head');
        expectProblem(
          await a.open(doc, { checkpointRef: null }),
          400,
          'invalid_request',
          'open with a body that is not a request',
        );
      },
    }),
    s({
      id: 'canonical-hash',
      title: 'the canonical-hash fixtures come back from materialise as the fixture says',
      spec: '03 §2; CDM-011; 05 §10',
      covers: {},
      async run(ctx) {
        const cases = canonicalFixtures().filter((c) => c.kind === 'envelope');
        check(cases.length > 0, 'the kit has canonical envelope fixtures', '>0', cases.length);
        let refusedInputs = 0;
        let unopenable = 0;
        for (const c of cases) {
          const doc = `tck-${ctx.config.run}-canon-${c.name}`;
          let input = c.inputValue as CdmEnvelope;
          // An input that breaks a CDM invariant before it is canonicalised (an empty text node, say)
          // is refused at open (03 §6); its canonical form is the document to open instead.
          if (!readDocument(input as never).ok) {
            expectProblem(
              await ctx.authority.openContent(doc, input),
              422,
              'validation_failed',
              `open of the input of ${c.name}`,
            );
            input = JSON.parse(c.expectedText) as CdmEnvelope;
            // A fixture that exercises the canonical form of a document no service can hold (its
            // identifiers break I11) is refused whole; it can only be checked as a refusal.
            if (!readDocument(input as never).ok) {
              unopenable++;
              continue;
            }
            refusedInputs++;
          }
          const stateId = await open(ctx, doc, input);
          const got = await content(ctx, stateId);
          equal(got.text, c.expectedText, `${c.name}: the canonical text (03 §2)`);
          equal(sha256Hex(got.text), c.sha256, `${c.name}: the canonical hash (03 §2)`);
          equal(stateId, c.sha256, `${c.name}: a document with no log is named by its hash`);
        }
        ctx.note(
          `${cases.length} canonical fixtures through open and materialise (${refusedInputs} inputs refused as invalid CDM, their canonical forms opened instead; ${unopenable} refused whole, because even their canonical form is not valid CDM)`,
        );
      },
    }),
    s({
      id: 'steps',
      title: 'the step-semantics fixtures give, through applyCommit, the document of the fixture',
      spec: '04 §4; 05 §10; SYN-002',
      timeoutMs: 180_000,
      covers: {},
      async run(ctx) {
        const def = engineDefinition();
        const fx = engineFixture<ApplyCase>('apply');
        equal(fx.engine, def.engine, 'the fixtures belong to the engine definition');
        let applied = 0;
        let refused = 0;
        let unreplayable = 0;
        const opened = new Map<string, string | null>();
        for (const c of fx.cases) {
          if (!opened.has(c.doc)) {
            const env = { cdm: 1, requires: [], doc: fx.docs[c.doc] } as unknown as CdmEnvelope;
            if (!validate(env as never).valid) opened.set(c.doc, null);
            else opened.set(c.doc, await open(ctx, `tck-${ctx.config.run}-eng-${c.doc}`, env));
          }
          const stateId = opened.get(c.doc);
          if (!stateId) {
            unreplayable++; // a fixture document that breaks a CDM invariant cannot be opened (03 §6)
            continue;
          }
          const res = expectOk(await apply(ctx, stateId, c.steps), 200, `${c.id}: applyCommit`);
          const answer = body(res, c.id);
          const rejected = isObject(answer['rejected']) ? answer['rejected'] : null;
          if (c.expected.ok) {
            if (rejected) {
              const resultValid = validate({
                cdm: 1,
                requires: [],
                doc: c.expected.doc,
              } as never).valid;
              const identity =
                rejected['code'] === 'permission_denied' &&
                String(rejected['reason'] ?? '').includes('must name the submitting user');
              const boundary =
                rejected['code'] === 'invalid_op' &&
                String(rejected['reason'] ?? '').includes('(P3)');
              if (!resultValid || identity || boundary) {
                refused++; // the engine applies it; the authority refuses it for 03 §3 or 03 §5
                continue;
              }
              throw new KitFailure(
                `${c.id}: steps the engine applies (SYN-002)`,
                'accepted',
                rejected,
              );
            }
            const after = await content(ctx, answer['stateId'] as string);
            equal(
              sha256Hex(canonicalNodeText(after.env['doc'] as never)),
              c.expected.docSha256,
              `${c.id}: the canonical hash of the result (04 §4; 03 §2)`,
            );
            applied++;
          } else {
            check(
              rejected !== null,
              `${c.id}: steps the engine cannot apply`,
              'a rejection',
              answer,
            );
            equal(rejected['code'], 'invalid_op', `${c.id}: the code of a step that fails (04 §5)`);
            refused++;
          }
        }
        ctx.note(
          `${fx.cases.length} apply cases of ${def.engine}: ${applied} applied with the fixture hash, ${refused} refused, ${unreplayable} skipped because the fixture document is not valid CDM`,
        );
      },
    }),
    s({
      id: 'apply-commit',
      title: 'applyCommit returns the mapped steps, the scopes and the new state, or the rejection',
      spec: '05 §10; 04 §5, §6; 07 §5',
      covers: {},
      async run(ctx) {
        const a = ctx.authority;
        const doc = `tck-${ctx.config.run}-apply`;
        const env = contract(doc);
        const stateId = await open(ctx, doc, env);
        const res = expectOk(
          await apply(ctx, stateId, [insertText(introPos(), 'Hi ')], EDITOR),
          200,
          'an acceptable commit',
        );
        const r = body(res, 'applyCommit');
        check(r['rejected'] === undefined, 'the commit is accepted', 'accepted', r['rejected']);
        equal(r['seq'], 1, 'the commit is the first of the log');
        jsonEqual(r['scopes'], ['body'], 'the scopes the commit changed (07 §5.1)');
        equal(r['rebased'], false, 'a commit at the head is not rebased');
        check(
          Array.isArray(r['steps']) && r['steps'].length === 1,
          'the mapped steps',
          '1 step',
          r['steps'],
        );
        const commits = r['commits'] as Array<Record<string, unknown>>;
        check(
          Array.isArray(commits) &&
            commits.length >= 1 &&
            commits[commits.length - 1]!['hash'] === r['stateId'],
          'the new state is the head of the chain of the commits to store',
          r['stateId'],
          commits,
        );
        const after = await content(ctx, r['stateId'] as string);
        check(
          JSON.stringify(after.env['doc']).includes('Hi Hello world'),
          'the new state has the text',
          'Hi Hello world',
          '(not found)',
        );
        // The commits are what `open` takes: opening from them gives the same state and content.
        const reopened = body(
          expectOk(
            await a.open(doc, {
              checkpointRef: {
                seq: 0,
                chainHead: null,
                contentHash: stateId,
                content: env,
              },
              commits,
              stateId: r['stateId'],
            }),
            201,
            'open from the commits of an answer',
          ),
          'open',
        );
        equal(reopened['stateId'], r['stateId'], 'opening from the commits gives the same state');
        equal(
          (await content(ctx, r['stateId'] as string)).text,
          after.text,
          'and the same content',
        );
        // The old state is still the old content: states are immutable.
        const before = await content(ctx, stateId);
        check(
          !JSON.stringify(before.env['doc']).includes('Hi Hello world'),
          'the state before the commit is unchanged',
          'no new text',
          '(changed)',
        );
        // A rejection is an answer (a 200), never an error.
        const denied = body(
          expectOk(
            await apply(ctx, stateId, [insertText(introPos(), 'x')], VIEWER),
            200,
            'a commit the permissions refuse',
          ),
          'applyCommit',
        );
        const d = isObject(denied['rejected']) ? denied['rejected'] : null;
        check(d !== null, 'a viewer commit is rejected', '{ rejected }', denied);
        equal(d['code'], 'permission_denied', 'the code of a commit the role cannot make');
        equal(d['action'], 'drop', 'the action of a refused commit');
        // The caller decided under a state it relied on; when that is not the state now, conflict.
        const stale = body(
          expectOk(
            await apply(ctx, stateId, [insertText(introPos(), 'x')], EDITOR, {
              preconditions: { revision: 7 },
            }),
            200,
            'a commit decided under another grants revision',
          ),
          'applyCommit',
        );
        const c = isObject(stale['rejected']) ? stale['rejected'] : null;
        check(c !== null, 'a stale precondition is a rejection', '{ rejected }', stale);
        equal(c['code'], 'conflict', 'the code of a commit decided under a stale state (04 §5)');
        equal(c['head'], 0, 'the rejection names the head');
        // A step that cannot apply is invalid_op.
        const bad = body(
          expectOk(
            await apply(ctx, stateId, [insertText(999_999, 'x')], EDITOR),
            200,
            'a step that cannot apply',
          ),
          'applyCommit',
        );
        equal(
          isObject(bad['rejected']) ? bad['rejected']['code'] : undefined,
          'invalid_op',
          'the code of a step that cannot apply',
        );
        expectProblem(
          await apply(ctx, ZERO, [insertText(introPos(), 'x')], EDITOR),
          404,
          'unknown_state',
          'applyCommit on an unknown state',
        );
        expectProblem(
          await a.onState(stateId, 'commits', { nonsense: true }),
          400,
          'invalid_request',
          'applyCommit with a malformed request',
        );
      },
    }),
    s({
      id: 'history-calls',
      title: 'restoreSteps, diff and attribution answer for a state with a log',
      spec: '05 §10; 08 §6, §7, §8',
      covers: {},
      async run(ctx) {
        const a = ctx.authority;
        const stateId = await open(ctx, `tck-${ctx.config.run}-history`);
        const made = body(
          expectOk(
            await apply(ctx, stateId, [insertText(introPos(), 'Hi ')], EDITOR),
            200,
            'a commit',
          ),
          'applyCommit',
        );
        const head = made['stateId'] as string;
        const view = (who: Record<string, unknown>) => ({
          requester: who,
          permissions: PERMS,
          now: T0,
        });
        const diff = body(
          expectOk(
            await a.onState(head, 'diff', { ...view(OWNER), fromSeq: 0, toSeq: 1 }),
            200,
            'diff',
          ),
          'diff',
        );
        check(isObject(diff['comparison']), 'diff answers a comparison', '{ comparison }', diff);
        const char = body(
          expectOk(
            await a.onState(head, 'diff', {
              ...view(OWNER),
              fromSeq: 0,
              toSeq: 1,
              granularity: 'char',
            }),
            200,
            'diff by character',
          ),
          'diff',
        );
        check(
          isObject(char['comparison']),
          'diff by character answers a comparison',
          '{ comparison }',
          char,
        );
        const attr = body(
          expectOk(await a.onState(head, 'attribution', view(OWNER)), 200, 'attribution'),
          'attribution',
        );
        equal(attr['seq'], 1, 'attribution is for the head');
        const runs = (
          attr['blocks'] as Array<{ runs: Array<{ user: string; seq: number }> }>
        ).flatMap((b) => b.runs);
        check(
          runs.some((r) => r.user === EDITOR.sub && r.seq === 1),
          'the text of the commit is attributed to its author',
          { user: EDITOR.sub, seq: 1 },
          runs,
        );
        const restore = body(
          expectOk(
            await a.onState(head, 'restore-steps', { ...view(OWNER), toSeq: 0 }),
            200,
            'restoreSteps',
          ),
          'restoreSteps',
        );
        equal(restore['toSeq'], 0, 'restoreSteps names the target');
        equal(restore['headSeq'], 1, 'restoreSteps names the head it was computed against');
        equal(restore['unchanged'], false, 'the document differs from the target');
        check(
          restore['kind'] === 'steps' || restore['kind'] === 'snapshot',
          'restoreSteps answers steps or a snapshot',
          'steps | snapshot',
          restore['kind'],
        );
        const same = body(
          expectOk(
            await a.onState(head, 'restore-steps', { ...view(OWNER), toSeq: 1 }),
            200,
            'restoreSteps to the head',
          ),
          'restoreSteps',
        );
        equal(same['unchanged'], true, 'restoring to the head changes nothing');
        // The history rules are decisions: a refusal is an answer, not an error.
        const refused = body(
          expectOk(
            await a.onState(head, 'restore-steps', { ...view(VIEWER), toSeq: 0 }),
            200,
            'restoreSteps by a viewer',
          ),
          'restoreSteps',
        );
        check(isObject(refused['refused']), 'a viewer cannot restore', '{ refused }', refused);
        const past = body(
          expectOk(
            await a.onState(head, 'diff', { ...view(OWNER), fromSeq: 0, toSeq: 9 }),
            200,
            'diff past the head',
          ),
          'diff',
        );
        check(isObject(past['refused']), 'a range past the head is refused', '{ refused }', past);
      },
    }),
    s({
      id: 'evaluate-rules',
      title: 'the rules fixtures give, through evaluateRules, the result of the fixture',
      spec: '12 §5; 05 §10; FRW-020',
      timeoutMs: 180_000,
      covers: {},
      async run(ctx) {
        const a = ctx.authority;
        const cases = rulesFixtures().cases.filter((c) => c.kind === 'rules');
        let positive = 0;
        let negative = 0;
        let fieldsChecked = 0;
        for (const c of cases) {
          const given = (c['given'] ?? {}) as { roles?: string[]; now?: unknown };
          const doc = `tck-${ctx.config.run}-rules-${c.id}`;
          const env = rulesDocument(c);
          const expected = c.expect as {
            fields?: Record<string, FieldState>;
            problems?: unknown[];
          };
          const opened = await a.openContent(doc, env);
          if (expected.fields) {
            expectOk(opened, 201, `${c.id}: open`);
            const stateId = (opened.json as { stateId: string }).stateId;
            const res = expectOk(
              await a.onState(stateId, 'evaluate-rules', {
                roles: given.roles ?? [],
                ...(given.now ? { now: given.now } : {}),
              }),
              200,
              `${c.id}: evaluateRules`,
            );
            const fields = (body(res, c.id)['fields'] ?? []) as FieldState[];
            for (const [key, want] of Object.entries(expected.fields)) {
              const got = fields.find((f) => f.key === key);
              check(got !== undefined, `${c.id}: the field ${key} is evaluated`, key, fields);
              equal(got.visible, want.visible, `${c.id} ${key}: visible`);
              equal(got.enabled, want.enabled, `${c.id} ${key}: enabled`);
              if (want.required !== undefined)
                equal(got.required, want.required, `${c.id} ${key}: required`);
              if (want.value !== undefined)
                equal(got.value ?? null, want.value, `${c.id} ${key}: value`);
              fieldsChecked++;
            }
            positive++;
          } else {
            // A rule set with problems is refused when the document is opened (I14, I15) or, when
            // it opens, when the rules are evaluated, with the problems of the fixture.
            if (opened.status === 201) {
              const stateId = (opened.json as { stateId: string }).stateId;
              const res = await a.onState(stateId, 'evaluate-rules', { roles: given.roles ?? [] });
              expectProblem(res, 422, 'invalid_rules', `${c.id}: rules with problems`);
              const info = isObject(res.json) && isObject(res.json['info']) ? res.json['info'] : {};
              jsonEqual(
                problemSet(info['problems']),
                problemSet(expected.problems),
                `${c.id}: the problems of the fixture, as a set (12 §5)`,
              );
            } else expectProblem(opened, 422, 'validation_failed', `${c.id}: open`);
            negative++;
          }
        }
        ctx.note(
          `${cases.length} rules cases: ${positive} evaluated (${fieldsChecked} field states), ${negative} refused`,
        );
      },
    }),
    s({
      id: 'migrate',
      title: 'migrate runs only when the service announces it, and is refused otherwise',
      spec: '05 §10; 03 §11.3',
      covers: {},
      async run(ctx) {
        const a = ctx.authority;
        const caps = body(await a.capabilities(), 'capabilities');
        const doc = `tck-${ctx.config.run}-migrate`;
        const request = { content: contract(), target: 1 };
        if ((caps['calls'] as string[]).includes('migrate')) {
          const res = expectOk(await a.migrate(doc, request), 200, 'migrate to the same version');
          const m = body(res, 'migrate');
          equal(m['cdm'], 1, 'migrate answers the version it reached');
          check(isObject(m['content']), 'migrate answers the content', 'an envelope', m);
          const again = await a.migrate(doc, request);
          equal(again.text, res.text, 'migrate gives the same bytes twice');
        } else
          expectProblem(
            await a.migrate(doc, request),
            403,
            'migration_not_enabled',
            'migrate when the operator did not enable it',
          );
      },
    }),
    s({
      id: 'restart',
      title: 'a call repeated after the service restarted gives the same result',
      spec: '05 §10',
      timeoutMs: 120_000,
      covers: {},
      async run(ctx) {
        const a = ctx.authority;
        const doc = `tck-${ctx.config.run}-restart`;
        const env = contract(doc);
        const first = await open(ctx, doc, env);
        const made = body(
          expectOk(
            await apply(ctx, first, [insertText(introPos(), 'Hi ')], EDITOR),
            200,
            'a commit',
          ),
          'applyCommit',
        );
        const commits = made['commits'];
        const head = made['stateId'] as string;
        const checkpoint = { seq: 0, chainHead: null, contentHash: first, content: env };
        const rules = { roles: [] as string[] };
        const before = {
          content: (await content(ctx, head)).text,
          rules: (await a.onState(head, 'evaluate-rules', rules)).text,
          attribution: (
            await a.onState(head, 'attribution', {
              requester: OWNER,
              permissions: PERMS,
              now: T0,
            })
          ).text,
        };
        await ctx.restartAuthority();
        // A service that holds nothing that matters answers `unknown_state`, and the caller opens
        // the state again from the same inputs. One that persisted it answers as before.
        const probe = await ctx.authority.materialise(head);
        if (probe.status === 404) {
          expectProblem(probe, 404, 'unknown_state', 'a state the restarted service does not hold');
          const again = body(
            expectOk(
              await ctx.authority.open(doc, { checkpointRef: checkpoint, commits, stateId: head }),
              201,
              'open again after the restart',
            ),
            'open',
          );
          equal(again['stateId'], head, 'the same inputs give the same state');
        } else expectOk(probe, 200, 'materialise after the restart');
        const after = {
          content: (await content(ctx, head)).text,
          rules: (await ctx.authority.onState(head, 'evaluate-rules', rules)).text,
          attribution: (
            await ctx.authority.onState(head, 'attribution', {
              requester: OWNER,
              permissions: PERMS,
              now: T0,
            })
          ).text,
        };
        equal(after.content, before.content, 'materialise after the restart');
        equal(after.rules, before.rules, 'evaluateRules after the restart');
        equal(after.attribution, before.attribution, 'attribution after the restart');
        // A call that changes state gives the same answer: the commit is not applied twice by the restart.
        const next = body(
          expectOk(
            await ctx.authority.onState(head, 'commits', {
              commit: {
                id: uuid7(),
                base: 1,
                steps: [insertText(introPos(), 'A')],
                author: EDITOR,
                time: T0 + 1000,
              },
              permissions: PERMS,
            }),
            200,
            'a commit on the reopened state',
          ),
          'applyCommit',
        );
        equal(next['seq'], 2, 'the next commit follows the one before the restart');
      },
    }),
    s({
      id: 'map-ranges',
      title: 'mapRanges maps comment ranges and presence through commits',
      spec: '05 §10; ADR 0015; PRO-105',
      covers: {},
      async run(ctx) {
        ctx.skip(
          'the interface has no route for mapRanges yet: the service of PRO-105 is not built, so the call cannot be exercised',
        );
      },
    }),
  ],
};
