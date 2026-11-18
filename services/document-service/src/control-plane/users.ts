/**
 * Per-tenant user surrogates (BE-013; 06 §4.1 `tenant_users`; 08 §13; 10 §4). Every host `sub`
 * gets a random surrogate the first time a request or a `hello` carries it, and every other table
 * stores only the surrogate: grants (`user:<surrogate>`), leases, commits, jobs, metadata. Erasing
 * a person deletes their mapping row; what history keeps can then no longer be tied to them.
 *
 * The same row holds the revocation watermark for all of the user's documents (05 §3.3);
 * `document_revocations` holds the watermarks for single documents (decision D73).
 */
import { randomUUID } from 'node:crypto';
import { inTenant, millis, type Pool, type PoolClient } from '../storage/db.ts';

export interface UserRecord {
  surrogate: string;
  /** Tokens issued before this time are refused for every document, or null. */
  revokedBefore: number | null;
  /** Watermarks for single documents: document identifier to time. */
  documentRevocations: ReadonlyMap<string, number>;
}

export interface UserDirectory {
  /** The user's surrogate, created on first sight; `name` (the `name` claim) is stored with it. */
  resolve(tenant: string, sub: string, name?: string): Promise<UserRecord>;
  /** The surrogate of a person already mapped, or null. Unlike `resolve` it creates nothing. */
  surrogateOf(tenant: string, sub: string): Promise<string | null>;
  /** The host `sub` of each surrogate still mapped; erased users are missing from the result. */
  subsOf(tenant: string, surrogates: readonly string[]): Promise<Map<string, string>>;
  /** Records a revocation watermark at `at` (05 §3.3), for one document or for all. */
  revoke(tenant: string, sub: string, doc: string | null, at: number): Promise<UserRecord>;
  /** Clears the display name and nothing else (BE-013 criterion 3). */
  purgeName(tenant: string, sub: string): Promise<boolean>;
  /** Erases a user: deletes the mapping row (BE-013 criterion 5). History keeps the surrogate. */
  erase(tenant: string, sub: string): Promise<boolean>;
  /** The stored display name, for the tests and for support tooling. */
  displayName(tenant: string, sub: string): Promise<string | null>;
}

/** A surrogate: random, so it says nothing about the person or the tenant. */
export function newSurrogate(): string {
  return randomUUID();
}

interface MemoryUser {
  surrogate: string;
  name: string | null;
  revokedBefore: number | null;
  docs: Map<string, number>;
}

export class MemoryUserDirectory implements UserDirectory {
  readonly #users = new Map<string, Map<string, MemoryUser>>();

  #tenant(tenant: string): Map<string, MemoryUser> {
    let t = this.#users.get(tenant);
    if (!t) this.#users.set(tenant, (t = new Map()));
    return t;
  }

  #record(u: MemoryUser): UserRecord {
    return {
      surrogate: u.surrogate,
      revokedBefore: u.revokedBefore,
      documentRevocations: new Map(u.docs),
    };
  }

  async resolve(tenant: string, sub: string, name?: string): Promise<UserRecord> {
    const t = this.#tenant(tenant);
    let u = t.get(sub);
    if (!u)
      t.set(
        sub,
        (u = { surrogate: newSurrogate(), name: null, revokedBefore: null, docs: new Map() }),
      );
    if (name !== undefined) u.name = name;
    return this.#record(u);
  }

  async surrogateOf(tenant: string, sub: string): Promise<string | null> {
    return this.#users.get(tenant)?.get(sub)?.surrogate ?? null;
  }

  async subsOf(tenant: string, surrogates: readonly string[]): Promise<Map<string, string>> {
    const want = new Set(surrogates);
    const out = new Map<string, string>();
    for (const [sub, u] of this.#users.get(tenant) ?? [])
      if (want.has(u.surrogate)) out.set(u.surrogate, sub);
    return out;
  }

  async revoke(tenant: string, sub: string, doc: string | null, at: number): Promise<UserRecord> {
    await this.resolve(tenant, sub);
    const u = this.#tenant(tenant).get(sub)!;
    if (doc === null) u.revokedBefore = Math.max(u.revokedBefore ?? 0, at);
    else u.docs.set(doc, Math.max(u.docs.get(doc) ?? 0, at));
    return this.#record(u);
  }

  async purgeName(tenant: string, sub: string): Promise<boolean> {
    const u = this.#users.get(tenant)?.get(sub);
    if (!u) return false;
    u.name = null;
    return true;
  }

  async erase(tenant: string, sub: string): Promise<boolean> {
    return this.#users.get(tenant)?.delete(sub) ?? false;
  }

  async displayName(tenant: string, sub: string): Promise<string | null> {
    return this.#users.get(tenant)?.get(sub)?.name ?? null;
  }
}

