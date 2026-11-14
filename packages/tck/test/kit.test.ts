// The kit's own unit tests: the golden fixtures it ships (PRO-110), its independent RFC 8785
// implementation, the selection of profiles (PRO-108), the leak oracle (PRO-131) and the rule that
// the kit uses only public interfaces (PRO-108 criterion 4).
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEP1, depCodec } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import {
  canonicalFixtures,
  capabilityFixtures,
  engineDefinition,
  engineFixture,
  kitFile,
} from '../src/fixtures.ts';
import { formatted } from '../scripts/format.ts';
import { jcs, sha256Hex } from '../src/jcs.ts';
import { LeakOracle } from '../src/profiles/perm-read.ts';
import { PROFILES } from '../src/profiles/index.ts';
import { renderText, type KitReport } from '../src/report.ts';
import { notApplicable } from '../src/runner.ts';
import { resolveConfig } from '../src/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');

describe('golden message fixtures (PRO-110 criterion 1)', () => {
  it('equal a fresh generation from the protocol definition', async () => {
    for (const f of await formatted()) {
      const path = join(pkg, f.path);
      expect(
        existsSync(path),
        `${f.path} is missing; run pnpm --filter @docedit/tck generate`,
      ).toBe(true);
      expect(
        readFileSync(path, 'utf8'),
        `${f.path} is stale; run pnpm --filter @docedit/tck generate`,
      ).toBe(f.text);
    }
  });

  it('give every message type a valid and an invalid frame, and the codec agrees with each', () => {
    const file = JSON.parse(
      readFileSync(fileURLToPath(kitFile('messages/messages.json')), 'utf8'),
    ) as {
      messages: Array<{
        t: string;
        dir: string;
        valid: Array<{ frame: Record<string, unknown> }>;
        invalid: Array<{ name: string; frame: Record<string, unknown>; fatal: boolean }>;
      }>;
    };
    const codec = depCodec();
    expect(file.messages.map((m) => m.t).sort()).toEqual(DEP1.messages.map((m) => m.t).sort());
    for (const m of file.messages) {
      const receiver = m.dir === 's2c' ? 'client' : 'server';
      expect(m.valid.length, m.t).toBeGreaterThan(0);
      expect(m.invalid.length, m.t).toBeGreaterThan(0);
      for (const v of m.valid) {
        expect(codec.check(v.frame), `${m.t} valid`).toEqual([]);
        expect(codec.decode(JSON.stringify(v.frame), { receiver }).kind, `${m.t} decodes`).toBe(
          'message',
        );
      }
      for (const v of m.invalid) {
        const r = codec.decode(JSON.stringify(v.frame), { receiver });
        expect(r.kind, `${m.t}: ${v.name}`).toBe('invalid');
        if (r.kind === 'invalid') expect(r.fatal, `${m.t}: ${v.name} fatal (D03)`).toBe(v.fatal);
      }
    }
  });

  it('hold the 05 §5.9 conversation in the order of the example', () => {
    const c = JSON.parse(
      readFileSync(fileURLToPath(kitFile('messages/conversation.json')), 'utf8'),
    ) as { frames: Array<{ from: string; frame?: { t: string } }> };
    expect(c.frames.filter((f) => f.frame).map((f) => f.frame!.t)).toEqual([
      'hello',
      'welcome',
      'ch.open',
      'ch.opened',
      'sync.commit',
      'sync.caughtUp',
      'sync.submit',
      'sync.ack',
      'sync.commit',
      'perm.changed',
      'sync.submit',
      'sync.reject',
    ]);
  });
});

describe('canonical-hash fixtures through an independent RFC 8785 implementation (PRO-110 criterion 3)', () => {
  it('reproduces the bytes and the SHA-256 of every CDM-011 case', () => {
    const cases = canonicalFixtures();
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect(jcs(JSON.parse(c.expectedText)), c.name).toBe(c.expectedText);
      expect(sha256Hex(c.expectedText), c.name).toBe(c.sha256);
    }
  });

  it('reproduces the document hash of every engine fixture that applies (SYN-002)', () => {
    const apply = engineFixture('apply');
    let n = 0;
    for (const c of apply.cases)
      if (c.expected.ok) {
        expect(sha256Hex(jcs(c.expected.doc)), c.id).toBe(c.expected.docSha256);
        n++;
      }
    expect(n).toBeGreaterThan(10);
  });
});

describe('step-semantics fixtures of the pinned release (PRO-110 criteria 2 and 4)', () => {
  it('are read through the authority package, with apply, map and rebase cases', () => {
    const def = engineDefinition();
    expect(def.engine).toBe('pm-steps/1');
    for (const kind of ['apply', 'map', 'rebase'] as const) {
      const f = engineFixture(kind);
      expect(f.engine, kind).toBe(def.engine);
      expect(f.cases.length, kind).toBeGreaterThan(10);
    }
  });

  it('name the installed release of prosemirror-transform, or a new engine identifier', () => {
    const def = engineDefinition();
    const require = createRequire(import.meta.resolve('@docedit/authority'));
    let dir = dirname(require.resolve('prosemirror-transform'));
    while (
      !existsSync(join(dir, 'package.json')) ||
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== 'prosemirror-transform'
    )
      dir = dirname(dir);
    const installed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version as string;
    // A release that changes any fixture output is a new engine identifier (04 §4): the kit refuses
    // to certify against fixtures of another release under the same identifier.
    if (installed !== def.library.version) expect(def.engine).not.toBe('pm-steps/1');
    else expect(def.library.version).toBe(installed);
  });

  it('ship the capability fixtures of every role, policy and grant (PRM-005)', () => {
    const fx = capabilityFixtures();
    expect(new Set(fx.cases.map((c) => c.role))).toEqual(
      new Set(['viewer', 'commenter', 'suggester', 'filler', 'editor', 'owner']),
    );
    expect(new Set(fx.cases.map((c) => c.policy))).toEqual(
      new Set(['inherit', 'restricted', 'confidential']),
    );
  });
});

