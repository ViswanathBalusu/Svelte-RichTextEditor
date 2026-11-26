/**
 * Settings a tenant switches on or off (BE-051; 06 section 10; 09 sections 7 and 9.1).
 *
 * `pageBreakReconciliation`: an export request with `options.layout` set to `lines` asks the compile
 * for line-level layout, which the page view adopts for paragraphs that have not changed (parity level
 * L1, 09 section 7). It costs more compile time than a preview, so it is opt-in per tenant and off by
 * default. A tenant with no stored value has the default; a server composed without a store has it off
 * for every tenant.
 *
 * The route that changes a setting is part of the administration API (UX-076) and does not exist yet;
 * `TenantSettingService.set` is what that route will call, and it audits the change.
 */
import { uuid7 } from '@docedit/model';
import type { AuditStore } from '../storage/types.ts';

export interface TenantSettingValues {
  /** Whether line-level layout compiles are allowed for the tenant. Off by default. */
  pageBreakReconciliation: boolean;
}

export const TENANT_SETTING_DEFAULTS: Readonly<TenantSettingValues> = Object.freeze({
  pageBreakReconciliation: false,
});

export interface TenantSettingStore {
  /** The tenant's values; the defaults for a tenant with no stored value. */
  get(tenant: string): Promise<TenantSettingValues>;
  set(tenant: string, values: TenantSettingValues, actor: string, at: number): Promise<void>;
}

export class MemoryTenantSettingStore implements TenantSettingStore {
  #by = new Map<string, TenantSettingValues>();

  async get(tenant: string): Promise<TenantSettingValues> {
    return { ...(this.#by.get(tenant) ?? TENANT_SETTING_DEFAULTS) };
  }

  async set(tenant: string, values: TenantSettingValues): Promise<void> {
    this.#by.set(tenant, { ...values });
  }
}

export class TenantSettingService {
  readonly #store: TenantSettingStore;
  readonly #audit: AuditStore | undefined;
  readonly #now: () => number;

  constructor(deps: { store: TenantSettingStore; audit?: AuditStore; now: () => number }) {
    this.#store = deps.store;
    this.#audit = deps.audit;
    this.#now = deps.now;
  }

  get(tenant: string): Promise<TenantSettingValues> {
    return this.#store.get(tenant);
  }

  /** Whether the tenant has enabled page-break reconciliation compiles. */
  pageBreakReconciliation(tenant: string): Promise<boolean> {
    return this.#store.get(tenant).then((v) => v.pageBreakReconciliation);
  }

  /** Changes settings and audits the change (`tenant_setting.changed`) when a value differs. */
  async set(
    tenant: string,
    actor: string,
    change: Partial<TenantSettingValues>,
  ): Promise<TenantSettingValues> {
    const previous = await this.#store.get(tenant);
    const next: TenantSettingValues = { ...previous, ...change };
    if (next.pageBreakReconciliation === previous.pageBreakReconciliation) return next;
    const at = this.#now();
    await this.#store.set(tenant, next, actor, at);
    await this.#audit?.record([
      {
        id: uuid7(),
        tenant,
        doc: null,
        actor,
        kind: 'tenant_setting.changed',
        data: { previous, settings: next },
        at,
      },
    ]);
    return next;
  }
}
