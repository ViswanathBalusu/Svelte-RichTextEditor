/**
 * Identifier checks with no driver behind them (BE-002 criterion 1): rooms, handlers and the
 * object-store ports use these without loading the PostgreSQL client. `db.ts` re-exports them.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function assertUuid(value: unknown, what: string): asserts value is string {
  if (!isUuid(value))
    throw new TypeError(`${what} must be a lower-case UUID, got ${String(value)}`);
}
