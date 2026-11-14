/**
 * Encrypted backups and the audit of their use (06 §13; 10 §3.7; BE-096).
 *
 * A backup is one file: the database as plain SQL (what `pg_dump` writes) and the sealed objects
 * of the tenants named, copied as they are stored, so the object bytes stay sealed under the
 * tenants' own keys. The whole bundle is sealed again with a fresh AES-256-GCM data key, and that
 * data key is wrapped with the backup key. The backup key is a secret of its own: it is not one of
 * the tenants' keys in `KeyService` and not the live database's credentials, so a stolen backup
 * does not open a live key and a live key does not open a backup (BE-096 criterion 1).
 *
 * Every write, read, copy and rehearsed restore of a backup adds an audit event for each tenant it
 * covers (BE-096 criterion 2). The event names the actor, the backup, and counts; it holds no
 * content. A rehearsal records its date, its result and the check of each sample document against
 * the hash the live system had (BE-096 criterion 3; BE-081).
 *
 * Layout (version 1): `DEBK\x01` | header length (uint32, big endian) | header JSON | body. The header
 * is `{v, kek, wrapIv, wrapped, iv}` in base64, where `kek` names the backup key. The body is
 * AES-256-GCM of the bundle JSON, with the header as associated data, so the header cannot be
 * changed without the body failing to open.
 *
 * Not decided here (the spec leaves it open): the backup key's storage and rotation, the retention
 * period, and whether a backup is streamed. The bundle is held in memory, so this is the module
 * for backups of the sizes the test environment makes, not for a large production backup.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { MemoryObjectStore, type ObjectStore } from '../objects/store.ts';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import type {
  AuditEvent,
  AuditStore,
  CheckpointIndex,
  DocRef,
  LogStore,
} from '../storage/types.ts';
import { rebuild, verifyCheckpoint, type RecoveryStores } from './recovery.ts';

const MAGIC = Buffer.from('DEBK\x01', 'latin1');
const VERSION = 1;
const TAG_BYTES = 16;
const IV_BYTES = 12;

/** A backup could not be written, opened or checked. The message names the rule, not the content. */
export class BackupError extends Error {
  override name = 'BackupError';
}

/** The backup key: 256 bits, kept apart from the tenants' keys (BE-096 criterion 1). */
export interface BackupKey {
  /** A fingerprint of the key, written into each backup's header; it reveals nothing about the key. */
  readonly id: string;
  readonly key: Buffer;
}

