// PRO-107: `migrate` and `evaluateRules` of the authority service (05 §10; 03 §11.3; 12 §5), checked
// against the model's migration framework and the rules package on the published rules fixtures.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type JsonEnvelope,
  type JsonNode,
  type Migration,
  canonicalEnvelope,
  canonicalText,
  documentHash,
  migrate,
  moveExtKey,
} from '@docedit/model';
import { CDM1, type CdmDefinition } from '@docedit/model/definition';
import example from '@docedit/model/fixtures/example-03-12.json' with { type: 'json' };
import { readDocument } from '@docedit/model/validate';
import { evaluateDocument } from '@docedit/rules';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService } from '../src/service.ts';
import { baseEnvelope, buildLog, openRequest } from './log.ts';

type J = Record<string, unknown>;

// ---- migrate ----------------------------------------------------------------------------------

/** Test-only (as the model's own tests): version 1 to 2 moves `ext.keepWithNext` onto the node. */
const toV2: Migration = {
  from: 1,
  to: 2,
  name: 'test: move ext.keepWithNext to keepWithNext',
  apply(env) {
    const doc = env['doc'] as { attrs?: Record<string, unknown> };
    if (doc.attrs) Object.assign(doc.attrs, moveExtKey(doc.attrs, 'keepWithNext', 'keepWithNext'));
    return { ...env, cdm: 2 };
  },
};
/** Test-only: a migration that returns a document that is not valid CDM. */
const brokenV2: Migration = {
  from: 1,
  to: 2,
  name: 'test: breaks the document',
  apply: (env) => ({ ...env, cdm: 2, doc: { type: 'paragraph' } }),
};
/** Test-only: a migration that stamps the wrong version. */
const wrongStamp: Migration = {
  from: 1,
  to: 2,
  name: 'test: forgets the version',
  apply: (env) => ({ ...env }),
};
/** Test-only: the definition of version 2 is version 1's, stamped 2. */
const DEF2: CdmDefinition = { ...CDM1, cdm: 2 };

const older = (): JsonEnvelope => structuredClone(example) as unknown as JsonEnvelope;
const enabled = (migrations: readonly Migration[]) =>
  new AuthorityService({
    allowMigrations: true,
    migrations,
    definitions: [CDM1, DEF2],
  });

describe('migrate (PRO-107 criteria 1 and 2)', () => {
  it('returns content valid for the new version, equal to the in-process migration', async () => {
    const service = enabled([toV2]);
    const r = await service.migrate({ content: older(), target: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inProcess = migrate(older() as unknown as J, [toV2], 2);
    expect(inProcess.ok).toBe(true);
    if (!inProcess.ok) return;
    const expected = canonicalEnvelope(inProcess.envelope as unknown as JsonEnvelope, DEF2);
    expect(r.text).toBe(canonicalText(expected, DEF2));
    expect(r.contentHash).toBe(await documentHash(expected, DEF2));
    expect(r.cdm).toBe(2);
    expect(r.steps).toEqual([toV2.name]);
    expect(readDocument(r.content, { def: DEF2 }).ok).toBe(true);
  });

  it('gives the same bytes when run twice, and leaves its input as it was', async () => {
    const service = enabled([toV2]);
    const input = older();
    const before = JSON.stringify(input);
    const a = await service.migrate({ content: input, target: 2 });
    const b = await service.migrate({ content: input, target: 2 });
    expect(a.ok && b.ok && a.text === b.text).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps no state: a result is not a state, and a failure changes nothing', async () => {
    const built = await buildLog(['a']);
    const service = enabled([wrongStamp]);
    await service.open(await openRequest(built, 1));
    const before = service.size;
    const failures = [
      await service.migrate({ content: older(), target: 2 }),
      await enabled([brokenV2]).migrate({ content: older(), target: 2 }),
      await service.migrate({ content: older(), target: 3 }),
      await service.migrate({ content: { ...older(), cdm: 2 }, target: 1 }),
      await service.migrate({ content: older() }),
      await service.migrate(null),
    ];
    expect(failures.every((f) => !f.ok)).toBe(true);
    expect(failures.map((f) => (f.ok ? '' : f.error.code))).toEqual([
      'migration_failed', // the migration did not stamp version 2
      'migration_failed', // its result is not valid CDM 2
      'unsupported_cdm', // no definition of version 3
      'migration_failed', // a downgrade
      'invalid_request',
      'invalid_request',
    ]);
    expect(failures[0]).toMatchObject({ error: { detail: { code: 'migration_result_invalid' } } });
    expect(failures[1]).toMatchObject({ error: { detail: { code: 'result_invalid' } } });
    expect(failures[3]).toMatchObject({ error: { detail: { code: 'migration_downgrade' } } });
    expect(service.size).toBe(before);
    expect(service.holds(built.heads[1]!)).toBe(true);
  });

  it('refuses a missing step', async () => {
    const r = await enabled([]).migrate({ content: older(), target: 2 });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'migration_failed', detail: { code: 'migration_missing' } },
    });
  });
});

