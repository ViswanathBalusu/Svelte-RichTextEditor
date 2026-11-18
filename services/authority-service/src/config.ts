/**
 * The settings of the authority service, from the environment (BE-007). Secrets are read from the
 * environment, which a compose file or a chart fills from a secret store; none has a default.
 *
 * | Variable | Meaning | Default |
 * |---|---|---|
 * | `DOCEDIT_AUTHORITY_HOST` | address to bind | `127.0.0.1` |
 * | `DOCEDIT_AUTHORITY_PORT` | port to bind; 0 picks a free one | `8090` |
 * | `DOCEDIT_AUTHORITY_CAPACITY` | documents kept in memory | 64 |
 * | `DOCEDIT_AUTHORITY_ALLOW_MIGRATIONS` | `true` turns `migrate` on (03 §11.3) | off |
 * | `DOCEDIT_AUTHORITY_TOKEN` | bearer token that calls must carry | none |
 * | `DOCEDIT_AUTHORITY_STORAGE_URL` | the caller's storage, for rebuilding a state | none |
 * | `DOCEDIT_AUTHORITY_STORAGE_TOKEN` | bearer token for that storage | none |
 */
import { DEFAULT_CAPACITY } from './service.ts';

export interface AuthorityConfig {
  host: string;
  port: number;
  capacity: number;
  allowMigrations: boolean;
  token?: string;
  storageUrl?: string;
  storageToken?: string;
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): AuthorityConfig {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${name} must be an integer from ${min} to ${max}, not "${raw}"`);
    return n;
  };
  const bool = (name: string): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === '' || raw === 'false') return false;
    if (raw === 'true') return true;
    throw new Error(`${name} must be "true" or "false", not "${raw}"`);
  };
  const text = (name: string): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const token = text('DOCEDIT_AUTHORITY_TOKEN');
  const storageUrl = text('DOCEDIT_AUTHORITY_STORAGE_URL');
  const storageToken = text('DOCEDIT_AUTHORITY_STORAGE_TOKEN');
  if (storageUrl !== undefined && !/^https?:\/\//.test(storageUrl))
    throw new Error('DOCEDIT_AUTHORITY_STORAGE_URL must be an http or https URL');
  return {
    host: text('DOCEDIT_AUTHORITY_HOST') ?? '127.0.0.1',
    port: int('DOCEDIT_AUTHORITY_PORT', 8090, 0, 65535),
    capacity: int('DOCEDIT_AUTHORITY_CAPACITY', DEFAULT_CAPACITY, 1, 1_000_000),
    allowMigrations: bool('DOCEDIT_AUTHORITY_ALLOW_MIGRATIONS'),
    ...(token === undefined ? {} : { token }),
    ...(storageUrl === undefined ? {} : { storageUrl }),
    ...(storageToken === undefined ? {} : { storageToken }),
  };
}
