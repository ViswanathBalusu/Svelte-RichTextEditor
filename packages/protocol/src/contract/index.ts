/**
 * `@docedit/protocol/contract`: the reusable port contract suite (PRO-098 first version, S6) and
 * the smoke suite for the `core` profile. Runner-neutral: a runner registers each case and passes a
 * context with `skip`. Example with Vitest:
 *
 *   for (const k of portContract(factory, { sleep })) it(k.id, (ctx) => k.run({ skip: (r) => ctx.skip(r) }));
 *
 * The suite imports only the port typings and the harness interface, never an implementation.
 */
import { type ContractCase, CORE_MEMBERS, coreCases } from './core.ts';
import type { ContractOptions, HarnessFactory } from './harness.ts';
import { OPTIONAL_MEMBERS, optionalCases } from './optional.ts';
import { coreSmoke } from './smoke-core.ts';

export type { ContractCase } from './core.ts';
export type {
  CaseContext,
  ContractHarness,
  ContractOptions,
  ContractUser,
  GrantSpec,
  HarnessFactory,
  WriteHold,
} from './harness.ts';
export { CORE_MEMBERS, LIMIT_NAMES } from './core.ts';
export { OPTIONAL_MEMBERS } from './optional.ts';
export { ContractFailure } from './assert.ts';
export { contractDocument, importedDocument, IDS, USERS, posIn } from './fixtures.ts';

/** Every contract case: the core ports, then the optional ports. */
export function portContract(factory: HarnessFactory, opts: ContractOptions): ContractCase[] {
  return [...coreCases(factory, opts), ...optionalCases(factory, opts)];
}

export { coreSmoke };

/** Port members that no case exercises; empty when every member has at least one case. */
export function uncoveredMembers(cases: readonly ContractCase[]): string[] {
  const covered = new Set(cases.flatMap((c) => c.members));
  const all = [
    ...CORE_MEMBERS,
    ...Object.entries(OPTIONAL_MEMBERS).flatMap(([p, ms]) => ms.map((m) => `${p}.${m}`)),
  ];
  return all.filter((m) => !covered.has(m));
}
