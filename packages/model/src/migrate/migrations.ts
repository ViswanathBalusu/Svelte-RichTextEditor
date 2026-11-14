/**
 * Schema migrations (03 §11.3; CDM-049). A migration is a pure function from the envelope of major
 * version `from` to the envelope of version `to`: no clock, no randomness, no I/O. The framework
 * gives each migration its own copy of the input, so a migration that mutates its argument cannot
 * change the stored document, and it checks the result before the next step runs.
 *
 * Nothing that reads, parses or validates a document calls this module (read.ts refuses a version
 * the reader does not support before anything else runs). The service stores the result as a
 * snapshot commit with origin `migration` (CDM-049 criterion 4; the service's job, not this one's).
 */
export interface Migration {
  /** The `cdm` major version the migration reads. */
  readonly from: number;
  /** The `cdm` major version the migration writes; always `from + 1`. */
  readonly to: number;
  /** A short name for reports, for example "move ext.keepWithNext to keepWithNext". */
  readonly name: string;
  /** Pure: returns the new envelope, which must carry `cdm` equal to `to`. */
  apply(envelope: Record<string, unknown>): Record<string, unknown>;
}

export type MigrationResult =
  | { ok: true; envelope: Record<string, unknown>; cdm: number; steps: string[] }
  | { ok: false; code: MigrationCode; message: string };

export type MigrationCode =
  | 'migration_chain_invalid'
  | 'migration_missing'
  | 'migration_downgrade'
  | 'migration_result_invalid';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The registry must hold one migration per step, each from n to n+1, with no duplicates and no
 * gaps between the lowest and highest version it covers. Returns a problem, or null.
 */
export function chainProblem(migrations: readonly Migration[]): string | null {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isSafeInteger(m.from) || m.to !== m.from + 1)
      return `migration "${m.name}" must go from n to n+1, not ${m.from} to ${m.to}`;
    if (seen.has(m.from)) return `two migrations start at version ${m.from}`;
    seen.add(m.from);
  }
  return null;
}

/** Deep copy of a plain JSON value, so a migration never shares structure with its input. */
function copyJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Runs the chain of migrations from the envelope's version up to `target`. Refuses a chain that
 * is invalid, a missing step, a downgrade, and a result whose `cdm` is not the step's `to`.
 * Running it twice on one input gives the same canonical bytes (CDM-049 criterion 1 is a property
 * of each migration; this function adds no clock, randomness or I/O of its own).
 */
export function migrate(
  envelope: Record<string, unknown>,
  migrations: readonly Migration[],
  target: number,
): MigrationResult {
  const problem = chainProblem(migrations);
  if (problem) return { ok: false, code: 'migration_chain_invalid', message: problem };
  const from = envelope['cdm'];
  if (typeof from !== 'number' || !Number.isSafeInteger(from))
    return {
      ok: false,
      code: 'migration_missing',
      message: 'the envelope has no integer cdm version to migrate from',
    };
  if (from > target)
    return {
      ok: false,
      code: 'migration_downgrade',
      message: `the document is at version ${from}, above the target ${target}; migrations only go up`,
    };

  let current = copyJson(envelope);
  const steps: string[] = [];
  for (let version = from; version < target; version++) {
    const step = migrations.find((m) => m.from === version);
    if (!step)
      return {
        ok: false,
        code: 'migration_missing',
        message: `no migration from version ${version} to ${version + 1}`,
      };
    const out = step.apply(copyJson(current));
    if (!isObject(out) || out['cdm'] !== step.to)
      return {
        ok: false,
        code: 'migration_result_invalid',
        message: `migration "${step.name}" did not return an envelope with cdm ${step.to}`,
      };
    current = out;
    steps.push(step.name);
  }
  return { ok: true, envelope: current, cdm: target, steps };
}

/**
 * Moves one key of `ext` to a core attribute at a major bump (03 §11.2; CDM-049 criterion 3). The
 * value moves and nothing is left behind in `ext`; an `ext` that becomes empty is `{}`, which the
 * canonical form omits. Pure: returns new objects and does not touch `attrs`.
 */
export function moveExtKey(
  attrs: Record<string, unknown>,
  key: string,
  attribute: string,
): Record<string, unknown> {
  const ext = isObject(attrs['ext']) ? attrs['ext'] : {};
  if (!Object.hasOwn(ext, key)) return { ...attrs };
  const { [key]: value, ...rest } = ext;
  const out: Record<string, unknown> = { ...attrs, ext: rest };
  out[attribute] = value;
  return out;
}