describe('profile selection (PRO-108 criterion 3)', () => {
  const target = (features: string[], mode: 'authority' | 'relay' = 'authority') => ({
    discovery: { mode } as never,
    features: new Set(features),
    config: resolveConfig({ discovery: 'http://x', credential: 'c', testMode: false }),
  });
  const byId = (id: string) => PROFILES.find((p) => p.id === id)!;

  it('runs a profile only when its features are announced, and says why it skips one', () => {
    expect(notApplicable(byId('presence'), target(['presence']))).toBeNull();
    expect(notApplicable(byId('presence'), target([]))).toMatch(/does not announce `presence`/);
    expect(notApplicable(byId('perm-region'), target(['regions']))).toBeNull();
    expect(notApplicable(byId('fields'), target(['regions']))).toMatch(/fields/);
    expect(notApplicable(byId('core'), target([], 'relay'))).toMatch(/authority mode/);
    expect(notApplicable(byId('perm-read'), target(['read-restrictions']))).toBeNull();
  });

  it('lists every profile of 05 §11 and 12 §10 that the kit knows', () => {
    const ids = PROFILES.map((p) => p.id);
    for (const p of [
      'core',
      'core-relay',
      'presence',
      'perm-doc',
      'perm-region',
      'perm-suggest',
      'history',
      'comments',
      'assets',
      'exports',
      'webhooks',
      'leases',
      'authority-service',
      'fields',
      'perm-fill',
      'perm-read',
    ])
      expect(ids, p).toContain(p);
    const scenarioIds = PROFILES.flatMap((p) => p.scenarios.map((s) => s.id));
    expect(new Set(scenarioIds).size, 'scenario identifiers are unique').toBe(scenarioIds.length);
    for (const p of PROFILES)
      for (const s of p.scenarios) expect(s.id.startsWith(`${p.id}.`), s.id).toBe(true);
  });

  it('renders a report with every profile and scenario, machine- and human-readable (PRO-108 criterion 5)', () => {
    const report: KitReport = {
      kit: { name: '@docedit/tck', version: '0', protocol: '1.0' },
      target: {
        discovery: 'http://x/.well-known/dep',
        mode: 'authority',
        versions: ['1.0'],
        features: ['presence'],
      },
      testMode: false,
      seeds: { fuzz: 1, property: 2 },
      startedAt: 'a',
      finishedAt: 'b',
      durationMs: 1,
      ok: false,
      bootstrap: { ok: true },
      totals: { passed: 1, failed: 1, skipped: 1 },
      profiles: [
        {
          id: 'core',
          title: 'Core',
          spec: '05',
          stories: ['PRO-111'],
          outcome: 'failed',
          counts: { passed: 1, failed: 1, skipped: 1 },
          scenarios: [
            {
              id: 'core.a',
              profile: 'core',
              title: 'a',
              spec: '05',
              outcome: 'passed',
              durationMs: 1,
              notes: [],
            },
            {
              id: 'core.b',
              profile: 'core',
              title: 'b',
              spec: '05',
              outcome: 'failed',
              durationMs: 1,
              notes: [],
              failure: { message: 'm', expected: 'e', received: 'r' },
            },
            {
              id: 'core.c',
              profile: 'core',
              title: 'c',
              spec: '05',
              outcome: 'skipped',
              reason: 'why',
              durationMs: 0,
              notes: [],
            },
          ],
        },
      ],
    };
    const text = renderText(report);
    for (const s of ['core.a', 'core.b', 'core.c', 'expected: e', 'received: r', '(why)', 'FAIL'])
      expect(text).toContain(s);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('the leak oracle of perm-read (PRO-131)', () => {
  it('finds a canary wherever it appears and nothing otherwise', () => {
    const o = new LeakOracle(['CANARY1', 'CANARY2']);
    o.scan('reader', 'websocket', '{"t":"sync.commit","d":{"x":"no secret here"}}');
    expect(() => o.assertClean()).not.toThrow();
    o.scan('reader', 'GET /content', '{"doc":{"text":"…CANARY2…"}}');
    expect(() => o.assertClean()).toThrow(/hidden content reached a reader/);
    expect(o.leaks[0]).toMatchObject({ reader: 'reader', canary: 'CANARY2' });
  });
});

describe('the kit uses public interfaces only (PRO-108 criterion 4)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) =>
      statSync(join(dir, f)).isDirectory()
        ? files(join(dir, f))
        : f.endsWith('.ts')
          ? [join(dir, f)]
          : [],
    );

  it('imports no code of the component, of a server or of a database', () => {
    const allowed =
      /^(node:.*|ws|fast-check|@docedit\/protocol(\/contract)?|@docedit\/model(\/validate|\/prosemirror|\/definition)?|@docedit\/authority|\.{1,2}\/.*)$/;
    for (const f of files(join(pkg, 'src'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(
        /(?:import|export)[^'"]*from\s+'([^']+)'|import\('([^']+)'\)/g,
      )) {
        const spec = m[1] ?? m[2]!;
        expect(allowed.test(spec), `${relative(pkg, f)} imports ${spec}`).toBe(true);
      }
      expect(/DATABASE_URL|postgres/i.test(text), `${relative(pkg, f)} mentions a database`).toBe(
        false,
      );
    }
  });
});
