// BE-007 criterion 4: the `authority-service` profile against the authority service deployed as a
// container. The image is built from services/authority-service/Containerfile and run with Podman
// from the options of services/authority-service/compose.json (test/targets/authority-container.ts);
// the kit is given the container's address and nothing else. The restart scenario kills the
// container and starts it again. It builds and runs containers, so it is off unless
// DOCEDIT_AUTHORITY_CONTAINER=1:
//
//   $env:DOCEDIT_AUTHORITY_CONTAINER = '1'
//   pnpm exec vitest run --project node packages/tck/test/be-007-authority-container.test.ts
//
// The containers have names ending in -w5 and are removed at the end. The same profile against
// the service as a process is pro-125-authority-service.reference.test.ts.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHORITY_CALLS } from '../src/authority-client.ts';
import type { KitReport } from '../src/report.ts';
import { runKit } from '../src/runner.ts';
import {
  startAuthorityContainer,
  type ContainerFacts,
  type StartedAuthorityContainer,
} from './targets/authority-container.ts';
import { ROOT } from './targets/reference.ts';

const run = promisify(execFile);
const enabled = process.env['DOCEDIT_AUTHORITY_CONTAINER'] === '1';
const IMAGE = 'localhost/docedit-authority-service:w5-test';
const NAME = 'docedit-authority-kit-w5';

describe.skipIf(!enabled)(
  'the authority-service profile against the deployed container (BE-007 criterion 4)',
  () => {
    let target: StartedAuthorityContainer;
    let report: KitReport;
    let before: ContainerFacts;
    let after: ContainerFacts;
    let restarts = 0;

    beforeAll(async () => {
      target = await startAuthorityContainer({ name: NAME, image: IMAGE, build: true });
      before = await target.inspect();
      report = await runKit({
        discovery: '',
        credential: '',
        testMode: false,
        profiles: ['authority-service'],
        authorityService: {
          url: target.url,
          restart: async () => {
            restarts++;
            return target.restart();
          },
        },
      });
      after = await target.inspect();
    }, 900_000);

    afterAll(async () => {
      await target?.stop();
    }, 120_000);

    const scenarios = () => report.profiles.flatMap((p) => p.scenarios);
    const outcome = (id: string) => scenarios().find((x) => x.id === id);

    it('passes with nothing but the address of the container', async () => {
      expect(report.bootstrap.ok).toBe(true);
      const failed = scenarios().filter((x) => x.outcome === 'failed');
      expect(
        failed.map(
          (f) => `${f.id}: ${f.failure?.message} ${f.failure?.expected} ${f.failure?.received}`,
        ),
        await target.logs(),
      ).toEqual([]);
      expect(report.profiles).toHaveLength(1);
      expect(report.profiles[0]!.outcome).toBe('passed');
      expect(report.ok).toBe(true);
      // The one scenario that does not run: this container was started without a bearer token.
      expect(
        scenarios()
          .filter((x) => x.outcome !== 'passed')
          .map((x) => `${x.id}: ${x.outcome}`),
      ).toEqual(['authority-service.access: skipped']);
    });

    it.each([
      ['authority-service.capabilities'],
      ['authority-service.open-materialise'],
      ['authority-service.apply-commit'],
      ['authority-service.map-ranges'],
      ['authority-service.history-calls'],
      ['authority-service.evaluate-rules'],
      ['authority-service.migrate'],
      ['authority-service.canonical-hash'],
      ['authority-service.steps'],
      ['authority-service.restart'],
    ])('%s passes against the container', (id) => {
      expect(outcome(id)?.outcome).toBe('passed');
    });

    it('covers the calls of 05 §10 and runs the three fixture sets through the container', () => {
      const caps = outcome('authority-service.capabilities');
      for (const call of AUTHORITY_CALLS.filter((c) => c !== 'migrate'))
        expect(caps?.notes.join(' '), call).toMatch(new RegExp(`\\b${call}\\b`));
      expect(outcome('authority-service.steps')?.notes.join(' ')).toMatch(
        /apply cases of pm-steps\/1/,
      );
      expect(outcome('authority-service.evaluate-rules')?.notes.join(' ')).toMatch(/rules cases/);
      expect(outcome('authority-service.canonical-hash')?.notes.join(' ')).toMatch(/canonical/);
    });

    it('ran against a container of the image, with the options of the compose file, and killed it once', () => {
      expect(before.image).toBe(IMAGE);
      expect(before.readOnlyRoot).toBe(true);
      expect(before.networkMode).toBe('host');
      expect(before.user).toBe('node');
      expect(before.status).toBe('running');
      // The restart scenario killed the container and started it again: one restart, a new start.
      expect(restarts).toBe(1);
      expect(after.status).toBe('running');
      expect(after.startedAt).not.toBe(before.startedAt);
    });

    it('passes from the command line too, as an operator certifies a deployment', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'docedit-be-007-'));
      try {
        const json = join(dir, 'report.json');
        // Exit code 0 is a passed run (cli.ts); a failed run would reject here with code 1.
        await run(
          process.execPath,
          [
            join(ROOT, 'packages/tck/src/cli.ts'),
            '--authority-service',
            target.url,
            '--profile',
            'authority-service',
            '--json',
            json,
            '--quiet',
          ],
          { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
        );
        const fromCli = JSON.parse(readFileSync(json, 'utf8')) as KitReport;
        expect(fromCli.ok).toBe(true);
        expect(fromCli.totals.failed).toBe(0);
        // The command line cannot restart a service, so that scenario is skipped there.
        expect(
          fromCli.profiles
            .flatMap((p) => p.scenarios)
            .filter((x) => x.outcome !== 'passed')
            .map((x) => `${x.id}: ${x.outcome}`)
            .sort(),
        ).toEqual(['authority-service.access: skipped', 'authority-service.restart: skipped']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 600_000);
  },
);

describe.skipIf(!enabled)('the container started with a bearer token (BE-007)', () => {
  const TOKEN = 'tck-container-token';
  let target: StartedAuthorityContainer;

  beforeAll(async () => {
    target = await startAuthorityContainer({
      name: `${NAME}-token`,
      image: IMAGE,
      build: true,
      env: { DOCEDIT_AUTHORITY_TOKEN: TOKEN },
    });
  }, 900_000);

  afterAll(async () => {
    await target?.stop();
  }, 120_000);

  const kit = (token?: string) =>
    runKit({
      discovery: '',
      credential: '',
      testMode: false,
      profiles: ['authority-service'],
      scenarios: ['authority-service.access', 'authority-service.capabilities'],
      authorityService: { url: target.url, ...(token ? { token } : {}) },
    });

  it('passes with the token, and a run without it fails', async () => {
    const withToken = await kit(TOKEN);
    expect(
      withToken.ok,
      JSON.stringify(withToken.profiles[0]?.scenarios.map((s) => s.failure)),
    ).toBe(true);
    expect(withToken.totals).toMatchObject({ passed: 2, failed: 0 });
    expect((await kit()).ok).toBe(false);
  });
});
