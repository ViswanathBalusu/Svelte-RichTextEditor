/**
 * The PostgreSQL store of the session records (HIS-003 criterion 3; 08 section 2; owner decision
 * 24). It holds the same rows as `MemorySessionRecordStore` in session-records.ts, in the table
 * `doc_sessions` of migration 0096. Every query runs under the tenant's row-level security
 * (BE-011). The service role may read and insert, never update or delete: a record is written once,
 * and the purge of a deleted document removes it under its own role (HIS-039). `pgParts` in
 * server.ts composes this store.
 */
import { inTenant, isUuid, type Pool } from '../storage/db.ts';
import {
  USER_AGENT_FAMILIES,
  type SessionRecord,
  type SessionRecordStore,
  type UserAgentFamily,
} from './session-records.ts';

export const DOC_SESSIONS_TABLE = 'doc_sessions';

/** The columns of the table, in order. A test compares them with the database's own list. */
export const DOC_SESSIONS_COLUMNS = [
  'doc_id',
  'tenant_id',
  'session_id',
  'user_id',
  'ua_family',
  'ua_major',
  'client_version',
] as const;

interface Row {
  doc_id: string;
  session_id: string;
  user_id: string;
  ua_family: string;
  ua_major: number | null;
  client_version: string | null;
}

function familyOf(value: string): UserAgentFamily {
  // The check constraint of the table allows the same list; a value outside it is a defect.
  if (!(USER_AGENT_FAMILIES as readonly string[]).includes(value))
    throw new Error(`doc_sessions holds an unknown user agent family: ${value}`);
  return value as UserAgentFamily;
}

function recordOf(tenant: string, row: Row): SessionRecord {
  return {
    tenant,
    document: row.doc_id,
    session: row.session_id,
    user: row.user_id,
    userAgentFamily: familyOf(row.ua_family),
    userAgentMajor: row.ua_major,
    clientVersion: row.client_version,
  };
}

const SELECT = `select doc_id::text as doc_id, session_id, user_id, ua_family, ua_major, client_version
                  from ${DOC_SESSIONS_TABLE}`;

export class PgSessionRecordStore implements SessionRecordStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(row: SessionRecord): Promise<void> {
    // An identifier that is not a UUID names no document, so there is nothing to record.
    if (!isUuid(row.document)) return;
    await inTenant(this.#pool, row.tenant, async (c) => {
      // The row is taken from the document's own row, so a document that does not exist, belongs to
      // another tenant or is deleted gets none. The first record of a session stays.
      await c.query(
        `insert into ${DOC_SESSIONS_TABLE}
                (doc_id, tenant_id, session_id, user_id, ua_family, ua_major, client_version)
         select d.id, d.tenant_id, $3, $4, $5, $6, $7
           from documents d
          where d.tenant_id = $1 and d.id = $2::uuid and d.deleted_at is null
         on conflict (doc_id, session_id) do nothing`,
        [
          row.tenant,
          row.document,
          row.session,
          row.user,
          row.userAgentFamily,
          row.userAgentMajor,
          row.clientVersion,
        ],
      );
    });
  }

  get(tenant: string, document: string, session: string): Promise<SessionRecord | null> {
    if (!isUuid(document)) return Promise.resolve(null);
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `${SELECT} where tenant_id = $1 and doc_id = $2::uuid and session_id = $3`,
          [tenant, document, session],
        );
        const row = r.rows[0];
        return row ? recordOf(tenant, row) : null;
      },
      { readOnly: true },
    );
  }

  list(tenant: string, document: string): Promise<SessionRecord[]> {
    if (!isUuid(document)) return Promise.resolve([]);
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `${SELECT} where tenant_id = $1 and doc_id = $2::uuid order by session_id collate "C"`,
          [tenant, document],
        );
        return r.rows.map((row) => recordOf(tenant, row));
      },
      { readOnly: true },
    );
  }
}
