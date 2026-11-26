/**
 * The periodic salted root over a tenant's chain heads (SEC-065; ADR 0409 decisions 1 and 2; 10
 * §3.3, §6; 08 §12). One root per tenant per period, built from the latest head of every document
 * of the tenant, changed or not, so that a later check of any head finds a root that covers it.
 *
 * What is sent to a public log later (SEC-066) is the text of `publicEntryText` and nothing else:
 * the period, the root and the number of leaves. This module builds the root and keeps, for the
 * tenant only, the heads behind it so that an inclusion proof can be given with the salt.
 *
 * The salt is a secret of the tenant (ADR 0409 decision 2). It is 32 random bytes, wrapped with the
 * tenant's `unwrap` key in `KeyService` (`tenant-salt-<tenant>`) and stored only wrapped, in
 * versions. A rotation adds a version and keeps the old ones, so roots built under an old salt can
 * still be proved. Destroying the tenant's key (`destroy`) makes every salt unrecoverable: the
 * public entries then link to nothing. The salt is never written to a log, a webhook, an audit
 * event, a stored record or the public entry.
 *
 * Nothing here is on the path of a commit: rooms neither wait for a run nor read its records.
 */
import { randomBytes } from 'node:crypto';
import {
  buildPublicRoot,
  publicEntryText,
  publicRootProof,
  type PathStep,
  type SaltedHead,
} from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { objectKeys } from '../objects/store.ts';
import { wrapDataKey, type KeyService } from '../storage/key-service.ts';
import type { AuditStore } from '../storage/types.ts';
import type { HeadAnchorFiles } from './head-anchoring.ts';

/** The latest head of one document: what a leaf is made of, with the document it belongs to. */
export interface DocumentHead extends SaltedHead {
  doc: string;
}

/** Where the latest heads come from: the log's head rows, one per document with a commit. */
export interface PublicRootHeads {
  /** The latest head of every document of the tenant that has one, changed or not. */
  latestHeads(tenant: string): Promise<DocumentHead[]>;
}

/** One version of a tenant's salt, as it is stored: wrapped, never plain. */
export interface SaltRow {
  readonly version: number;
  readonly keyId: string;
  readonly wrapped: Uint8Array;
}

/** The rows of the salts. A PostgreSQL implementation stores the same fields. */
export interface TenantSaltStore {
  /** The newest version of the tenant's salt, or null. */
  latest(tenant: string): Promise<SaltRow | null>;
  get(tenant: string, version: number): Promise<SaltRow | null>;
  /** Adds a version. False when that version exists already (another run was first). */
  insert(tenant: string, row: SaltRow): Promise<boolean>;
}

export class MemoryTenantSaltStore implements TenantSaltStore {
  readonly #rows = new Map<string, SaltRow[]>();

  async latest(tenant: string): Promise<SaltRow | null> {
    const rows = this.#rows.get(tenant);
    return rows && rows.length > 0 ? rows[rows.length - 1]! : null;
  }

  async get(tenant: string, version: number): Promise<SaltRow | null> {
    return this.#rows.get(tenant)?.find((r) => r.version === version) ?? null;
  }

  async insert(tenant: string, row: SaltRow): Promise<boolean> {
    const rows = this.#rows.get(tenant) ?? [];
    if (rows.some((r) => r.version === row.version)) return false;
    rows.push({ ...row, wrapped: Uint8Array.from(row.wrapped) });
    this.#rows.set(tenant, rows);
    return true;
  }
}

/** The tenant's key in `KeyService` that wraps its salts. */
export function tenantSaltKeyId(tenant: string): string {
  return `tenant-salt-${tenant.toLowerCase()}`;
}

/** The tenant has no salt of that version, or its key is gone. */
export class TenantSaltUnavailableError extends Error {
  override name = 'TenantSaltUnavailableError';
}

/** The salts of tenants, under the tenant's key rules. */
export class TenantSalts {
  readonly #store: TenantSaltStore;
  readonly #keys: KeyService;

  constructor(store: TenantSaltStore, keys: KeyService) {
    this.#store = store;
    this.#keys = keys;
  }

