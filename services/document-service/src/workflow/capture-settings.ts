/**
 * The administration of the tenant's network-capture setting (FRW-042; 12 §7, last sentence).
 *
 * `CaptureSettingsPort` is what the routes `GET|PUT /workflow/capture-settings` call. The setting
 * says whether the IP address and the user agent of a participant are kept in their evidence. It is
 * on by default. A change is audited with the actor and the time, applies to the events recorded
 * after it, and rewrites no evidence already stored.
 *
 * - `MemoryCaptureSettings` is the memory adapter: it keeps the value and the version, writes the
 *   audit entry to the audit trail, and gives the evidence ledger its reading (`settingsOf`).
 * - `PgCaptureSettingsStore` (capture-settings-pg.ts) is the PostgreSQL adapter; it writes the value
 *   and the audit entry in one transaction.
 *
 * The routes are in `control-plane/capture-settings-routes.ts`; docs/adr/0426-w4-FRW-042-capture-setting-api.md
 * (proposed) records the path and the body.
 */
import { uuid7 } from '@docedit/model';
import {
  captureChangeAudit,
  DEFAULT_CAPTURE_SETTINGS,
  type CaptureChangeAudit,
  type CaptureSettings,
} from '@docedit/authority';
import type { AuditStore } from '../storage/types.ts';
/** The setting in force for a tenant, and its version (0 while the tenant has never changed it). */
export interface CaptureSettingsState {
  readonly settings: CaptureSettings;
  readonly version: number;
}

/** A change whose expected version is not the stored one. Nothing was written. */
export class CaptureSettingsConflict extends Error {
  readonly current: number;
  constructor(current: number) {
    super(`the capture setting is at version ${current}`);
    this.name = 'CaptureSettingsConflict';
    this.current = current;
  }
}

/** The result of a change: the state after it, and the audit entry written (null for no change). */
export interface CaptureSettingsChange {
  readonly state: CaptureSettingsState;
  readonly audit: CaptureChangeAudit | null;
}
export interface CaptureSettingsPort {
  /** The setting in force for the tenant, and its version (0 while the tenant has never changed it). */
  read(tenant: string): Promise<CaptureSettingsState>;
  /** Changes the setting for `actor`. Refuses with `CaptureSettingsConflict` unless `expected` is the stored version. */
  change(
    tenant: string,
    actor: string,
    to: CaptureSettings,
    expected?: number,
  ): Promise<CaptureSettingsChange>;
}

export class MemoryCaptureSettings implements CaptureSettingsPort {
  readonly #states = new Map<string, CaptureSettingsState>();
  readonly #audit: AuditStore;
  readonly #now: () => number;

  constructor(audit: AuditStore, now: () => number = Date.now) {
    this.#audit = audit;
    this.#now = now;
  }

  /** The setting now, synchronously: what the memory evidence ledger records under. */
  settingsOf(tenant: string): CaptureSettings {
    return this.#states.get(tenant)?.settings ?? DEFAULT_CAPTURE_SETTINGS;
  }

  read(tenant: string): Promise<CaptureSettingsState> {
    return Promise.resolve(
      this.#states.get(tenant) ?? { settings: DEFAULT_CAPTURE_SETTINGS, version: 0 },
    );
  }

  async change(
    tenant: string,
    actor: string,
    to: CaptureSettings,
    expected?: number,
  ): Promise<CaptureSettingsChange> {
    const before = await this.read(tenant);
    if (expected !== undefined && expected !== before.version)
      throw new CaptureSettingsConflict(before.version);
    if (before.settings.captureNetworkIdentity === to.captureNetworkIdentity)
      return { state: before, audit: null };
    const entry = captureChangeAudit(actor, this.#now(), before.settings, to);
    const state = { settings: { ...to }, version: before.version + 1 };
    this.#states.set(tenant, state);
    await this.#audit.record([
      {
        id: uuid7(),
        tenant,
        doc: null,
        actor: entry.actor,
        kind: entry.kind,
        data: { from: { ...entry.from }, to: { ...entry.to }, version: state.version },
        at: entry.atMs,
      },
    ]);
    return { state, audit: entry };
  }
}
