/**
 * A static check of the migrations for row-level security (BE-011 criterion 6). Every table a
 * migration creates must have a `tenant_id` column and must be passed to `docedit_protect`, which
 * enables and forces row-level security and adds the tenant policy (0001_platform.sql). The
 * catalogue test (test/postgres/schema.pg.test.ts) checks the same on a database; this check reads
 * the SQL files, so it needs no database and runs in the Node.js suite of every build.
 *
 * Partitions created by a DO loop (`create table %I partition of`) are not literal `create table`
 * statements and are not checked here: they inherit the parent's column and are protected in the
 * loop. A table named in `TENANT_EXEMPT` holds no tenant data and is protected by no policy.
 */

export interface GuardedMigration {
  version: string;
  sql: string;
}

/**
 * Tables that hold no tenant data, with the migration that says why. Each must really lack a
 * `tenant_id` column, which the tests check, so that an entry does not outlive its table.
 *   - node_leases (0033_node_leases.sql): a lease names a node, not a document. Owner decision 195
 *     (docs/owner-decisions-2026-11-15.md) allows it without a tenant column.
 */
export const TENANT_EXEMPT: ReadonlySet<string> = new Set(['node_leases']);

/** The SQL with its comments removed, so that a comment cannot satisfy or trigger the check. */
export function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('--');
      return at < 0 ? line : line.slice(0, at);
    })
    .join('\n');
}

/** The text between the parenthesis at `open` and its matching close, or null when unbalanced. */
function balancedBody(sql: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

/** The tables a migration creates literally, with the body of each definition. */
export function createdTables(sql: string): Array<{ name: string; body: string | null }> {
  const text = stripComments(sql);
  const out: Array<{ name: string; body: string | null }> = [];
  const re = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?((?:public\.)?[a-z_][a-z0-9_]*)\s*\(/gi;
  for (const m of text.matchAll(re)) {
    const name = m[1]!.replace(/^public\./i, '').toLowerCase();
    const open = (m.index ?? 0) + m[0].length - 1;
    out.push({ name, body: balancedBody(text, open) });
  }
  return out;
}

/** The tables passed to `docedit_protect('name')` in any of the migrations. */
export function protectedTables(migrations: readonly GuardedMigration[]): Set<string> {
  const out = new Set<string>();
  const re = /\bdocedit_protect\(\s*'(?:public\.)?([a-z_][a-z0-9_]*)'\s*\)/gi;
  for (const m of migrations)
    for (const hit of stripComments(m.sql).matchAll(re)) out.add(hit[1]!.toLowerCase());
  return out;
}

/**
 * The problems of the migrations with row-level security (BE-011 criterion 6): a created table
 * without a `tenant_id` column, or without a `docedit_protect` call, unless it is exempt. An empty
 * list means every tenant table has both.
 */
export function tenantProblems(
  migrations: readonly GuardedMigration[],
  exempt: ReadonlySet<string> = TENANT_EXEMPT,
): string[] {
  const protectedSet = protectedTables(migrations);
  const problems: string[] = [];
  for (const m of migrations) {
    for (const { name, body } of createdTables(m.sql)) {
      if (exempt.has(name)) continue;
      if (body === null) {
        problems.push(`${m.version}: the definition of ${name} is not balanced`);
        continue;
      }
      if (!/^\s*tenant_id\s/m.test(body))
        problems.push(`${m.version}: table ${name} has no tenant_id column (BE-011)`);
      if (!protectedSet.has(name))
        problems.push(`${m.version}: table ${name} is not passed to docedit_protect (BE-011)`);
    }
  }
  return problems;
}

/**
 * The exempt tables that do have a `tenant_id` column, or that no migration creates. Either makes
 * an entry of `TENANT_EXEMPT` wrong. An empty list means the exemptions are accurate.
 */
export function staleExemptions(
  migrations: readonly GuardedMigration[],
  exempt: ReadonlySet<string> = TENANT_EXEMPT,
): string[] {
  const out: string[] = [];
  for (const name of exempt) {
    const defs = migrations.flatMap((m) => createdTables(m.sql).filter((t) => t.name === name));
    if (defs.length === 0) {
      out.push(`${name} is exempt from the tenant check but no migration creates it`);
      continue;
    }
    if (defs.some((d) => d.body !== null && /^\s*tenant_id\s/m.test(d.body)))
      out.push(`${name} is exempt from the tenant check but has a tenant_id column`);
  }
  return out;
}
