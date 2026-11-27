/**
 * BE-005 criteria 1, 2 and 5 against the running stack of `apps/reference-host/compose.json`
 * (lane w5): the document service on PostgreSQL and the S3-compatible store with one export
 * worker, the development tenant seeded from the stack's configuration, and documents with their
 * history intact after the stack is stopped and started on the same volumes.
 *
 * The stack is not started here. Start it first, then run this file with the same settings:
 *
 *   pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 up
 *   DOCEDIT_DEMO_STACK=1 pnpm exec vitest run --project node services/document-service/test/stack/be-005-stack.test.ts
 *
 * Without `DOCEDIT_DEMO_STACK=1` every test is skipped, with a warning. The restart test stops and
 * starts the stack itself (`stack.ps1 down`, then `up`), so it runs only with
 * `DOCEDIT_DEMO_STACK_RESTART=1` as well. Settings come from `apps/reference-host/stack/.env.example`,
 * then the environment (project name and ports), as for stack.ps1. The credentials are the
 * stack's demo values on 127.0.0.1; none is printed.
 *
 * On a machine where Compose cannot start the file (a WSL Podman machine), stack.ps1 starts the
 * same definitions: PostgreSQL and the store as containers, the Node.js services as processes.
 *
 * Started by Compose: with `DOCEDIT_DEMO_COMPOSE=1` the stack is the one `podman compose` (a Compose
 * provider, here podman-compose of infra/tools/podman-compose) started from the same file. Its
 * containers are named `<project>_<service>_1`, its data is in volumes, so `DOCEDIT_DEMO_DATA` names a
 * folder holding copies of `tenants.json` and `setup.json` (volume `stack-data`) and `secrets.json`
 * (volume `secrets-operator`), and the restart test runs the command lines of
 * `DOCEDIT_DEMO_COMPOSE_DOWN` and `DOCEDIT_DEMO_COMPOSE_UP` instead of stack.ps1. The compile
 * container test needs the worker as a process of this host and is skipped in that mode.
 *
 * Criterion 4 is not shown here. The last test inspects the container in which the stack's export
 * worker compiles a job, and that container has no network; the worker itself is a process of the
 * host under stack.ps1 and has the host's network. Which of the two "the export worker container"
 * means is the owner's (decision 60; docs/adr/0421-w5-BE-005-export-worker-network.md).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PgTenantRegistry } from '../../src/control-plane/tenants-pg.ts';
import { createPool } from '../../src/storage/db.ts';
import { documentWithRegions } from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import { cdmSchema } from '@docedit/model/prosemirror';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

const repoRoot = new URL('../../../../', import.meta.url);
const appDir = new URL('apps/reference-host/', repoRoot);

function settings(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of readFileSync(new URL('stack/.env.example', appDir), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of Object.keys(map)) {
    const v = process.env[key];
    if (v) map[key] = v;
  }
  return map;
}

const live = process.env['DOCEDIT_DEMO_STACK'] === '1';
const compose = live && process.env['DOCEDIT_DEMO_COMPOSE'] === '1';
const restart = live && process.env['DOCEDIT_DEMO_STACK_RESTART'] === '1';
if (!live)
  console.warn(
    'BE-005 stack tests skipped: start the stack and set DOCEDIT_DEMO_STACK=1 to run them',
  );

const s = settings();
const dataDir = process.env['DOCEDIT_DEMO_DATA'] ?? fileURLToPath(new URL('.stack/', appDir));
const serviceUrl = `http://127.0.0.1:${s['DOCEDIT_DEMO_SERVICE_PORT']}`;
const cli = s['DOCEDIT_CONTAINER_CLI'] || 'podman';
const project = s['DOCEDIT_DEMO_PROJECT']!;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const readJson = (name: string): Json =>
  JSON.parse(readFileSync(`${dataDir}/${name}`, 'utf8')) as Json;
const credential = (): string => readJson('secrets.json')['apiKey']['credential'] as string;

async function rest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${serviceUrl}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${credential()}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
}

const containerState = (service: string): string =>
  execFileSync(
    cli,
    [
      'inspect',
      '--format',
      '{{.State.Status}}',
      compose ? `${project}_${service}_1` : `${project}-${service}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

const servicePool = () =>
  createPool({
    host: '127.0.0.1',
    port: Number(s['DOCEDIT_DEMO_PG_PORT']),
    database: s['DOCEDIT_DEMO_PG_DATABASE']!,
    user: s['DOCEDIT_DEMO_PG_SERVICE_USER']!,
    password: s['DOCEDIT_DEMO_PG_SERVICE_PASSWORD']!,
    max: 2,
  });

/**
 * Where the export worker starts its compile containers (services/export-worker, container.ts): on
 * a Podman machine through `podman machine ssh`, otherwise with the local command line.
 */
