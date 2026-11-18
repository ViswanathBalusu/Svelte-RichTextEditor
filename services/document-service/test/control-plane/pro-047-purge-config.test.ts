// PRO-047 criterion 4: the purge of deleted documents needs a login of its own (HIS-039), set by
// DOCEDIT_PURGE_DATABASE_URL. Without it no purge task runs, and the retention is 30 days (owner
// decision 30) unless DOCEDIT_PURGE_AFTER_DAYS says otherwise.
import { describe, expect, it } from 'vitest';
import { checkConfig, configFromEnv } from '../../src/config.ts';

describe('the configuration of the purge of deleted documents (PRO-047)', () => {
  it('keeps deleted documents 30 days by default, and the period can be changed', () => {
    expect(configFromEnv({}).purgeAfterDays).toBe(30);
    expect(configFromEnv({ DOCEDIT_PURGE_AFTER_DAYS: '7' }).purgeAfterDays).toBe(7);
  });

  it('reads the purge login from DOCEDIT_PURGE_DATABASE_URL, absent by default', () => {
    expect(configFromEnv({}).purgeDatabaseUrl).toBeNull();
    const c = configFromEnv({
      DOCEDIT_DATABASE_URL: 'postgres://svc@db/x',
      DOCEDIT_PURGE_DATABASE_URL: 'postgres://purge@db/x',
    });
    expect(c.purgeDatabaseUrl).toBe('postgres://purge@db/x');
    expect(() => checkConfig(c)).not.toThrow();
  });

  it('refuses a purge login without a primary database', () => {
    expect(() =>
      checkConfig(configFromEnv({ DOCEDIT_PURGE_DATABASE_URL: 'postgres://p@db/x' })),
    ).toThrow(/DOCEDIT_PURGE_DATABASE_URL needs DOCEDIT_DATABASE_URL/);
  });
});
