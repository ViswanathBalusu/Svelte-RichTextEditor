/**
 * PostgreSQL access for the storage layer (06 §4.1): pools, transactions scoped to one tenant
 * (row-level security; BE-011), and the helpers that tell a definite failure from an unknown one.
 */
import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.ClientBase, 'query'>;

/**
 * A pool for the service role. A session left idle inside a transaction is ended by the server,
 * so a client that vanished mid-write cannot hold a document's head row for long.
 */
export function createPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool({
    max: 10,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'docedit-document-service',
    ...config,
  });
  // An idle client that loses its connection is dropped by the pool; the next query reports it.
  pool.on('error', () => {});
  // A checked-out client whose connection drops also emits 'error' once its query has failed;
  // the failure already reached the caller through that query, so the event needs no handling.
  pool.on('connect', (client) => {
    client.on('error', () => {});
  });
  return pool;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function assertUuid(value: unknown, what: string): asserts value is string {
  if (!isUuid(value))
    throw new TypeError(`${what} must be a lower-case UUID, got ${String(value)}`);
}

/**
 * Starts a transaction in which row-level security sees only `tenant`'s rows. The tenant is set
 * for this transaction alone (`set_config(..., true)`), so a pooled connection never carries it
 * into the next one. It is interpolated only after validation; a statement with several commands
 * cannot take parameters.
 */
export async function beginForTenant(
  client: Queryable,
  tenant: string,
  options: { readOnly?: boolean; lockTimeoutMs?: number } = {},
): Promise<void> {
  assertUuid(tenant, 'tenant');
  const parts = [options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN'];
  parts.push(`SELECT set_config('docedit.tenant_id', '${tenant}', true)`);
  if (options.lockTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 0)
      throw new RangeError('lockTimeoutMs must be a non-negative integer');
    parts.push(`SET LOCAL lock_timeout = ${options.lockTimeoutMs}`);
  }
  await client.query(parts.join('; '));
}

/** Runs `fn` in one transaction for `tenant`, committing if it resolves and rolling back if not. */
export async function inTenant<T>(
  pool: pg.Pool,
  tenant: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await beginForTenant(client, tenant, options);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

/** The SQLSTATE of a server error, if `e` is one. */
export function sqlState(e: unknown): string | undefined {
  return e instanceof pg.DatabaseError ? e.code : undefined;
}

/** The constraint a server error names, if any. */
export function constraintOf(e: unknown): string | undefined {
  return e instanceof pg.DatabaseError ? e.constraint : undefined;
}

export const SQLSTATE = {
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

/** int8 and numeric columns arrive as strings; every value here is a safe integer. */
export function int(value: unknown): number {
  if (value === null || value === undefined || value === '') throw new TypeError('missing integer');
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${String(value)}`);
  return n;
}

/** Unix milliseconds of a timestamptz column, or null. */
export function millis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  throw new TypeError(`not a timestamp: ${String(value)}`);
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
