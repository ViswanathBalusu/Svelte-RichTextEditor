/**
 * The structural dump for support (06 §11; BE-089), for operators. It needs the database and the
 * object store, not a running service.
 *
 *   node src/data-plane/structural-dump-cli.ts dump --tenant T --doc D > dump.json
 *
 * The dump (JSON) goes to standard output; log lines (structured, no content) go to standard error.
 * Exit 0 on success, 1 on a failure, 2 on a usage error, 3 when the run is refused.
 *
 * Settings come from the environment as for the service (DOCEDIT_DATABASE_URL, DOCEDIT_S3_*), and
 * DOCEDIT_OPERATOR_ASSIGNMENTS names the file of operator-to-tenant assignments
 * (operator-assignments.ts). Without it, every run is refused. The operator is the
 * operating-system account that runs this command; it is recorded in the tenant's audit trail.
 */
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { configFromEnv } from '../config.ts';
import { createLogger, errorFields } from '../log.ts';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import { S3ObjectStore } from '../objects/s3.ts';
import { createPool } from '../storage/db.ts';
import { PgGrantStore } from '../storage/grant-store.ts';
import { PgLogStore } from '../storage/log-store.ts';
import {
  NO_ASSIGNMENTS,
  operatorActor,
  parseOperatorAssignments,
  type OperatorAssignments,
} from './operator-assignments.ts';
import { PgAuditStore } from './pg/audit.ts';
import { PgCheckpointIndex } from './pg/checkpoint-index.ts';
import { EXIT, runDumpTool } from './structural-dump-tool.ts';

const log = createLogger((line) => process.stderr.write(`${line}\n`));

function account(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

function assignments(): OperatorAssignments | null {
  const path = process.env['DOCEDIT_OPERATOR_ASSIGNMENTS'];
  if (!path) return NO_ASSIGNMENTS;
  try {
    return parseOperatorAssignments(readFileSync(path, 'utf8'));
  } catch (e) {
    log.error({ event: 'dump.assignments', code: 'assignments_unreadable', ...errorFields(e) });
    return null;
  }
}

const config = configFromEnv();
if (!config.databaseUrl || !config.s3) {
  log.error({
    event: 'dump.settings',
    code: 'settings',
    message: 'set DOCEDIT_DATABASE_URL and the DOCEDIT_S3_* settings',
  });
  process.exit(EXIT.usage);
}
const assigned = assignments();
if (assigned === null) process.exit(EXIT.refused);

const pool = createPool({ connectionString: config.databaseUrl });
const grants = new PgGrantStore(pool);
try {
  // runDumpTool never throws; `finally` closes the pool.
  process.exitCode = await runDumpTool(process.argv.slice(2), {
    stores: {
      logs: new PgLogStore(pool, { permissions: (ref) => grants.current(ref) }),
      checkpoints: new ObjectCheckpointStore(new S3ObjectStore(config.s3)),
      index: new PgCheckpointIndex(pool),
      audit: new PgAuditStore(pool),
    },
    operator: operatorActor(account()),
    assignments: assigned,
    out: (text) => process.stdout.write(`${text}\n`),
    log,
  });
} finally {
  await pool.end();
}