  /** The newest salt of the tenant with its version; created, with the tenant's key, on first use. */
  async current(tenant: string): Promise<{ version: number; salt: Uint8Array }> {
    const latest = await this.#store.latest(tenant);
    if (latest === null) return this.#add(tenant, 1);
    return { version: latest.version, salt: await this.#open(latest) };
  }

  /** A salt of the tenant by version. Rejects when it is not there or the tenant's key is gone. */
  async get(tenant: string, version: number): Promise<Uint8Array> {
    const row = await this.#store.get(tenant, version);
    if (row === null)
      throw new TenantSaltUnavailableError(`the tenant has no salt of version ${version}`);
    return this.#open(row);
  }

  /** Adds a new version of the salt. Earlier versions stay, so earlier roots can still be proved. */
  async rotate(tenant: string): Promise<{ version: number }> {
    const latest = await this.#store.latest(tenant);
    const added = await this.#add(tenant, (latest?.version ?? 0) + 1);
    return { version: added.version };
  }

  /** Destroys the tenant's salt key: no salt can be unwrapped again, in any copy or backup. */
  async destroy(tenant: string): Promise<void> {
    await this.#keys.destroy(tenantSaltKeyId(tenant));
  }

  async #add(tenant: string, version: number): Promise<{ version: number; salt: Uint8Array }> {
    const keyId = tenantSaltKeyId(tenant);
    if (!(await this.#keys.enabled(keyId))) {
      try {
        await this.#keys.create(keyId, 'unwrap');
      } catch (e) {
        // Another run created it first, or it is disabled or destroyed.
        if (!(await this.#keys.enabled(keyId)))
          throw new TenantSaltUnavailableError(`the tenant's salt key cannot be used`, {
            cause: e,
          });
      }
    }
    const salt = Uint8Array.from(randomBytes(32));
    const wrapped = await wrapDataKey(await this.#keys.publicJwk(keyId), salt);
    if (!(await this.#store.insert(tenant, { version, keyId, wrapped })))
      return this.current(tenant);
    return { version, salt };
  }

  async #open(row: SaltRow): Promise<Uint8Array> {
    try {
      return await this.#keys.unwrap(row.keyId, row.wrapped);
    } catch (e) {
      throw new TenantSaltUnavailableError(`the tenant's salt cannot be unwrapped`, { cause: e });
    }
  }
}

/** A root as the store holds it. It holds no salt and no head. */
export interface StoredPublicRoot {
  /** The period's end, RFC 3339 in UTC with milliseconds. */
  to: string;
  /** The end of the previous period, or null. */
  from: string | null;
  root: string;
  leaves: number;
  /** The version of the salt the leaves were made with. */
  saltVersion: number;
  /** The public entry text: what a log is sent. */
  entry: string;
  objectKey: string;
  headsKey: string;
}

/** The roots of tenants. A PostgreSQL implementation stores the same fields. */
export interface PublicRootStore {
  latest(tenant: string): Promise<StoredPublicRoot | null>;
  get(tenant: string, to: string): Promise<StoredPublicRoot | null>;
  /** Stores a root. False when the tenant has one at that time or later already. */
  record(tenant: string, root: StoredPublicRoot): Promise<boolean>;
}

export class MemoryPublicRootStore implements PublicRootStore {
  readonly #rows = new Map<string, StoredPublicRoot[]>();

  async latest(tenant: string): Promise<StoredPublicRoot | null> {
    const rows = this.#rows.get(tenant);
    return rows && rows.length > 0 ? rows[rows.length - 1]! : null;
  }

  async get(tenant: string, to: string): Promise<StoredPublicRoot | null> {
    return this.#rows.get(tenant)?.find((r) => r.to === to) ?? null;
  }

  async record(tenant: string, root: StoredPublicRoot): Promise<boolean> {
    const rows = this.#rows.get(tenant) ?? [];
    if (rows.length > 0 && rows[rows.length - 1]!.to >= root.to) return false;
    rows.push({ ...root });
    this.#rows.set(tenant, rows);
    return true;
  }
}

export const PUBLIC_ROOT_FILE_FORMAT = 'docedit-public-root-file/1';
export const PUBLIC_ROOT_HEADS_FORMAT = 'docedit-public-root-heads/1';

export interface PublicRootsDeps {
  heads: PublicRootHeads;
  salts: TenantSalts;
  store: PublicRootStore;
  /** Write-once storage for the root file and the heads file. */
  files: HeadAnchorFiles;
  audit: AuditStore;
  /** How long the files are retained in write-once storage, ms from the period's end. */
  retainMs: number;
  now: () => number;
}

export type PublicRootRun =
  | { built: false; reason: 'no-heads' }
  | { built: true; to: string; from: string | null; root: string; leaves: number; entry: string };

/** A run stopped. `stage` says where. */
export class PublicRootError extends Error {
  override name = 'PublicRootError';
  readonly stage: 'heads' | 'salt' | 'tree' | 'store' | 'record' | 'proof';
  constructor(stage: PublicRootError['stage'], message: string, cause?: unknown) {
    super(
      `public root stopped at ${stage}: ${message}`,
      cause === undefined ? undefined : { cause },
    );
    this.stage = stage;
  }
}

/** The proof a relying party is handed: the entry, the salt, the head and the path. */
export interface PublicRootProofBundle {
  /** The public entry text the root was sent as. */
  entry: string;
  /** The salt version and the salt, lower-case hexadecimal. The tenant hands it over. */
  saltVersion: number;
  salt: string;
  head: SaltedHead;
  path: PathStep[];
}

const iso = (ms: number): string => new Date(ms).toISOString();
const toHexText = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class PublicRoots {
  readonly #d: PublicRootsDeps;

  constructor(deps: PublicRootsDeps) {
    if (!Number.isSafeInteger(deps.retainMs) || deps.retainMs < 1)
      throw new RangeError('public root: retainMs must be a positive whole number');
    this.#d = deps;
  }

  /**
   * Builds the root for the period that ends at `now`. A tenant with no document that has a head
   * gets no root. Rejects with `PublicRootError` when it stops; what was stored before stays.
   */
  async run(tenant: string, now: number = this.#d.now()): Promise<PublicRootRun> {
    const { heads: source, salts, store, files } = this.#d;
    let heads: DocumentHead[];
    try {
      heads = await source.latestHeads(tenant);
    } catch (e) {
      throw new PublicRootError('heads', 'the heads could not be read', e);
    }
    if (heads.length === 0) return { built: false, reason: 'no-heads' };

    const to = iso(now);
    const previous = await store.latest(tenant);
    if (previous !== null && previous.to >= to)
      throw new PublicRootError('record', 'the newest root is not older than this run');

    let salt: { version: number; salt: Uint8Array };
    try {
      salt = await salts.current(tenant);
    } catch (e) {
      throw new PublicRootError('salt', 'the tenant salt is not available', e);
    }
    const built = await buildPublicRoot(salt.salt, heads);
    if (!built.ok) throw new PublicRootError('tree', built.reason);
    const text = publicEntryText({
      from: previous?.to ?? null,
      to,
      root: built.root,
      leaves: built.leaves,
    });
    if (!text.ok) throw new PublicRootError('tree', text.reason);

    const objectKey = objectKeys.publicRoot(tenant, to);
    const headsKey = objectKeys.publicRootHeads(tenant, to);
    const retainUntil = now + this.#d.retainMs;
    const enc = new TextEncoder();
    try {
      await files.put(
        headsKey,
        enc.encode(
          `${JSON.stringify({
            format: PUBLIC_ROOT_HEADS_FORMAT,
            heads: [...heads]
              .sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0))
              .map((h) => ({ doc: h.doc, seq: h.seq, chainHead: h.chainHead })),
          })}\n`,
        ),
        retainUntil,
      );
      await files.put(
        objectKey,
        enc.encode(
          `${JSON.stringify({
            format: PUBLIC_ROOT_FILE_FORMAT,
            entry: text.text,
            saltVersion: salt.version,
          })}\n`,
        ),
        retainUntil,
      );
    } catch (e) {
      throw new PublicRootError('store', 'write-once storage refused the files', e);
    }
    const row: StoredPublicRoot = {
      to,
      from: previous?.to ?? null,
      root: built.root,
      leaves: built.leaves,
      saltVersion: salt.version,
      entry: text.text,
      objectKey,
      headsKey,
    };
    let recorded: boolean;
    try {
      recorded = await store.record(tenant, row);
    } catch (e) {
      throw new PublicRootError('record', 'the root could not be recorded', e);
    }
    if (!recorded) throw new PublicRootError('record', 'another run recorded a root first');
    await this.#d.audit.record([
      {
        id: uuid7(),
        tenant,
        doc: null,
        actor: 'system',
        kind: 'public-root.built',
        // No salt, no head, no document: the period, the root and the count.
        data: {
          to,
          from: row.from,
          leaves: built.leaves,
          root: built.root,
          saltVersion: salt.version,
        },
        at: now,
      },
    ]);
    return {
      built: true,
      to,
      from: row.from,
      root: built.root,
      leaves: built.leaves,
      entry: text.text,
    };
  }

  /**
   * The proof of one document's head in the root of the period that ended at `to`: for the tenant
   * to hand to a relying party. It rebuilds the tree from the stored heads and the salt, and
   * refuses when that does not give the recorded root (a destroyed or wrong salt, a changed file).
   * Rejects with `PublicRootError` at stage `proof`.
   */
  async proof(tenant: string, to: string, doc: string): Promise<PublicRootProofBundle> {
    const row = await this.#d.store.get(tenant, to);
    if (row === null) throw new PublicRootError('proof', 'the tenant has no root for that period');
    const bytes = await this.#d.files.get(row.headsKey);
    if (bytes === null)
      throw new PublicRootError('proof', 'the heads of that period are not stored');
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      format?: string;
      heads?: DocumentHead[];
    };
    if (parsed.format !== PUBLIC_ROOT_HEADS_FORMAT || !Array.isArray(parsed.heads))
      throw new PublicRootError('proof', 'the heads file is not of the expected format');
    const target = parsed.heads.find((h) => h.doc === doc);
    if (target === undefined)
      throw new PublicRootError('proof', 'the document has no head in that period');
    let salt: Uint8Array;
    try {
      salt = await this.#d.salts.get(tenant, row.saltVersion);
    } catch (e) {
      throw new PublicRootError('proof', 'the salt of that period cannot be had', e);
    }
    const head: SaltedHead = { chainHead: target.chainHead, seq: target.seq };
    const built = await publicRootProof(
      salt,
      parsed.heads.map((h) => ({ chainHead: h.chainHead, seq: h.seq })),
      head,
      row.root,
    );
    if (!built.ok) throw new PublicRootError('proof', built.reason);
    return {
      entry: row.entry,
      saltVersion: row.saltVersion,
      salt: toHexText(salt),
      head,
      path: built.path,
    };
  }
}