function sandboxRoute(): { machine: string | null } {
  const named = s['DOCEDIT_PODMAN_MACHINE'] || process.env['DOCEDIT_PODMAN_MACHINE'];
  if (named) return { machine: named };
  const text = (args: string[]) => execFileSync(cli, args, { encoding: 'utf8' }).trim();
  if (text(['info', '--format', '{{.Host.ServiceIsRemote}}']) !== 'true') return { machine: null };
  const running = text(['machine', 'list', '--format', '{{.Name}}|{{.Running}}'])
    .split(/\r?\n/)
    .map((line) => line.trim().split('|'))
    .find(([, up]) => up === 'true');
  if (!running) throw new Error('Podman is remote and no machine is running');
  return { machine: running[0]!.replace(/\*$/, '') };
}

/**
 * A shell loop that inspects every compile container (`docedit-job-*`) once while it runs, where the
 * containers run, and prints one line for each. A container lives for one compile and is removed
 * when it ends, and a round trip from this process can take longer than that on a busy machine. The
 * loop prints `tick` on every turn, so it ends when its output is closed.
 */
const WATCH = [
  'echo watching; seen="";',
  'while :; do',
  '  for n in $(podman ps --filter name=docedit-job- --format "{{.Names}}"); do',
  '    case " $seen " in',
  '      *" $n "*) ;;',
  '      *) seen="$seen $n";',
  '         podman inspect --format "container|{{.Name}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}|{{.EffectiveCaps}}|{{.Config.Image}}" "$n" 2>/dev/null;;',
  '    esac;',
  '  done;',
  '  echo tick || exit 0; sleep 0.2;',
  'done',
].join('\n');

