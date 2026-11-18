// The prose against the definition, read from the Markdown itself (a first version of the artifact
// check of PRO-117, written for S6): every message type, close code, error code, notification type,
// resource and method, and webhook event in the tables of 05 §5 to §7 and 12 §10 is defined, and
// every definition is in the prose. Exceptions are named with the gap that explains them.
import { describe, expect, it } from 'vitest';
import { DEP1 } from '../src/definition/index.ts';
import { webhookType } from '../src/definition/events.ts';
import { readText } from './support.ts';

const p05 = readText('docs/spec/05-protocol.md');
const p12 = readText('docs/spec/12-fields-rules-workflow.md');

/** The text of a section, from its heading to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`no section ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The cells of the body rows of every table in a text. */
function rows(text: string): string[][] {
  return text
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

const code = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const DIR: Record<string, 'c2s' | 's2c' | 'both'> = {
  'C to S': 'c2s',
  'S to C': 's2c',
  both: 'both',
};

function proseMessages(): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of ['### 5.1 Session', '### 5.2 Channels', '### 5.3 Sync', '### 5.4 Presence'])
    for (const [names, dir] of rows(section(p05, h)))
      for (const t of code(names!)) out.set(t, DIR[dir!]!);
  for (const h of ['### 5.5 Permissions', '### 5.6 Notifications'])
    for (const m of section(p05, h).matchAll(/`([a-z.]+)` \((C to S|S to C)\)/g))
      out.set(m[1]!, DIR[m[2]!]!);
  for (const m of section(p12, '## 10. Protocol additions').matchAll(
    /`([a-z.]+)` \((C to S|S to C)\)/g,
  ))
    out.set(m[1]!, DIR[m[2]!]!);
  return out;
}

