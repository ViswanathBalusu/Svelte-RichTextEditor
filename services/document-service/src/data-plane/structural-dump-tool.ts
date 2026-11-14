/**
 * The structural dump command (06 §11; BE-089), without the process around it: the command line
 * (structural-dump-cli.ts) builds the PostgreSQL and object stores, the operator's identity and the
 * assignment source, and calls `runDumpTool`. Tests call it with memory stores, and run the command
 * line itself against PostgreSQL.
 *
 *   dump --tenant T --doc D
 *
 * The order is fixed: the operator's identity, then the assignment of the operator to tenant T
 * (refused before anything is read), then the read of the newest checkpoint at or before the head
 * and the log after it, then the audit event, then the dump on `out`. Log lines go through the
 * structured logger (src/log.ts): identifiers, codes and fixed messages, never content.
 */
import { isSnapshot, type StepJson } from '@docedit/authority';
import type { JsonEnvelope } from '@docedit/model';
import { errorFields, type Logger } from '../log.ts';
import type { AuditStore, DocRef } from '../storage/types.ts';
import { Checkpointer } from './checkpoints.ts';
import type { OperatorAssignments } from './operator-assignments.ts';
import type { RecoveryStores } from './recovery.ts';
import { DumpRefusedError, runStructuralDump, type DumpSource } from './structural-dump.ts';
import { Workers } from './workers.ts';

/** Exit codes of the command. */
export const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

export const USAGE = 'usage: structural-dump-cli.ts dump --tenant <tenant> --doc <document>';

export interface DumpSourceRead extends DumpSource {
  /** The checkpoint (or snapshot commit) the source starts from. */
  readonly from: number;
  /** The head the log was read to. */
  readonly head: number;
}

/**
 * The PostgreSQL (or memory) read path of the dump: the newest usable checkpoint at or before the
 * head and every commit after it, as `rebuild` reads them (recovery.ts). A snapshot commit in that
 * range restarts the source from the content it brought, so the dumped log replays.
 */
export async function readDumpSource(s: RecoveryStores, ref: DocRef): Promise<DumpSourceRead> {
  const head = (await s.logs.head(ref)).seq;
  const cp = await new Checkpointer({
    store: s.checkpoints,
    index: s.index,
    workers: new Workers({ size: 0, timeoutMs: 60_000 }),
  }).load(ref, head);
  if (!cp) throw new Error('the document has no checkpoint at or before its head, not even at 0');
  const log = cp.seq < head ? await s.logs.read(ref, cp.seq + 1, head) : [];
  if (log.length !== head - cp.seq)
    throw new Error(`the log has a gap between ${cp.seq} and ${head}`);
  let envelope: JsonEnvelope = cp.envelope;
  let from = cp.seq;
  let commits = log;
  for (let i = log.length - 1; i >= 0; i--) {
    const c = log[i]!;
    if (!isSnapshot(c)) continue;
    const content = s.logs.snapshotContent ? await s.logs.snapshotContent(ref, c.seq) : null;
    if (!content) throw new Error(`snapshot commit ${c.seq} has no content`);
    envelope = { ...cp.envelope, doc: content.doc };
    from = c.seq;
    commits = log.slice(i + 1);
    break;
  }
  return {
    envelope,
    commits: commits.map((c): readonly StepJson[] => (isSnapshot(c) ? [] : c.steps)),
    from,
    head,
  };
}

export interface DumpToolDeps {
  stores: RecoveryStores & { audit: AuditStore };
  /** The operator's audit actor (`operatorActor`), or null when the identity could not be read. */
  operator: string | null;
  assignments: OperatorAssignments;
  /** Where the dump goes (the command line: standard output). */
  out: (text: string) => void;
  /** Log lines (the command line: standard error). */
  log: Logger;
  now?: () => number;
}

function option(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === undefined || v.startsWith('--') ? undefined : v;
}

/** Runs the command; resolves with its exit code. It never throws. */
export async function runDumpTool(argv: readonly string[], deps: DumpToolDeps): Promise<number> {
  const tenant = option(argv, 'tenant');
  const doc = option(argv, 'doc');
  if (argv[0] !== 'dump' || !tenant || !doc) {
    deps.log.error({ event: 'dump.usage', code: 'usage', message: USAGE });
    return EXIT.usage;
  }
  const ref: DocRef = { tenant, doc };
  if (deps.operator === null) {
    deps.log.error({
      event: 'dump.refused',
      tenant,
      doc,
      code: 'no_operator_identity',
      message: 'the operator account could not be read',
    });
    return EXIT.refused;
  }
  try {
    const dump = await runStructuralDump(ref, (r) => readDumpSource(deps.stores, r), {
      actor: deps.operator,
      assigned: (t, a) => deps.assignments.isAssigned(t, a),
      audit: deps.stores.audit,
      ...(deps.now ? { now: deps.now } : {}),
    });
    deps.out(JSON.stringify(dump));
    deps.log.info({
      event: 'dump.done',
      tenant,
      doc,
      message: 'structural dump written; the run is in the audit trail',
    });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof DumpRefusedError) {
      deps.log.error({
        event: 'dump.refused',
        tenant,
        doc,
        code: 'not_assigned',
        message: 'the operator is not assigned to this tenant',
      });
      return EXIT.refused;
    }
    // By name and stack frames only: a message may quote stored data.
    deps.log.error({ event: 'dump.failed', tenant, doc, code: 'failed', ...errorFields(e) });
    return EXIT.failed;
  }
}