export class PgUserDirectory implements UserDirectory {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  resolve(tenant: string, sub: string, name?: string): Promise<UserRecord> {
    return inTenant(this.#pool, tenant, async (c) => {
      // Two first requests at once: one insert wins, both read the same row.
      await c.query(
        `INSERT INTO tenant_users (tenant_id, sub, surrogate, display_name, created_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, sub) DO NOTHING`,
        [tenant, sub, newSurrogate(), name ?? null],
      );
      if (name !== undefined)
        await c.query(
          `UPDATE tenant_users SET display_name = $3
            WHERE tenant_id = $1 AND sub = $2 AND display_name IS DISTINCT FROM $3`,
          [tenant, sub, name],
        );
      return this.#read(c, tenant, sub);
    });
  }

  async #read(c: PoolClient, tenant: string, sub: string): Promise<UserRecord> {
    const r = await c.query<{ surrogate: string; revoked_before: Date | null }>(
      'SELECT surrogate, revoked_before FROM tenant_users WHERE tenant_id = $1 AND sub = $2',
      [tenant, sub],
    );
    const row = r.rows[0];
    if (!row) throw new Error('the user mapping vanished while it was read');
    const d = await c.query<{ doc_id: string; revoked_before: Date }>(
      'SELECT doc_id, revoked_before FROM document_revocations WHERE tenant_id = $1 AND surrogate = $2',
      [tenant, row.surrogate],
    );
    return {
      surrogate: row.surrogate,
      revokedBefore: millis(row.revoked_before),
      documentRevocations: new Map(d.rows.map((x) => [x.doc_id, millis(x.revoked_before)!])),
    };
  }

  surrogateOf(tenant: string, sub: string): Promise<string | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ surrogate: string }>(
          'SELECT surrogate FROM tenant_users WHERE tenant_id = $1 AND sub = $2',
          [tenant, sub],
        );
        return r.rows[0]?.surrogate ?? null;
      },
      { readOnly: true },
    );
  }

  subsOf(tenant: string, surrogates: readonly string[]): Promise<Map<string, string>> {
    if (surrogates.length === 0) return Promise.resolve(new Map());
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ sub: string; surrogate: string }>(
          'SELECT sub, surrogate FROM tenant_users WHERE tenant_id = $1 AND surrogate = ANY ($2::text[])',
          [tenant, [...new Set(surrogates)]],
        );
        return new Map(r.rows.map((x) => [x.surrogate, x.sub]));
      },
      { readOnly: true },
    );
  }

  revoke(tenant: string, sub: string, doc: string | null, at: number): Promise<UserRecord> {
    const when = new Date(at).toISOString();
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `INSERT INTO tenant_users (tenant_id, sub, surrogate, created_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, sub) DO NOTHING`,
        [tenant, sub, newSurrogate()],
      );
      if (doc === null)
        await c.query(
          `UPDATE tenant_users SET revoked_before = greatest(coalesce(revoked_before, $3::timestamptz), $3::timestamptz)
            WHERE tenant_id = $1 AND sub = $2`,
          [tenant, sub, when],
        );
      else
        await c.query(
          `INSERT INTO document_revocations (tenant_id, surrogate, doc_id, revoked_before)
           SELECT $1, surrogate, $3, $4 FROM tenant_users WHERE tenant_id = $1 AND sub = $2
           ON CONFLICT (tenant_id, surrogate, doc_id) DO UPDATE
              SET revoked_before = greatest(document_revocations.revoked_before, excluded.revoked_before)`,
          [tenant, sub, doc, when],
        );
      return this.#read(c, tenant, sub);
    });
  }

  purgeName(tenant: string, sub: string): Promise<boolean> {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        'UPDATE tenant_users SET display_name = NULL WHERE tenant_id = $1 AND sub = $2',
        [tenant, sub],
      );
      return r.rowCount === 1;
    });
  }

  erase(tenant: string, sub: string): Promise<boolean> {
    return inTenant(this.#pool, tenant, async (c) => {
      // HIS-038 criterion 1: the mapping row (and its display name) and the read markers of the
      // surrogate go in one transaction; the log is not touched.
      const r = await c.query<{ surrogate: string }>(
        'DELETE FROM tenant_users WHERE tenant_id = $1 AND sub = $2 RETURNING surrogate',
        [tenant, sub],
      );
      const row = r.rows[0];
      if (row === undefined) return false;
      await c.query('DELETE FROM read_markers WHERE tenant_id = $1 AND user_id = $2', [
        tenant,
        row.surrogate,
      ]);
      return true;
    });
  }

  displayName(tenant: string, sub: string): Promise<string | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ display_name: string | null }>(
          'SELECT display_name FROM tenant_users WHERE tenant_id = $1 AND sub = $2',
          [tenant, sub],
        );
        return r.rows[0]?.display_name ?? null;
      },
      { readOnly: true },
    );
  }
}
