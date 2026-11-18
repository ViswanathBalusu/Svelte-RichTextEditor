/**
 * Object keys of assets (06 §4.2): uploads wait in `tenants/{tenant}/quarantine/{asset}`, and the
 * worker alone writes `tenants/{tenant}/assets/{sha256}`. The tenant always comes from the job's
 * row, never from its payload (BE-049 criterion 5), and every key is checked before it is used.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

export function isSha256(v: unknown): v is string {
  return typeof v === 'string' && SHA256.test(v);
}

export const assetKeys = {
  prefix(tenant: string): string {
    if (!isUuid(tenant)) throw new RangeError('a tenant identifier is a lower-case UUID');
    return `tenants/${tenant}/`;
  },
  quarantine(tenant: string, asset: string): string {
    if (!isUuid(asset)) throw new RangeError('an asset identifier is a lower-case UUID');
    return `${assetKeys.prefix(tenant)}quarantine/${asset}`;
  },
  final(tenant: string, sha256: string): string {
    if (!isSha256(sha256)) throw new RangeError('an asset key is a lower-case SHA-256');
    return `${assetKeys.prefix(tenant)}assets/${sha256}`;
  },
  /** A file an export job wrote: `tenants/{tenant}/exports/{job}/{name}` (the control plane's key). */
  exportFile(tenant: string, job: string, name: string): string {
    if (!isUuid(job)) throw new RangeError('a job identifier is a lower-case UUID');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
      throw new RangeError('an export file name is one safe segment');
    return `${assetKeys.prefix(tenant)}exports/${job}/${name}`;
  },
  /** The tenant and hash of a final key, or null. */
  parseFinal(key: string): { tenant: string; sha256: string } | null {
    const m = /^tenants\/([0-9a-f-]{36})\/assets\/([0-9a-f]{64})$/.exec(key);
    return m && isUuid(m[1]) ? { tenant: m[1], sha256: m[2]! } : null;
  },
};
