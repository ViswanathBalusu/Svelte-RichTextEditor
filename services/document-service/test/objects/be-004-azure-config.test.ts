// BE-004 criterion 4 (lane V-BE-001-014): the Azure Blob adapter is selected in configuration, and
// the service starts with no S3 setting. The test starts the real `startService` from
// `configFromEnv`, writes an object through the service's own store and reads it back with a
// separate Azure client, so the bytes are in Azurite and not in process memory. Its own container,
// removed afterwards. Needs Azurite (see test/objects/be-004-azure-blob.test.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { AzureBlobObjectStore } from '../../src/objects/azure.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { objectKeys } from '../../src/objects/store.ts';
import { startService, type Service } from '../../src/server.ts';
import { settings as testSettings } from '../support/env.ts';

// The public, well-known key of the Azurite emulator's devstoreaccount1 account. It is not a secret.
const EMULATOR_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
// Read as in be-004-azure-blob.test.ts: the test-environment settings, then the process
// environment, then the port the BE-004 evidence used.
const ENDPOINT =
  testSettings()['DOCEDIT_AZURITE_ENDPOINT'] ??
  process.env['DOCEDIT_AZURITE_ENDPOINT'] ??
  'http://127.0.0.1:57321/devstoreaccount1';
const container = `docedit-v-be-001-014-cfg-${randomUUID().slice(0, 8)}`;

const azureEnv = {
  DOCEDIT_LISTEN_HOST: '127.0.0.1',
  DOCEDIT_LISTEN_PORT: '0',
  DOCEDIT_ENVIRONMENT: 'test',
  DOCEDIT_AZURE_ACCOUNT: 'devstoreaccount1',
  DOCEDIT_AZURE_ENDPOINT: ENDPOINT,
  DOCEDIT_AZURE_KEY: EMULATOR_KEY,
  DOCEDIT_AZURE_CONTAINER: container,
};

const store = new AzureBlobObjectStore({
  endpoint: ENDPOINT,
  account: 'devstoreaccount1',
  accountKey: EMULATOR_KEY,
  container,
});

const started: Service[] = [];

// Probed before the tests are declared, so that `describe.skipIf` sees the result (a flag set in
// `beforeAll` is read too late: skip conditions are evaluated at collection time). Creating the
// run's own container is the probe; it is deleted in `afterAll`. Only the test that starts the
// service needs Azurite; the configuration tests run everywhere.
async function azuriteUnavailable(): Promise<string | null> {
  try {
    await store.createContainer();
    return null;
  } catch (e) {
    return `Azurite is not reachable at ${ENDPOINT} (${e instanceof Error ? e.message : String(e)}); run it with podman and set DOCEDIT_AZURITE_ENDPOINT (see the BE-004 evidence)`;
  }
}

const skip = await azuriteUnavailable();
if (skip) console.warn(`be-004-azure-config: service test skipped: ${skip}`);

afterAll(async () => {
  for (const s of started) await s.close().catch(() => undefined);
  if (skip === null) await store.deleteContainer().catch(() => undefined);
});

describe('the Azure Blob store is selected through configuration (BE-004 criterion 4)', () => {
  it('takes the Azure settings without any S3 setting', () => {
    const config = configFromEnv(azureEnv);
    expect(config.s3).toBeNull();
    expect(config.azure).toEqual({
      endpoint: ENDPOINT,
      account: 'devstoreaccount1',
      accountKey: EMULATOR_KEY,
      container,
    });
  });

  it('defaults the endpoint to the account name when none is given', () => {
    const config = configFromEnv({ DOCEDIT_AZURE_ACCOUNT: 'acct' });
    expect(config.azure?.endpoint).toBe('https://acct.blob.core.windows.net');
    expect(config.azure?.container).toBe('docedit');
  });

  it('refuses two object stores at once', () => {
    expect(() =>
      configFromEnv({
        ...azureEnv,
        DOCEDIT_S3_HOST: '127.0.0.1',
        DOCEDIT_S3_PORT: '57070',
      }),
    ).toThrow(/choose one object store/);
  });
});

describe.skipIf(skip !== null)('the service on Azurite (BE-004 criterion 4)', () => {
  it('starts the service with the Azure store and no S3 settings, and writes to Azurite', async () => {
    const config = configFromEnv(azureEnv);
    const service = await startService({ config });
    started.push(service);
    expect(service.parts.objects).toBeInstanceOf(AzureBlobObjectStore);
    expect(service.parts.objects).not.toBeInstanceOf(S3ObjectStore);

    const key = objectKeys.quarantine(randomUUID(), randomUUID());
    await service.parts.objects.put(key, new TextEncoder().encode('from the service'));
    const back = await store.get(key);
    expect(back && new TextDecoder().decode(back)).toBe('from the service');
    await store.delete(key);
  });
});