describe('migrations are gated by the operator (03 §11.3)', () => {
  it('does not run unless the operator enabled them, and the call is not announced', async () => {
    const off = new AuthorityService({ migrations: [toV2], definitions: [CDM1, DEF2] });
    expect(await off.migrate({ content: older(), target: 2 })).toMatchObject({
      ok: false,
      error: { code: 'migration_not_enabled' },
    });
    expect(off.calls).not.toContain('migrate');
    expect(enabled([toV2]).calls).toContain('migrate');
  });

  it('is never triggered by opening a document of an older cdm', async () => {
    const service = enabled([toV2]);
    const built = await buildLog(['a'], { envelope: { ...baseEnvelope(), cdm: 0 } });
    expect(await service.open(await openRequest(built, 1))).toMatchObject({
      ok: false,
      error: { code: 'unsupported_cdm' },
    });
    expect(service.size).toBe(0);
  });
});

// ---- evaluateRules ----------------------------------------------------------------------------

const FIXTURES = resolve(import.meta.dirname, '../../../spec/rules/rules-1.fixtures.json');

interface FixtureField {
  key: string;
  kind: string;
  options?: string[];
  required?: boolean;
  readOnly?: boolean;
}
interface StateExpect {
  visible: boolean;
  enabled: boolean;
  required?: boolean;
  value?: string | null;
}
interface RulesCase {
  id: string;
  kind: string;
  rules: J[];
  given?: {
    fields?: FixtureField[];
    values?: Record<string, unknown>;
    roleDefs?: string[];
    roles?: string[];
    now?: { instant: string; timeZone: string };
  };
  expect: { fields?: Record<string, StateExpect>; problems?: unknown[] };
}

const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as { cases: Array<{ kind: string }> };
const cases = fixtures.cases.filter((c) => c.kind === 'rules') as unknown as RulesCase[];
const positive = cases.filter((c) => c.expect.fields !== undefined);
const negative = cases.filter((c) => c.expect.problems !== undefined);

/** The case as a CDM document: its roles and rules in the definitions, its fields in the body. */
function documentOf(c: RulesCase): JsonEnvelope {
  const env = baseEnvelope(['fields']);
  const root = env.doc as unknown as { content: Array<{ content: J[] }> };
  const defs = root.content[0]!.content;
  for (const role of c.given?.roleDefs ?? [])
    defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#000000' } });
  for (const rule of c.rules) defs.push({ type: 'rule_def', attrs: rule });
  const intro = root.content[1]!.content[0]!;
  const values = c.given?.values ?? {};
  const content = (intro['content'] as J[] | undefined) ?? [];
  const fields = (c.given?.fields ?? []).map((f, i) => ({
    type: 'form_field',
    attrs: {
      id: `fFx${String(i).padStart(13, '0')}`,
      key: f.key,
      kind: f.kind,
      label: f.key,
      assignee: null,
      value: values[f.key] ?? null,
      ...(f.options ? { options: f.options.map((o) => ({ id: o, label: o })) } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.readOnly ? { readOnly: true } : {}),
    },
  }));
  intro['content'] = [...content, ...fields.flatMap((f) => [{ type: 'text', text: ' ' }, f])];
  return env;
}

/** An `open` request for a document with no log: the checkpoint is the document. */
async function openDocument(service: AuthorityService, env: JsonEnvelope) {
  const hash = await documentHash(env);
  const r = await service.open({
    doc: 'doc-rules',
    checkpointRef: { seq: 0, chainHead: null, contentHash: hash, content: env },
    commits: [],
    stateId: hash,
  });
  return { r, stateId: hash };
}

