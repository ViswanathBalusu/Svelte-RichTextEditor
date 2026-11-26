/**
 * The tenant's network-capture setting in PostgreSQL (FRW-042; 12 §7, last sentence; migration
 * 0067 `tenant_capture_settings`), and the recording of workflow evidence under it.
 *
 * - `PgCaptureSettingsStore.change` is the one path that changes the setting. In one transaction of
 *   the tenant (BE-011) it locks the tenant's setting, builds the audit entry with
 *   `captureChangeAudit` (actor and time, old and new value), stores the new value and inserts the
 *   entry into `audit_events`. The change and its audit entry commit together or not at all. A
 *   change to the value already in force writes nothing and is not audited.
 * - `PgCaptureSettingsStore.recordEvidence` stores one event's evidence in `workflow_evidence`,
 *   built by `captureEvidence` under the setting read in the same transaction. A change therefore
 *   applies to the events recorded after it commits, and evidence already stored is not rewritten:
 *   nothing here updates `workflow_evidence` (the service role holds no UPDATE on it).
 *
 * The administration route that calls `change` and its credential check (FRW-042 criterion 4) and
 * the participant endpoints that call `recordEvidence` (criteria 1 and 3) are not built here. The
 * default, on, is the reading recorded in FRW-042 Notes. Lane V-FRW-019-036.
 */
import { uuid7 } from '@docedit/model';
import {
  captureChangeAudit,
  captureEvidence,
  DEFAULT_CAPTURE_SETTINGS,
  type CaptureSettings,
  type CapturedEvidence,
  type EvidenceFacts,
} from '@docedit/authority';
import {
  CaptureSettingsConflict,
  type CaptureSettingsChange,
  type CaptureSettingsState,
} from './capture-settings.ts';
export { CaptureSettingsConflict, type CaptureSettingsChange, type CaptureSettingsState };
import { insertAuditEvent, PgAuditStore } from '../data-plane/pg/audit.ts';
import { inTenant, type Pool, type Queryable } from '../storage/db.ts';

export const TENANT_CAPTURE_SETTINGS_TABLE = 'tenant_capture_settings';

/** The SQLSTATE PostgreSQL gives an insert for which no audit partition exists. */
const NO_PARTITION = '23514';

/** One event's evidence to record. */
export interface EvidenceEvent {
  readonly doc: string;
  /** The participant's surrogate (never a host identifier). */
  readonly participant: string;
  /** The evidence item, for example `viewed`, `consented`, `signed` or `completed`. */
  readonly item: string;
  readonly facts: EvidenceFacts;
}

export interface CaptureSettingsStoreOptions {
  /** The clock for the change and collection instants. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface Row {
  capture_network_identity: boolean;
  version: number;
}

async function readState(
  c: Queryable,
  tenant: string,
  lock: boolean,
): Promise<CaptureSettingsState> {
  const r = await c.query<Row>(
    `SELECT capture_network_identity, version FROM ${TENANT_CAPTURE_SETTINGS_TABLE}
      WHERE tenant_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [tenant],
  );
  const row = r.rows[0];
  if (!row) return { settings: DEFAULT_CAPTURE_SETTINGS, version: 0 };
  return {
    settings: { captureNetworkIdentity: row.capture_network_identity },
    version: Number(row.version),
  };
}

/** The setting in force for a tenant, read inside a transaction of that tenant (FRW-041). */
export const readCaptureState = readState;

export class PgCaptureSettingsStore {
  readonly #pool: Pool;
  readonly #audit: PgAuditStore;
  readonly #now: () => number;

  constructor(pool: Pool, options: CaptureSettingsStoreOptions = {}) {
    this.#pool = pool;
    this.#audit = new PgAuditStore(pool);
    this.#now = options.now ?? Date.now;
  }

  /** The setting in force for the tenant now. */
  read(tenant: string): Promise<CaptureSettingsState> {
    return inTenant(this.#pool, tenant, (c) => readState(c, tenant, false), { readOnly: true });
  }

  /**
   * Changes the tenant's setting on behalf of `actor` (a per-tenant surrogate), and writes the
   * change to the audit trail in the same transaction. With `expected`, refuses with
   * `CaptureSettingsConflict` unless the stored version is that one.
   */
  async change(
    tenant: string,
    actor: string,
    to: CaptureSettings,
    expected?: number,
  ): Promise<CaptureSettingsChange> {
    const attempt = () =>
      inTenant(this.#pool, tenant, async (c) => {
        // Serialise the changes of one tenant, including the first, which has no row to lock yet.
        await c.query("SELECT pg_advisory_xact_lock(hashtext('docedit.capture-settings:' || $1))", [
          tenant,
        ]);
        const before = await readState(c, tenant, true);
        if (expected !== undefined && expected !== before.version)
          throw new CaptureSettingsConflict(before.version);
        if (before.settings.captureNetworkIdentity === to.captureNetworkIdentity)
          return { state: before, audit: null };
        const at = this.#now();
        const entry = captureChangeAudit(actor, at, before.settings, to);
        const version = before.version + 1;
        await c.query(
          `INSERT INTO ${TENANT_CAPTURE_SETTINGS_TABLE}
             (tenant_id, capture_network_identity, version, changed_at, changed_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id) DO UPDATE
             SET capture_network_identity = excluded.capture_network_identity,
                 version = excluded.version, changed_at = excluded.changed_at,
                 changed_by = excluded.changed_by`,
          [tenant, to.captureNetworkIdentity, version, new Date(at).toISOString(), actor],
        );
        await insertAuditEvent(c, {
          id: uuid7(),
          tenant,
          doc: null,
          actor: entry.actor,
          kind: entry.kind,
          data: { from: { ...entry.from }, to: { ...entry.to }, version },
          at: entry.atMs,
        });
        return { state: { settings: { ...to }, version }, audit: entry };
      });
    try {
      return await attempt();
    } catch (e) {
      // The audit partition of this month may not exist yet: create it and try once more.
      if ((e as { code?: unknown }).code !== NO_PARTITION) throw e;
      await this.#audit.ensurePartitions();
      return attempt();
    }
  }

  /**
   * Records one event's evidence under the setting in force when it is recorded. Returns the
   * evidence stored, which holds no IP address and no user agent while the setting is off.
   */
  recordEvidence(tenant: string, event: EvidenceEvent): Promise<CapturedEvidence> {
    return inTenant(this.#pool, tenant, async (c) => {
      const { settings } = await readState(c, tenant, false);
      const evidence = captureEvidence(event.facts, settings);
      await c.query(
        `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uuid7(),
          tenant,
          event.doc,
          event.participant,
          event.item,
          new Date(this.#now()).toISOString(),
          JSON.stringify(evidence),
        ],
      );
      return evidence;
    });
  }
}