describe('the prose of 05 and 12 §10 against the definition', () => {
  it('has the same message types, with the same directions', () => {
    const prose = proseMessages();
    const defined = new Map(DEP1.messages.map((m) => [m.t, m.dir]));
    // The revision of 2026-11-06 added `auth.ok` to the session table (G19, resolved).
    expect([...defined.keys()].filter((t) => !prose.has(t))).toEqual([]);
    expect([...prose.keys()].filter((t) => !defined.has(t))).toEqual([]);
    for (const [t, dir] of prose) expect(defined.get(t), t).toBe(dir);
  });

  it('has the same close codes (05 §5.7)', () => {
    const prose = rows(section(p05, '### 5.7 Close codes')).map((r) => Number(r[0]));
    expect(DEP1.closeCodes.map((c) => c.code)).toEqual(prose);
  });

  it('has the same error codes (05 §5.8)', () => {
    const prose = rows(section(p05, '### 5.8 Error registry')).flatMap((r) => code(r[0]!));
    expect(DEP1.errors.map((e) => e.code).sort()).toEqual([...prose].sort());
    expect(new Set(prose).size).toBe(prose.length);
  });

  it('has the same notification types (05 §5.6)', () => {
    const types = section(p05, '### 5.6 Notifications').match(/Types: (.*)\./)![1]!;
    expect(DEP1.notifications.map((n) => n.type).sort()).toEqual(code(types).sort());
  });

  it('has the same resources and methods (05 §6.2), plus discovery (05 §2) and 12 §10', () => {
    const prose = rows(section(p05, '### 6.2 Resources')).flatMap(([paths, methods]) =>
      code(paths!).flatMap((path) => methods!.split(/,\s*/).map((m) => `${m} ${path}`)),
    );
    const defined = DEP1.operations
      .filter((o) => o.owner !== 'FRW')
      .map((o) => `${o.method} ${o.path}`);
    expect([...defined].filter((r) => !prose.includes(r))).toEqual(['GET /.well-known/dep']);
    // The webhooks row gives four methods to two paths at once (G100).
    expect(prose.filter((r) => !defined.includes(r))).toEqual([
      'PATCH /webhooks',
      'DELETE /webhooks',
      'POST /webhooks/{id}',
    ]);
    // 12 §10 names its paths in one table cell; each defined FRW route is among them (the rest are G95, G96).
    const frwCell = rows(section(p12, '## 10. Protocol additions')).find(
      (r) => r[0] === 'Control plane',
    )![1]!;
    const listed = code(frwCell);
    for (const o of DEP1.operations.filter((x) => x.owner === 'FRW')) {
      // 12 §10 writes `/workflow/participants/{pid}/consent`, then bare `/verify`, `/complete`, `/decline`.
      const tail = o.path.replace(/^\/documents\/\{id\}/, '');
      const last = `/${o.path.split('/').pop()!}`;
      expect(
        listed.includes(o.path) || listed.includes(tail) || listed.includes(last),
        o.path,
      ).toBe(true);
    }
  });

  it('has the same webhook events (05 §7, 12 §10), each with its version suffix', () => {
    const p7 = rows(section(p05, '## 7. Events plane'))
      .flatMap((r) => code(r[0]!))
      .filter((n) => n.startsWith('dep.'));
    const row = rows(section(p12, '## 10. Protocol additions')).find(
      (r) => r[0] === 'Webhooks',
    )![1]!;
    // 12 §10 writes the first name in full and the rest bare (G85): decision D17 completes them.
    const p12names = code(row).map((n) => (n.startsWith('dep.') ? n : `dep.workflow.${n}`));
    expect(DEP1.webhooks.map(webhookType).sort()).toEqual(
      [...p7, ...p12names].map((n) => `${n}.v1`).sort(),
    );
  });

  it('carries the read-restriction members of ADR 0019 in the prose and the definition (PRO-130 criterion 5)', () => {
    // The generated schema is built from the definition (`pnpm generate`); read its members.
    const schema = JSON.parse(readText('spec/dep/dep-1.schema.json')) as {
      $defs: Record<
        string,
        { properties: Record<string, { properties?: Record<string, unknown> }> }
      >;
    };
    const props = (name: string) => schema.$defs[name]!.properties;
    const members = (t: string) =>
      Object.keys(props(t === 'ch.opened' ? 'ChannelOpened' : 'ChannelClosed'));
    expect(Object.keys(props('Resume'))).toContain('view');
    expect(readText('spec/cdm/cdm-1.projection.json')).toContain('hidden_region');
    // The prose names each member that the definition has, and the definition has each the prose names.
    const channels = section(p05, '### 5.2 Channels');
    expect(members('ch.opened')).toContain('view');
    expect(channels).toMatch(/`ch\.opened`[^\n]*optional `view`/);
    expect(channels).toMatch(
      /`ch\.open`[^\n]*`resume` \(`seq`, `incarnation`, `inflight`, optional `view`\)/,
    );
    expect(members('ch.closed')).toContain('cause');
    expect(channels).toMatch(/`ch\.closed`[^\n]*optional `cause`[^\n]*`access_changed`/);
    for (const known of ['access_changed', 'fenced', 'lost', 'stopped'])
      expect(channels, known).toContain(`\`${known}\``);
    expect(channels).toContain('`resume.view`');
    expect(channels).toContain('answered with `catchUp: "reload"`');
    const sync = section(p05, '### 5.3 Sync');
    expect(sync).toMatch(/may be empty/);
    expect(sync).toMatch(/`rebased: true`/);
    expect(section(p05, '### 6.2 Resources')).toMatch(
      /`GET \/documents\/\{id\}\/content`|`\/documents\/\{id\}\/content`[^\n]*view/,
    );
    expect(DEP1.features.map((f) => f.name)).toContain('read-restrictions');
    expect(section(p05, '## 2. Discovery')).toContain('"read-restrictions"');
  });

  it('has the features of 05 §2 and 12 §10', () => {
    const discovery = section(p05, '## 2. Discovery')
      .match(/"features": \[([^\]]*)\]/)![1]!
      .match(/"([^"]+)"/g)!
      .map((s) => s.slice(1, -1));
    const p12f = code(
      rows(section(p12, '## 10. Protocol additions')).find((r) => r[0] === 'Features')![1]!,
    );
    const defined = DEP1.features.map((f) => f.name);
    for (const f of [...discovery, ...p12f]) expect(defined, f).toContain(f);
  });
});
