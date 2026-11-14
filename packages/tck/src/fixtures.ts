/**
 * The golden fixtures the kit ships and runs (PRO-110), read through the packages that own them, so
 * that the kit never keeps a second copy: the step semantics of the engine (`@docedit/authority`,
 * SYN-002), the capabilities per role, policy and grant (PRM-005), the canonical forms and their
 * hashes (`@docedit/model`, CDM-011), and the kit's own message fixtures (generated from the
 * protocol definition by scripts/generate.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as unknown;
}

/** A file of the authority package, found through the package's resolution. */
export function authorityFile(path: string): URL {
  return new URL(`../${path}`, import.meta.resolve('@docedit/authority'));
}

/** A file of the model package's exported fixtures. */
export function modelFile(path: string): URL {
  return new URL(import.meta.resolve(`@docedit/model/fixtures/${path}`));
}

/** A file of the kit's own fixtures. */
export function kitFile(path: string): URL {
  return new URL(`../fixtures/${path}`, import.meta.url);
}

export interface CapabilityCase {
  id: string;
  name: string;
  role: 'viewer' | 'commenter' | 'suggester' | 'filler' | 'editor' | 'owner';
  policy: 'inherit' | 'restricted' | 'confidential';
  grants: Array<{
    principal: string;
    role: 'viewer' | 'commenter' | 'suggester' | 'editor';
    expiresAt: number | null;
  }>;
  documentState: 'active' | 'locked' | 'archived';
  workflowActive: boolean;
  regionState: 'draft' | 'in_review' | 'approved';
  leaseHolder: string | null;
  expected: {
    body: string[];
    doc: string[];
    defs: string[];
    story: string[];
    region: string[];
    fill: boolean;
  };
}

export interface CapabilityFixtures {
  user: { sub: string; groups: string[]; participantRoles: string[]; participantActive: boolean };
  region: string;
  now: number;
  capabilityOrder: string[];
  cases: CapabilityCase[];
}

/** `packages/authority/fixtures/capabilities.json` (PRM-005). */
export function capabilityFixtures(): CapabilityFixtures {
  return readJson(authorityFile('fixtures/capabilities.json')) as CapabilityFixtures;
}

export interface EngineDefinition {
  engine: string;
  library: { name: string; version: string };
  alsoPinned: Array<{ name: string; version: string }>;
  schema: { cdm: number; artifact: string; sha256: string };
  stepTypes: string[];
  fixtures: { apply: string; map: string; rebase: string };
}

/** `packages/authority/fixtures/engine/pm-steps-1.json` (SYN-002). */
export function engineDefinition(): EngineDefinition {
  return readJson(authorityFile('fixtures/engine/pm-steps-1.json')) as EngineDefinition;
}

export interface ApplyCase {
  id: string;
  doc: string;
  steps: Array<Record<string, unknown>>;
  expected: { ok: true; doc: unknown; docSha256: string } | { ok: false; failedStep: number };
}

export interface EngineFixture<C> {
  engine: string;
  kind: string;
  library: Record<string, string>;
  docs: Record<string, unknown>;
  cases: C[];
}

export function engineFixture<C = ApplyCase>(kind: 'apply' | 'map' | 'rebase'): EngineFixture<C> {
  const def = engineDefinition();
  return readJson(authorityFile(`fixtures/engine/${def.fixtures[kind]}`)) as EngineFixture<C>;
}

export interface CanonicalCase {
  name: string;
  kind: 'envelope' | 'node';
  rules: string[];
  input: string;
  expected: string;
  sha256: string;
}

/** `packages/model/fixtures/canonical/` (CDM-011): inputs, canonical bytes and SHA-256. */
export function canonicalFixtures(): Array<
  CanonicalCase & { inputValue: unknown; expectedText: string }
> {
  const index = readJson(modelFile('canonical/index.json')) as { cases: CanonicalCase[] };
  return index.cases.map((c) => ({
    ...c,
    inputValue: readJson(modelFile(`canonical/${c.input}`)),
    expectedText: readFileSync(fileURLToPath(modelFile(`canonical/${c.expected}`)), 'utf8'),
  }));
}

/** A JSON file of the kit's fixtures. */
export function kitFixture<T = unknown>(path: string): T {
  return readJson(kitFile(path)) as T;
}