describe('evaluateRules (PRO-107 criterion 3)', () => {
  it('splits the fixtures into positive and negative cases', () => {
    expect(positive.length).toBe(31);
    expect(negative.length).toBe(37);
  });

  it('gives what the rules package gives, and what each positive fixture expects', async () => {
    const service = new AuthorityService();
    let checked = 0;
    for (const c of positive) {
      const env = documentOf(c);
      const { r, stateId } = await openDocument(service, env);
      expect(r, c.id).toMatchObject({ ok: true });
      const context = {
        roles: c.given?.roles ?? [],
        ...(c.given?.now ? { now: c.given.now } : {}),
      };
      const answer = await service.evaluateRules(stateId, context);
      expect(answer.ok, c.id).toBe(true);
      if (!answer.ok) continue;
      // The package on the same document, called directly.
      const direct = evaluateDocument(env, context);
      expect(JSON.parse(JSON.stringify(answer.evaluation)), c.id).toEqual(
        JSON.parse(JSON.stringify(direct)),
      );
      // What the fixture says.
      for (const [key, want] of Object.entries(c.expect.fields!)) {
        const got = answer.evaluation.fields.find((f) => f.key === key);
        expect(got, `${c.id} ${key}`).toBeDefined();
        expect(got!.visible, `${c.id} ${key} visible`).toBe(want.visible);
        expect(got!.enabled, `${c.id} ${key} enabled`).toBe(want.enabled);
        if (want.required !== undefined)
          expect(got!.required, `${c.id} ${key} required`).toBe(want.required);
        if (want.value !== undefined)
          expect(got!.value ?? null, `${c.id} ${key} value`).toBe(want.value);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('never accepts a negative fixture as a state with evaluable rules', async () => {
    // A rule set with problems is refused when the document is opened (I14, I15) or, if it opens,
    // when the rules are evaluated, and the two answers are the rules package's.
    const service = new AuthorityService();
    let atOpen = 0;
    let atEvaluate = 0;
    for (const c of negative) {
      const env = documentOf(c);
      const { r, stateId } = await openDocument(service, env);
      if (!r.ok) {
        expect(r.error.code, c.id).toBe('validation_failed');
        atOpen++;
        continue;
      }
      const answer = await service.evaluateRules(stateId, { roles: c.given?.roles ?? [] });
      expect(answer, c.id).toMatchObject({ ok: false, error: { code: 'invalid_rules' } });
      atEvaluate++;
    }
    // 7 documents fail the model's invariants at open; the other 30 open and fail to compile.
    expect([atOpen, atEvaluate]).toEqual([7, 30]);
  });

  it('applies values that replace the stored ones, and returns only the keys asked for', async () => {
    const c = positive.find((p) => p.id === 'rules.spec-example.married')!;
    const service = new AuthorityService();
    const env = documentOf(c);
    const { stateId } = await openDocument(service, env);
    const stored = await service.evaluateRules(stateId, {});
    expect(
      stored.ok && stored.evaluation.fields.find((f) => f.key === 'tenant.spouseName'),
    ).toMatchObject({
      visible: true,
      required: true,
    });
    const typed = await service.evaluateRules(stateId, {
      values: { 'tenant.maritalStatus': 'single' },
      keys: ['tenant.spouseName'],
    });
    expect(typed.ok && typed.evaluation.fields).toMatchObject([
      { key: 'tenant.spouseName', visible: false, required: false },
    ]);
    const direct = evaluateDocument(
      env,
      { roles: [] },
      { values: { 'tenant.maritalStatus': 'single' }, keys: ['tenant.spouseName'] },
    );
    expect(JSON.parse(JSON.stringify(typed.ok && typed.evaluation))).toEqual(
      JSON.parse(JSON.stringify(direct)),
    );
  });

  it('refuses an unknown state and a malformed request', async () => {
    const service = new AuthorityService();
    expect(await service.evaluateRules('0'.repeat(64), {})).toMatchObject({
      ok: false,
      error: { code: 'unknown_state' },
    });
    const c = positive[0]!;
    const { stateId } = await openDocument(service, documentOf(c));
    for (const bad of [
      { roles: 'x' },
      { values: [] },
      { keys: [1] },
      { now: 3 },
      { budget: 'x' },
    ]) {
      expect(await service.evaluateRules(stateId, bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
    expect(await service.evaluateRules('nope', {})).toMatchObject({ ok: false });
    expect(await service.evaluateRules(stateId, { budget: 1 })).toMatchObject({
      ok: false,
      error: { code: 'budget_exceeded' },
    });
  });
});

describe('the HTTP routes of migrate and evaluateRules', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('serve both calls and say what they offer', async () => {
    const service = enabled([toV2]);
    running = await listen({ service });
    const post = (path: string, body: unknown) =>
      fetch(`${running!.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const m = await post('/v1/authority/documents/doc-1/migrate', { content: older(), target: 2 });
    expect(m.status).toBe(200);
    const body = (await m.json()) as { cdm: number; steps: string[]; contentHash: string };
    expect(body).toMatchObject({ cdm: 2, steps: [toV2.name] });
    const direct = await service.migrate({ content: older(), target: 2 });
    expect(direct.ok && body.contentHash).toBe(direct.ok && direct.contentHash);

    const bad = await post('/v1/authority/documents/doc-1/migrate', {
      content: older(),
      target: 5,
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'unsupported_cdm' });

    const c = positive.find((p) => p.id === 'rules.spec-example.married')!;
    const { stateId } = await openDocument(service, documentOf(c));
    const e = await post(`/v1/authority/states/${stateId}/evaluate-rules`, { roles: [] });
    expect(e.status).toBe(200);
    expect(((await e.json()) as { ok: boolean }).ok).toBe(true);
    const gone = await post(`/v1/authority/states/${'1'.repeat(64)}/evaluate-rules`, {});
    expect(gone.status).toBe(404);

    const caps = (await (await fetch(`${running.url}/v1/authority/capabilities`)).json()) as {
      calls: string[];
      features: string[];
    };
    expect(caps.calls).toEqual(['open', 'materialise', 'applyCommit', 'migrate', 'evaluateRules']);
    expect(caps.features).toContain('rules');
  });
});

describe('the node type of the helper', () => {
  it('is JSON', () => {
    const n: JsonNode = baseEnvelope().doc;
    expect(n.type).toBe('doc');
  });
});
