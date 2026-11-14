// CDM-014 criterion 4 (lane V-CDM-001-027): the Room, not only step 6 in isolation, refuses every
// failing invariant fixture of packages/model/fixtures/invariants with `invalid_op` and stores
// nothing. Each fixture is submitted as a commit to an open channel of a Room whose initial content
// is the fixture's base document; the test checks that the Room answers `sync.reject` with a reason
// that names one of the fixture's expected invariants (so step 6 refused it, not an earlier check),
// returns no write for storage, and leaves the document unchanged. Storage is the in-memory harness of the
// authority tests (MemoryStorage), which is the storage contract the Room writes through.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isUuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/codes.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { USERS, basePermissions } from './fixtures.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fixtures = resolve(import.meta.dirname, '../../model/fixtures');
const casesDir = resolve(fixtures, 'invariants/cases');
const BASES: Record<string, string> = {
  example: 'example-03-12.json',
  'kitchen-sink': 'kitchen-sink.json',
};

const cases = readdirSync(casesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve(casesDir, f), 'utf8')) as Json);

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const o = value as Json;
    if (typeof o['$repeat'] === 'string' && typeof o['count'] === 'number')
      return o['$repeat'].repeat(o['count']);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

function baseOf(f: Json): Json {
  if (typeof f['base'] !== 'string') return structuredClone(f['base']) as Json;
  const name = BASES[f['base']] ?? `${f['base']}.json`;
  return JSON.parse(readFileSync(resolve(fixtures, name), 'utf8')) as Json;
}

let clock = 1_790_000_000_000;
let counter = 0;
/** A valid UUID version 7 per submission (08 §2), so that the Room passes its id check. */
const commitId = () => `0192f0c4-7b1e-7000-9014-${(++counter).toString(16).padStart(12, '0')}`;

/**
 * Limits high enough that a fixture is never refused at step 1 (`too_large`) before step 6: the
 * canonical-size fixtures carry more than the default 1 MiB per commit (04 §3.1). The limits are the
 * deployment's; the invariants are what this criterion tests.
 */
const LIMITS = {
  ...DEFAULT_LIMITS,
  maxStepsPerCommit: 1_000_000,
  maxCommitBytes: 256 * 1024 * 1024,
};

const schema = cdmSchema();

/**
 * Submits one failing fixture to a fresh Room and returns what the Room answered. A fixture with
 * steps is a step commit from the owner's channel (`Room.submit`). A fixture with no steps is a
 * hostile stored document that no step can make; it reaches the Room as whole content, so it is
 * submitted as an import snapshot commit (`Room.snapshot`, 04 §3.2) over the valid example document,
 * and step 6 runs on that content.
 */
function submitFixture(f: Json) {
  const steps = expand(f['steps']);
  const whole = Array.isArray(steps) && steps.length === 0;
  const base = whole ? baseOf({ base: 'example' }) : baseOf(f);
  const initial = schema.nodeFromJSON(base['doc']);
  const requires = (
    whole ? base['requires'] : (f['requires'] ?? base['requires'] ?? [])
  ) as string[];
  // The fixture's context (ADR 0031 section 1) is the Room's: retired regions, attached assets and
  // the math gate, as `cdm-014.failing-fixtures.test.ts` passes them to checkInvariants.
  const c = (f['context'] ?? {}) as Json;
  const gate = c['mathGateRefuses'] as string | undefined;
  const room = new Room({
    schema,
    initial,
    requires,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-cdm-014',
    now: () => ++clock,
    limits: LIMITS,
    retiredRegionIds: (c['retiredRegionIds'] ?? []) as string[],
    ...(c['attachedAssets'] ? { attachedAssets: new Set<string>(c['attachedAssets']) } : {}),
    ...(gate !== undefined
      ? { mathGate: (latex: string) => (latex.includes(gate) ? `${gate} is not allowed` : null) }
      : {}),
  });
  room.open('c1', USERS.alice);
  const id = commitId();
  expect(isUuid7(id), 'the test must submit a UUID version 7 id').toBe(true);
  const channel = whole ? 'control' : 'c1';
  const fx: Effects = whole
    ? room.snapshot('control', {
        id,
        reason: 'import',
        content: schema.nodeFromJSON(baseOf(f)['doc']),
        checkpoint: 'cdm014-checkpoint',
        as: 'system',
      })
    : room.submit('c1', { id, base: 0, steps });
  const msgs = fx.send.filter((o) => o.channel === channel).map((o) => o.msg as ToClient);
  const reject = msgs.find((m) => m.t === 'sync.reject') as
    Extract<ToClient, { t: 'sync.reject' }> | undefined;
  return { reject, fx, initial, room };
}

describe('CDM-014 the Room refuses the failing fixtures and stores nothing', () => {
  const failing = cases.filter((c) => (c['expected'] as string[]).length > 0);

  it('reads the fixtures and finds failing ones', () => {
    expect(cases.length).toBeGreaterThanOrEqual(48);
    expect(failing.length).toBeGreaterThan(0);
  });

  it.each(failing.map((c) => [String(c['name']), c] as const))(
    '%s is rejected by the Room with invalid_op and no write is returned',
    (_name, c) => {
      const { reject, fx, initial, room } = submitFixture(c);
      expect(reject, 'the Room must answer sync.reject').toBeDefined();
      expect(reject?.code, reject?.reason).toBe('invalid_op');
      // The refusal must come from step 6, not from an earlier check: the reason names one of the
      // fixture's expected invariants and never the commit id.
      const reason = String(reject?.reason);
      expect(reason).not.toContain('UUID');
      const expected = c['expected'] as string[];
      const named = expected.filter((inv) => new RegExp(`\\b${inv}\\b`).test(reason));
      expect(
        named.length,
        `reason "${reason}" names none of ${expected.join(', ')}`,
      ).toBeGreaterThan(0);
      expect(fx.write, 'a refused commit must not reach storage').toBeNull();
      expect(room.document.eq(initial)).toBe(true);
    },
  );
});