/** Reads a backup key from base64 text of 32 bytes. */
export function backupKey(base64: string): BackupKey {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new BackupError('the backup key is 32 bytes, base64 encoded');
  const id = `backup-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  return { id, key };
}

/** One object of a tenant, as it is stored (sealed under the tenant's key, when it is sealed). */
export interface BackupObject {
  key: string;
  /** Base64 of the stored bytes. */
  data: string;
}

/** The content of a backup, before it is sealed. */
export interface BackupBundle {
  v: 1;
  /** Unix milliseconds of the write. */
  createdAt: number;
  tenants: string[];
  /** Base64 of the database as plain SQL. */
  database: string;
  objects: BackupObject[];
}

export interface BackupSource {
  /** The database as plain SQL (`pg_dump --format=plain --no-owner --no-privileges`). */
  dumpDatabase(): Promise<Uint8Array>;
  /** The object store the tenants' objects are read from, raw. */
  objects: ObjectStore;
}

export interface BackupReceipt {
  key: string;
  /** Bytes of the sealed file. */
  bytes: number;
  /** SHA-256 of the sealed file, lower-case hex. */
  sha256: string;
  tenants: string[];
  objects: number;
  createdAt: number;
}

export interface AuditOptions {
  audit: AuditStore;
  actor: string;
  now?: () => number;
}

export function sealBackup(plain: Uint8Array, kek: BackupKey): Buffer {
  const dataKey = randomBytes(32);
  const wrapIv = randomBytes(IV_BYTES);
  const wrap = createCipheriv('aes-256-gcm', kek.key, wrapIv);
  const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final(), wrap.getAuthTag()]);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.from(
    JSON.stringify({
      v: VERSION,
      kek: kek.id,
      wrapIv: wrapIv.toString('base64'),
      wrapped: wrapped.toString('base64'),
      iv: iv.toString('base64'),
    }),
    'utf8',
  );
  const seal = createCipheriv('aes-256-gcm', dataKey, iv);
  seal.setAAD(header);
  const body = Buffer.concat([seal.update(plain), seal.final(), seal.getAuthTag()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header, body]);
}

interface Header {
  v: number;
  kek: string;
  wrapIv: string;
  wrapped: string;
  iv: string;
}

/** Opens a sealed backup; refuses a file sealed with another key or one that was changed. */
export function openBackup(sealed: Uint8Array, kek: BackupKey): Buffer {
  const buf = Buffer.from(sealed);
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC))
    throw new BackupError('the file is not a backup');
  const headerLength = buf.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  const end = start + headerLength;
  if (end > buf.length) throw new BackupError('the backup header is cut short');
  const headerBytes = buf.subarray(start, end);
  let header: Header;
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as Header;
  } catch {
    throw new BackupError('the backup header is not JSON');
  }
  if (header.v !== VERSION)
    throw new BackupError(`backup version ${String(header.v)} is not supported`);
  if (header.kek !== kek.id) throw new BackupError('the backup was sealed with another backup key');
  let dataKey: Buffer;
  try {
    const wrapped = Buffer.from(header.wrapped, 'base64');
    const unwrap = createDecipheriv('aes-256-gcm', kek.key, Buffer.from(header.wrapIv, 'base64'));
    unwrap.setAuthTag(wrapped.subarray(wrapped.length - TAG_BYTES));
    dataKey = Buffer.concat([
      unwrap.update(wrapped.subarray(0, wrapped.length - TAG_BYTES)),
      unwrap.final(),
    ]);
  } catch {
    throw new BackupError('the backup key does not open the backup');
  }
  const body = buf.subarray(end);
  if (body.length < TAG_BYTES) throw new BackupError('the backup body is cut short');
  try {
    const open = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(header.iv, 'base64'));
    open.setAAD(headerBytes);
    open.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([open.update(body.subarray(0, body.length - TAG_BYTES)), open.final()]);
  } catch {
    throw new BackupError('the backup is damaged: its body does not verify');
  }
}

/** The tenants' objects are read under their prefix; a key outside the prefix is not copied. */
function tenantPrefix(tenant: string): string {
  return `tenants/${tenant}/`;
}

/** Audit events for one action, one per tenant the backup covers. Counts and identifiers only. */
async function auditEach(
  opts: AuditOptions,
  tenants: readonly string[],
  kind: string,
  data: Record<string, unknown>,
): Promise<void> {
  const at = (opts.now ?? Date.now)();
  const events: AuditEvent[] = tenants.map((tenant) => ({
    id: uuid7(),
    tenant,
    doc: null,
    actor: opts.actor,
    kind,
    data,
    at,
  }));
  if (events.length) await opts.audit.record(events);
}

/**
 * Writes an encrypted backup of the database and of the objects of `tenants` to `target` under
 * `targetKey`, which must not exist yet. Records `backup.written` for each tenant.
 */
export async function writeBackup(opts: {
  source: BackupSource;
  tenants: readonly string[];
  kek: BackupKey;
  target: ObjectStore;
  targetKey: string;
  audit: AuditOptions;
}): Promise<BackupReceipt> {
  const createdAt = (opts.audit.now ?? Date.now)();
  const database = await opts.source.dumpDatabase();
  const objects: BackupObject[] = [];
  for (const tenant of opts.tenants) {
    for (const key of await opts.source.objects.list(tenantPrefix(tenant))) {
      const data = await opts.source.objects.get(key);
      if (!data) throw new BackupError('an object listed for the backup has gone');
      objects.push({ key, data: Buffer.from(data).toString('base64') });
    }
  }
  const bundle: BackupBundle = {
    v: 1,
    createdAt,
    tenants: [...opts.tenants],
    database: Buffer.from(database).toString('base64'),
    objects,
  };
  const sealed = sealBackup(Buffer.from(JSON.stringify(bundle), 'utf8'), opts.kek);
  await opts.target.put(opts.targetKey, sealed, {
    contentType: 'application/octet-stream',
    ifAbsent: true,
  });
  const sha256 = createHash('sha256').update(sealed).digest('hex');
  await auditEach(opts.audit, opts.tenants, 'backup.written', {
    backup: opts.targetKey,
    sha256,
    bytes: sealed.length,
    objects: objects.length,
  });
  return {
    key: opts.targetKey,
    bytes: sealed.length,
    sha256,
    tenants: [...opts.tenants],
    objects: objects.length,
    createdAt,
  };
}

/**
 * Reads and opens a backup, and records `backup.read` for each tenant it covers. A refused or
 * damaged backup is not read on, so nothing is recorded for it.
 */
export async function readBackup(opts: {
  target: ObjectStore;
  key: string;
  kek: BackupKey;
  audit: AuditOptions;
}): Promise<BackupBundle> {
  const sealed = await opts.target.get(opts.key);
  if (!sealed) throw new BackupError('no backup has that key');
  const bundle = JSON.parse(openBackup(sealed, opts.kek).toString('utf8')) as BackupBundle;
  await auditEach(opts.audit, bundle.tenants, 'backup.read', { backup: opts.key });
  return bundle;
}

/**
 * Copies a backup to another key of the target without opening it, so the copy stays sealed the
 * same way. Records `backup.copied` for each tenant the backup covers.
 */
export async function copyBackup(opts: {
  target: ObjectStore;
  from: string;
  to: string;
  kek: BackupKey;
  audit: AuditOptions;
}): Promise<void> {
  const sealed = await opts.target.get(opts.from);
  if (!sealed) throw new BackupError('no backup has that key');
  const tenants = (JSON.parse(openBackup(sealed, opts.kek).toString('utf8')) as BackupBundle)
    .tenants;
  await opts.target.put(opts.to, sealed, {
    contentType: 'application/octet-stream',
    ifAbsent: true,
  });
  await auditEach(opts.audit, tenants, 'backup.copied', { backup: opts.from, copy: opts.to });
}

export interface SampleCheck {
  tenant: string;
  doc: string;
  /** The hash of the document at its head in the live system, taken before the backup. */
  expected: string;
}

export interface SampleResult {
  tenant: string;
  doc: string;
  seq: number;
  hash: string;
  ok: boolean;
  /** Why a sample failed, naming the rule and not the content. */
  reason?: string;
}

export interface RehearsalRecord {
  /** ISO 8601 of the rehearsal. */
  date: string;
  backup: string;
  result: 'passed' | 'failed';
  samples: SampleResult[];
}

/** A restored copy of the database: the stores the recovery procedure reads, and how to drop it. */
export interface RestoredCopy {
  logs: LogStore;
  /** Checks the hash chain of a document (and its payloads when asked), as BE-081's `verify` does. */
  verify(
    ref: DocRef,
    opts: { payloads?: boolean },
  ): Promise<{ ok: boolean; seq?: number | undefined }>;
  index: CheckpointIndex;
  close(): Promise<void>;
}

/**
 * A restore rehearsal (BE-096 criterion 3): restores the bundle's database into a copy the caller
 * provides, puts the bundle's objects into memory, and checks each sample document with the recovery
 * procedure of BE-081 (the chain, the hash at the head against the live hash, and every recorded
 * checkpoint against a replay). Records `backup.rehearsed` for each tenant the samples name, with
 * the date, the result and the sample checks, and returns the record.
 */
export async function rehearse(opts: {
  bundle: BackupBundle;
  backup: string;
  restore: (database: Uint8Array) => Promise<RestoredCopy>;
  samples: readonly SampleCheck[];
  audit: AuditOptions;
}): Promise<RehearsalRecord> {
  const date = new Date((opts.audit.now ?? Date.now)()).toISOString();
  const objects = new MemoryObjectStore();
  for (const o of opts.bundle.objects) await objects.put(o.key, Buffer.from(o.data, 'base64'));
  const copy = await opts.restore(Buffer.from(opts.bundle.database, 'base64'));
  const samples: SampleResult[] = [];
  try {
    const stores: RecoveryStores = {
      logs: copy.logs,
      checkpoints: new ObjectCheckpointStore(objects),
      index: copy.index,
    };
    for (const s of opts.samples) {
      const ref: DocRef = { tenant: s.tenant, doc: s.doc };
      samples.push(await checkSample(stores, copy, ref, s.expected));
    }
  } finally {
    await copy.close();
  }
  const result = samples.every((s) => s.ok) ? 'passed' : 'failed';
  const record: RehearsalRecord = { date, backup: opts.backup, result, samples };
  const tenants = [...new Set(opts.samples.map((s) => s.tenant))];
  for (const tenant of tenants) {
    await auditEach(opts.audit, [tenant], 'backup.rehearsed', {
      backup: opts.backup,
      date,
      result,
      samples: samples
        .filter((s) => s.tenant === tenant)
        .map((s) => ({ doc: s.doc, seq: s.seq, ok: s.ok })),
    });
  }
  return record;
}

async function checkSample(
  stores: RecoveryStores,
  copy: RestoredCopy,
  ref: DocRef,
  expected: string,
): Promise<SampleResult> {
  const base = { tenant: ref.tenant, doc: ref.doc };
  try {
    const verdict = await copy.verify(ref, { payloads: true });
    if (!verdict.ok)
      return {
        ...base,
        seq: verdict.seq ?? -1,
        hash: '',
        ok: false,
        reason: 'the hash chain is broken',
      };
    const head = await rebuild(stores, ref);
    if (head.hash !== expected)
      return {
        ...base,
        seq: head.seq,
        hash: head.hash,
        ok: false,
        reason: 'the head hash differs from the live hash',
      };
    for (const row of await copy.index.list(ref)) {
      const v = await verifyCheckpoint(stores, ref, row.seq);
      if (!v.ok)
        return {
          ...base,
          seq: head.seq,
          hash: head.hash,
          ok: false,
          reason: `checkpoint ${v.seq} differs from its replay`,
        };
    }
    return { ...base, seq: head.seq, hash: head.hash, ok: true };
  } catch (e) {
    return {
      ...base,
      seq: -1,
      hash: '',
      ok: false,
      reason: e instanceof Error ? e.name : 'unknown error',
    };
  }
}
