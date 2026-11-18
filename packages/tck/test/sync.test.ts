// PRO-117: the prose of 05, the machine-readable artifacts in spec/dep and the kit's scenarios are
// kept in step (05 §1 rule 7, §11). The artifact half reads the tables of 05 §5 to §7 and compares
// them with the published registry, AsyncAPI and OpenAPI files both ways; the scenario half fails
// the build for any message type, optional payload member, route, close code, error code or
// notification type that no scenario exercises and that is not on the named pending list.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEP1 } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { optionalMembers } from '../src/coverage.ts';
import { PROFILES } from '../src/profiles/index.ts';
import { PROVOKED } from '../src/profiles/registry.ts';
import { PENDING } from './pending.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const text = (p: string) => readFileSync(join(root, p), 'utf8');
const json = (p: string) => JSON.parse(text(p)) as Record<string, unknown>;

const p05 = text('docs/spec/05-protocol.md');
const registry = json('spec/dep/dep-1.registry.json') as {
  messages: Array<{ t: string; direction: string }>;
  operations: Array<{ method: string; path: string; owner?: string; feature?: string }>;
  errors: Array<{ code: string }>;
  closeCodes: Array<{ code: number }>;
  notifications: Array<{ type: string }>;
  webhooks: Array<{ type: string }>;
  features: Array<{ name: string }>;
};
const asyncapi = json('spec/dep/dep-1.asyncapi.json') as {
  components: { messages: Record<string, { name: string; 'x-dep-direction': string }> };
};
const openapi = json('spec/dep/dep-1.openapi.json') as {
  paths: Record<string, Record<string, unknown>>;
};