/** The command lines of the processes a process started. */
function childCommandLines(pid: number): string[] {
  const r =
    process.platform === 'win32'
      ? spawnSync(
          'pwsh',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object CommandLine`,
          ],
          { encoding: 'utf8' },
        )
      : spawnSync('ps', ['-o', 'args=', '--ppid', String(pid)], { encoding: 'utf8' });
  return (r.stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
}

function stack(command: string): void {
  if (compose) {
    const line = process.env[`DOCEDIT_DEMO_COMPOSE_${command.toUpperCase()}`];
    if (!line) throw new Error(`DOCEDIT_DEMO_COMPOSE_${command.toUpperCase()} is not set`);
    const c = spawnSync(line, { encoding: 'utf8', shell: true, env: process.env });
    if (c.status !== 0)
      throw new Error(
        `compose ${command} failed (${c.status}): ${(c.stderr || c.stdout).slice(-600)}`,
      );
    return;
  }
  const r = spawnSync(
    'pwsh',
    ['-NoProfile', '-File', fileURLToPath(new URL('scripts/stack.ps1', appDir)), command],
    { encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0)
    throw new Error(
      `stack.ps1 ${command} failed (${r.status}): ${(r.stderr || r.stdout).slice(-600)}`,
    );
}

describe.skipIf(!live)('the stack of apps/reference-host/compose.json, running (BE-005)', () => {
  it('has the document service ready on PostgreSQL and the S3 store, and an export worker that takes a job (criterion 1)', async () => {
    expect(existsSync(`${dataDir}/secrets.json`)).toBe(true);
    // The two containers of the compose file, by the names Compose gives them.
    expect(containerState('postgres')).toBe('running');
    expect(containerState('s3')).toBe('running');
    expect((await fetch(`http://127.0.0.1:${s['DOCEDIT_DEMO_S3_PORT']}/health`)).status).toBe(200);

    // The service reports ready: its database is reachable and migrated (BE-001 criterion 5).
    const ready = await fetch(`${serviceUrl}/readyz`);
    expect(ready.status).toBe(200);
    const discovery = (await (await fetch(`${serviceUrl}/.well-known/dep`)).json()) as Json;
    expect(discovery['features']).toEqual(expect.arrayContaining(['regions', 'exports']));

    // One export worker is running: a job put in the queue is claimed, compiled and stored.
    const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
      'id'
    ] as string;
    const queued = await rest('POST', `/documents/${doc}/exports`, { target: 'pdf' });
    expect(queued.status).toBe(202);
    let job = queued.json;
    for (let i = 0; i < 120 && !['completed', 'failed', 'cancelled'].includes(job['state']); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      job = (await rest('GET', `/exports/${job['id']}`)).json;
    }
    expect(job['state']).toBe('completed');
    // The PDF is in the S3-compatible store: the signed URL answers with a PDF.
    const pdf = await fetch(job['result']['url'] as string);
    expect(pdf.status).toBe(200);
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');
  }, 180_000);

  it('has the development tenant with its key set and allowed origins from the configuration (criterion 2)', async () => {
    const configured = readJson('tenants.json')['tenants'][0] as Json;
    const tenant = readJson('setup.json')['tenant'] as string;
    expect(configured['id']).toBe(tenant);
    const pool = servicePool();
    try {
      const registry = new PgTenantRegistry(pool);
      expect(await registry.exists(tenant)).toBe(true);
      // The key set: the host's signing key for user tokens, as the configuration names it.
      const keys = await registry.keys(tenant, 'user');
      expect(keys.map((k) => k.kid).sort()).toEqual(
        (configured['keys'] as Json[]).map((k) => k['kid'] as string).sort(),
      );
      expect(keys.length).toBeGreaterThan(0);
      // The API key of the configuration is registered (its secret is stored as a hash only).
      expect(
        await registry.apiKey(tenant, configured['apiKeys'][0]['id'] as string),
      ).not.toBeNull();
      // The allowed origins are those the stack's settings give the reference host.
      const origins = (await registry.origins(tenant)).sort();
      expect(origins).toEqual([...(configured['origins'] as string[])].sort());
      expect(origins).toContain(`http://127.0.0.1:${s['DOCEDIT_DEMO_HOST_PORT']}`);
    } finally {
      await pool.end();
    }
  });

  it.skipIf(compose)(
    'compiles a job in a container that has no network (the compile container, not the worker process)',
    async () => {
      const workerPid = Number(readFileSync(`${dataDir}/pids/export-worker.pid`, 'utf8').trim());
      expect(Number.isSafeInteger(workerPid)).toBe(true);
      const { machine } = sandboxRoute();
      const watcher = machine
        ? spawn(
            cli,
            [
              'machine',
              'ssh',
              machine,
              `echo ${Buffer.from(WATCH).toString('base64')} | base64 -d | sh`,
            ],
            { stdio: ['ignore', 'pipe', 'ignore'] },
          )
        : spawn('sh', ['-c', WATCH], { stdio: ['ignore', 'pipe', 'ignore'] });
      let seen = '';
      watcher.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        seen += chunk;
      });
      try {
        // The loop is in place before the job is queued.
        for (let i = 0; i < 600 && !seen.includes('watching'); i++) await sleep(100);
        expect(seen).toContain('watching');

        const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
          'id'
        ] as string;
        const queued = await rest('POST', `/documents/${doc}/exports`, { target: 'pdf' });
        expect(queued.status).toBe(202);
        let job = queued.json;
        let name: string | null = null;
        let commandLine = '';
        while (!['completed', 'failed', 'cancelled'].includes(job['state'])) {
          // The worker of this stack starts the container: the command is a child of its process.
          if (!name)
            for (const line of childCommandLines(workerPid)) {
              const m = /--name=(docedit-job-[0-9a-f]+)/.exec(line);
              if (m) {
                name = m[1]!;
                commandLine = line;
              }
            }
          await sleep(150);
          job = (await rest('GET', `/exports/${job['id']}`)).json;
        }
        expect(job['state']).toBe('completed');
        expect(name, 'the worker started no compile container').not.toBeNull();
        expect(commandLine).toContain('--network=none');
        if (machine) expect(commandLine).toContain(`machine ssh ${machine}`);

        // Inspected while it ran, where it ran: no network, a read-only root, no capabilities, and
        // the unprivileged user of the image.
        await sleep(1500);
        const line = seen.split(/\r?\n/).find((l) => l.startsWith(`container|${name}|`));
        expect(line, `the loop did not see ${name}`).toBeDefined();
        const [, , network, readOnly, user, capabilities, image] = line!.split('|');
        expect(network).toBe('none');
        expect(readOnly).toBe('true');
        expect(user).toBe('10001:10001');
        expect(capabilities).toBe('[]');
        expect(image).toBe(s['DOCEDIT_EXPORT_IMAGE']);
      } finally {
        watcher.kill();
      }
    },
    300_000,
  );

  it.skipIf(!restart)(
    'keeps documents and their history when the stack is stopped and started on the same volumes (criterion 5)',
    async () => {
      const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
        'id'
      ] as string;
      const token = (await rest('POST', '/tokens', { sub: 'restart', docs: { [doc]: 'editor' } }))
        .json['token'] as string;
      const before = (await rest('GET', `/documents/${doc}/content`)).json;
      let at = -1;
      cdmSchema()
        .nodeFromJSON(before['doc'])
        .descendants((n, p) => {
          if (n.attrs['id'] === 'pIntro0000000001') at = p + 1;
          return at < 0;
        });
      const c = await DepClient.connect(`${serviceUrl.replace('http:', 'ws:')}/dep`);
      try {
        expect((await c.hello(token)).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        for (const [base, text] of [
          [0, 'kept '],
          [1, 'after a restart '],
        ] as const)
          expect(
            (await c.submit(1, { base, steps: [insertText(at, text)], origin: 'input' })).t,
          ).toBe('sync.ack');
      } finally {
        c.close();
      }
      const read = async () => ({
        content: (await rest('GET', `/documents/${doc}/content`)).json,
        commits: (await rest('GET', `/documents/${doc}/commits?after=0`)).json,
        meta: (await rest('GET', `/documents/${doc}`)).json,
      });
      const stored = await read();
      expect(stored.content['seq']).toBe(2);
      expect(JSON.stringify(stored.content['doc'])).toContain('after a restart kept ');
      expect((stored.commits['items'] as unknown[]).length).toBe(2);

      // Stop: the containers are removed and the processes end; the volumes stay.
      stack('down');
      await expect(fetch(`${serviceUrl}/readyz`)).rejects.toThrow();
      expect(() => containerState('postgres')).toThrow();
      // Start again on the same volumes.
      stack('up');
      expect((await fetch(`${serviceUrl}/readyz`)).status).toBe(200);

      const again = await read();
      expect(again.content['doc']).toEqual(stored.content['doc']);
      expect(again.content['seq']).toBe(2);
      expect(again.content['incarnation']).toBe(stored.content['incarnation']);
      expect(again.commits['items']).toEqual(stored.commits['items']);
      expect(again.meta['id']).toBe(doc);
    },
    900_000,
  );
});