function section(doc: string, heading: string): string {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`no section ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function rows(t: string): string[][] {
  return t
    .split(/\r?\n/)
    .filter((l) => l.startsWith('|'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    )
    .filter(
      (cells, i, all) =>
        !/^-+$/.test(cells[0] ?? '') && !(all[i + 1] && /^-+$/.test(all[i + 1]![0] ?? '')),
    );
}

const code = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const DIR: Record<string, string> = { 'C to S': 'c2s', 'S to C': 's2c', both: 'both' };

/** One difference, naming the prose section and the artifact entry (PRO-117 criterion 3). */
const diff = (sectionName: string, entry: string, where: string) =>
  `${sectionName}: ${entry} ${where}`;

describe('the prose of 05 against the published artifacts (PRO-117 criteria 1 and 3)', () => {
  it('has the same message types and directions as the registry and the AsyncAPI document', () => {
    const prose = new Map<string, string>();
    for (const h of ['### 5.1 Session', '### 5.2 Channels', '### 5.3 Sync', '### 5.4 Presence'])
      for (const [names, dir] of rows(section(p05, h)))
        for (const t of code(names!)) prose.set(t, DIR[dir!]!);
    for (const h of ['### 5.5 Permissions', '### 5.6 Notifications'])
      for (const m of section(p05, h).matchAll(/`([a-z.]+)` \((C to S|S to C)\)/g))
        prose.set(m[1]!, DIR[m[2]!]!);
    const reg = new Map(registry.messages.map((m) => [m.t, m.direction]));
    const asy = new Map(
      Object.values(asyncapi.components.messages).map((m) => [m.name, m['x-dep-direction']]),
    );
    const problems: string[] = [];
    for (const [t, dir] of prose) {
      if (reg.get(t) !== dir)
        problems.push(
          diff(
            '05 §5',
            `message ${t} (${dir})`,
            `is ${reg.get(t) ?? 'missing'} in dep-1.registry.json`,
          ),
        );
      if (asy.get(t) !== dir)
        problems.push(
          diff(
            '05 §5',
            `message ${t} (${dir})`,
            `is ${asy.get(t) ?? 'missing'} in dep-1.asyncapi.json`,
          ),
        );
    }
    // 12 §10 adds `wf.changed`; every other artifact message is in the prose of 05.
    for (const t of reg.keys())
      if (!prose.has(t) && t !== 'wf.changed')
        problems.push(diff('05 §5', `message ${t} of dep-1.registry.json`, 'is not in the prose'));
    expect(problems).toEqual([]);
  });

  it('has the same close codes, error codes and notification types', () => {
    const problems: string[] = [];
    const close = rows(section(p05, '### 5.7 Close codes')).map((r) => Number(r[0]));
    const regClose = registry.closeCodes.map((c) => c.code);
    for (const c of close)
      if (!regClose.includes(c))
        problems.push(diff('05 §5.7', `close code ${c}`, 'is missing from dep-1.registry.json'));
    for (const c of regClose)
      if (!close.includes(c))
        problems.push(
          diff('05 §5.7', `close code ${c} of dep-1.registry.json`, 'is not in the prose'),
        );
    const errors = rows(section(p05, '### 5.8 Error registry')).flatMap((r) => code(r[0]!));
    const regErrors = registry.errors.map((e) => e.code);
    for (const e of errors)
      if (!regErrors.includes(e))
        problems.push(diff('05 §5.8', `error ${e}`, 'is missing from dep-1.registry.json'));
    for (const e of regErrors)
      if (!errors.includes(e))
        problems.push(diff('05 §5.8', `error ${e} of dep-1.registry.json`, 'is not in the prose'));
    const types = code(section(p05, '### 5.6 Notifications').match(/Types: (.*)\./)![1]!);
    const regTypes = registry.notifications.map((n) => n.type);
    for (const t of types)
      if (!regTypes.includes(t))
        problems.push(diff('05 §5.6', `notification ${t}`, 'is missing from dep-1.registry.json'));
    for (const t of regTypes)
      if (!types.includes(t))
        problems.push(
          diff('05 §5.6', `notification ${t} of dep-1.registry.json`, 'is not in the prose'),
        );
    expect(problems).toEqual([]);
  });

  it('has the same resources and methods as the OpenAPI document, and the same webhook events', () => {
    const problems: string[] = [];
    const prose = rows(section(p05, '### 6.2 Resources')).flatMap(([paths, methods]) =>
      code(paths!).flatMap((p) => methods!.split(/,\s*/).map((m) => `${m} ${p}`)),
    );
    const published = Object.entries(openapi.paths).flatMap(([p, ops]) =>
      Object.keys(ops)
        .filter((k) => /^(get|post|put|patch|delete)$/.test(k))
        .map((m) => `${m.toUpperCase()} ${p}`),
    );
    const frw = new Set(
      registry.operations.filter((o) => o.owner === 'FRW').map((o) => `${o.method} ${o.path}`),
    );
    // G100: the webhooks row gives four methods to two paths at once.
    const g100 = ['PATCH /webhooks', 'DELETE /webhooks', 'POST /webhooks/{id}'];
    for (const r of prose)
      if (!published.includes(r) && !g100.includes(r))
        problems.push(diff('05 §6.2', r, 'is missing from dep-1.openapi.json'));
    for (const r of published)
      if (!prose.includes(r) && !frw.has(r) && r !== 'GET /.well-known/dep')
        problems.push(diff('05 §6.2', `${r} of dep-1.openapi.json`, 'is not in the prose'));
    const events = rows(section(p05, '## 7. Events plane'))
      .flatMap((r) => code(r[0]!))
      .filter((n) => n.startsWith('dep.'))
      .map((n) => `${n}.v1`);
    // 05 §7 names the workflow events too (FRW-036 criterion 5), so none is left out here.
    const regHooks = registry.webhooks.map((w) => w.type);
    for (const e of events)
      if (!regHooks.includes(e))
        problems.push(diff('05 §7', `webhook ${e}`, 'is missing from dep-1.registry.json'));
    for (const e of regHooks)
      if (!events.includes(e))
        problems.push(diff('05 §7', `webhook ${e} of dep-1.registry.json`, 'is not in the prose'));
    expect(problems).toEqual([]);
  });
});

/** Everything the artifacts define, as `<kind> <name>` entries. */
function artifactEntries(): string[] {
  const optional = optionalMembers();
  return [
    ...registry.messages.map((m) => `message ${m.t}`),
    ...[...optional].flatMap(([t, ms]) => ms.map((m) => `field ${t}.${m}`)),
    ...registry.operations.map((o) => `operation ${o.method} ${o.path}`),
    ...registry.closeCodes.map((c) => `close ${c.code}`),
    ...registry.errors.map((e) => `error ${e.code}`),
    ...registry.notifications.map((n) => `event ${n.type}`),
  ];
}

/** Everything some scenario declares it exercises. */
function covered(): Set<string> {
  const out = new Set<string>();
  for (const p of PROFILES)
    for (const s of p.scenarios) {
      const c = s.covers;
      for (const m of c.messages ?? []) out.add(`message ${m}`);
      for (const f of c.fields ?? []) out.add(`field ${f}`);
      for (const o of c.operations ?? []) out.add(`operation ${o}`);
      for (const k of c.closeCodes ?? []) out.add(`close ${k}`);
      for (const e of c.errors ?? []) out.add(`error ${e}`);
      for (const e of c.events ?? []) out.add(`event ${e}`);
    }
  for (const p of PROVOKED) if (!p.unreachable) out.add(`error ${p.code}`);
  return out;
}

describe('every row of the authorisation matrix has a scenario or a reason (PRO-115 criterion 4)', () => {
  // Rows whose routes belong to features of later phases: their negative tests arrive with them.
  const LATER: Record<string, string> = {
    'thread.create': 'comments (PRO-120)',
    'thread.update': 'comments (PRO-120)',
    'asset.upload': 'assets (PRO-114)',
    'asset.read': 'assets: no route yet (G72)',
    'version.create': 'history (PRO-119)',
    'restore.region': 'history (PRO-119)',
    'lease.acquire': 'leases (PRO-122)',
  };
  const written = ['read.head', 'read.history', 'commit', 'manage', 'export', 'service'];

  it('fails when a row is added to the matrix without a scenario', async () => {
    const { MATRIX } = await import('@docedit/authority');
    const matrix = json('spec/permissions/permissions-1.json') as { matrix: Array<{ id: string }> };
    expect(MATRIX.map((r) => r.id)).toEqual(matrix.matrix.map((r) => r.id));
    const authz = PROFILES.find((p) => p.id === 'authz')!.scenarios.map((s) =>
      s.id.replace(/^authz\./, ''),
    );
    for (const r of MATRIX) {
      expect(
        written.includes(r.id) || r.id in LATER,
        `row ${r.id} has no scenario and no reason`,
      ).toBe(true);
      expect(authz, r.id).toContain(r.id);
    }
  });
});

describe('the fields artifacts the kit checks (FRW-067 criterion 3)', () => {
  it('publishes form_field and role_def, the field routes and the fill reject codes', () => {
    const cdm = text('spec/cdm/cdm-1.schema.json');
    for (const n of ['form_field', 'role_def']) expect(cdm, n).toContain(`"${n}"`);
    for (const p of ['/documents/{id}/fields', '/documents/{id}/field-values'])
      expect(Object.keys(openapi.paths), p).toContain(p);
    const reject = JSON.stringify(json('spec/dep/dep-1.asyncapi.json')['components']);
    for (const c of ['permission_denied', 'field_invalid', 'conflict'])
      expect(reject, c).toContain(`"${c}"`);
    expect(registry.features.map((f) => f.name)).toEqual(
      expect.arrayContaining(['fields', 'rules', 'workflow', 'sign', 'seal']),
    );
    const fields = PROFILES.find((p) => p.id === 'fields')!;
    expect(fields.requires).toEqual({ kind: 'features', features: ['fields'] });
  });
});

describe('every artifact entry has a kit scenario (PRO-117 criteria 2 and 4)', () => {
  const entries = artifactEntries();
  const have = covered();

  it('fails for an entry that no scenario exercises and that is not pending with a reason', () => {
    const missing = entries.filter((e) => !have.has(e) && !(e in PENDING));
    expect(missing, 'add a scenario, or a reason to test/pending.ts').toEqual([]);
  });

  it('keeps the pending list honest: no pending entry has a scenario, and every one exists', () => {
    expect(
      Object.keys(PENDING).filter((e) => have.has(e)),
      'covered now: remove from test/pending.ts',
    ).toEqual([]);
    expect(
      Object.keys(PENDING).filter((e) => !entries.includes(e)),
      'not in the artifacts: remove from test/pending.ts',
    ).toEqual([]);
    for (const [e, why] of Object.entries(PENDING)) expect(why.length, e).toBeGreaterThan(5);
  });

  it('does not let a definition be final while anything is pending (05 §1 rule 7)', () => {
    if (DEP1.status === 'final') expect(Object.keys(PENDING)).toEqual([]);
    else expect(DEP1.status).toBe('draft');
  });

  it('names what each scenario covers only with entries of the artifacts', () => {
    const known = new Set(entries);
    expect(
      [...have].filter((e) => !known.has(e)),
      'a declared coverage that is not in the artifacts',
    ).toEqual([]);
  });
});
