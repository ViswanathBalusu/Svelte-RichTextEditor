// BE-007: the authority service as a real container, started with the options of its compose file.
// It builds the image and runs it with Podman, so it is off unless DOCEDIT_AUTHORITY_CONTAINER=1:
//
//   $env:DOCEDIT_AUTHORITY_CONTAINER = '1'
//   pnpm exec vitest run --project node services/authority-service/test/container.test.ts
//
// `podman compose` needs a Compose provider, which the WSL Podman machine here does not have, so the
// test reads the service out of compose.json and starts it with `podman run` and the same options
// (as infra/test-env.ps1 does). The container binds a random high port, a name ending in -w5 and
// loopback only (host networking; see compose.json), and is removed at the end.
//
// Criterion 2 kills the container with SIGKILL and starts it again; the same flow in process is
// be-007-restart-apply.test.ts. Criterion 4, the conformance kit's profile against the container,
// is packages/tck/test/be-007-authority-container.test.ts.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonicalText } from '@docedit/model';
import { afterAll, describe, expect, it } from 'vitest';
import { applyRequest, buildLog, envelopeOf, openRequest, posInside } from './log.ts';

const run = promisify(execFile);
const enabled = process.env['DOCEDIT_AUTHORITY_CONTAINER'] === '1';
const cli = process.env['DOCEDIT_CONTAINER_CLI'] ?? 'podman';
const root = resolve(import.meta.dirname, '../../..');
const IMAGE = 'localhost/docedit-authority-service:w5-test';
const NAME = 'docedit-authority-test-w5';
const NAMES = [NAME, `${NAME}-a`, `${NAME}-b`, `${NAME}-storage`, `${NAME}-kill`];

interface ComposeService {
  image: string;
  network_mode?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  environment: Record<string, string>;
}

/** `${NAME:-default}` as Compose reads it, with the given settings over the defaults. */
function interpolate(text: string, env: Record<string, string>): string {
  return text.replace(
    /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
    (_m, name: string, fallback?: string) => {
      return env[name] ?? fallback ?? '';
    },
  );
}

function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

async function ready(url: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${url}/v1/authority/ready`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`the container was not ready within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

interface Started {
  name: string;
  url: string;
}

async function build(): Promise<void> {
  await run(
    cli,
    [
      'build',
      '-f',
      'services/authority-service/Containerfile',
      '--ignorefile',
      'services/authority-service/Containerfile.dockerignore',
      '-t',
      IMAGE,
      '.',
    ],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
}

async function cgroups(): Promise<string[]> {
  const remote =
    (await run(cli, ['info', '--format', '{{.Host.ServiceIsRemote}}'])).stdout.trim() === 'true';
  return remote ? ['--cgroups=disabled'] : [];
}

/** Starts the compose service as a container, with these settings over the file's defaults. */
async function start(name: string, extra: Record<string, string> = {}): Promise<Started> {
  const compose = JSON.parse(
    readFileSync(resolve(root, 'services/authority-service/compose.json'), 'utf8'),
  ) as { services: Record<string, ComposeService> };
  const service = compose.services['authority-service']!;
  const port = await freePort();
  const settings = {
    DOCEDIT_AUTHORITY_PORT: String(port),
    DOCEDIT_AUTHORITY_IMAGE: IMAGE,
    ...extra,
  };
  const args = ['run', '-d', '--name', name, ...(await cgroups())];
  if (service.network_mode) args.push(`--network=${service.network_mode}`);
  if (service.read_only) args.push('--read-only');
  for (const c of service.cap_drop ?? []) args.push(`--cap-drop=${c}`);
  for (const o of service.security_opt ?? []) args.push('--security-opt', o);
  for (const [k, v] of Object.entries(service.environment)) {
    const value = interpolate(v, settings);
    if (value !== '') args.push('-e', `${k}=${value}`);
  }
  args.push(interpolate(service.image, settings));
  await run(cli, args);
  const url = `http://127.0.0.1:${port}`;
  await ready(url);
  return { name, url };
}

/** The caller's storage: a Node.js container that serves `GET /states/{stateId}` from a map. */
const STORAGE_SCRIPT = [
  "const http = require('http');",
  'const states = JSON.parse(process.env.STATES);',
  'http.createServer((q, r) => {',
  '  const m = /^\\/states\\/([0-9a-f]{64})$/.exec(q.url);',
  '  const v = m && states[m[1]];',
  '  if (!v) { r.writeHead(404).end(); return; }',
  "  r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));",
  "}).listen(Number(process.env.PORT), '127.0.0.1');",
].join(' ');

describe.skipIf(!enabled)('the authority service container (BE-007)', () => {
  afterAll(async () => {
    await Promise.all(
      NAMES.map((n) => run(cli, ['rm', '-f', '-t', '0', n]).catch(() => undefined)),
    );
  }, 120_000);

  it('is built, started with the options of compose.json, and serves the interface (criterion 1)', async () => {
    await build();
    const { url } = await start(NAME);

    // It serves 05 section 10: open and materialise, byte for byte what the package gives.
    const built = await buildLog(['a', 'b', 'c']);
    const req = await openRequest(built, 3);
    const post = () =>
      fetch(`${url}/v1/authority/documents/${built.doc}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
    expect((await post()).status).toBe(201);
    const content = () => fetch(`${url}/v1/authority/states/${req.stateId}/content`);
    const first = await content();
    expect(first.status).toBe(200);
    const expected = canonicalText(envelopeOf(built.docs[3]!));
    expect(await first.text()).toBe(expected);

    const caps = (await (await fetch(`${url}/v1/authority/capabilities`)).json()) as {
      calls: string[];
    };
    // Every call of 05 §10 but `migrate`, which the operator has not enabled (03 §11.3).
    expect(caps.calls).toEqual([
      'open',
      'materialise',
      'applyCommit',
      'restoreSteps',
      'diff',
      'attribution',
      'evaluateRules',
      'mapRanges',
    ]);

    // Killed and started again: it holds nothing, and open with the same inputs gives the same bytes.
    await run(cli, ['kill', NAME]);
    await run(cli, ['start', NAME]);
    await ready(url);
    expect((await content()).status).toBe(404);
    expect((await post()).status).toBe(201);
    expect(await (await content()).text()).toBe(expected);

    // The options of the compose file reached the container.
    const info = JSON.parse((await run(cli, ['inspect', NAME])).stdout) as Array<{
      HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string };
      Config: { User: string };
    }>;
    expect(info[0]!.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info[0]!.HostConfig.NetworkMode).toBe('host');
    expect(info[0]!.Config.User).toBe('node');
  }, 600_000);

  // Criterion 1 as the compose file says it: the container that a Compose provider started. Start it
  // first (infra/tools/podman-compose/README.md), then set DOCEDIT_AUTHORITY_COMPOSE_URL to its address
  // and DOCEDIT_AUTHORITY_COMPOSE_NAME to the name Compose gave the container.
  const composeUrl = process.env['DOCEDIT_AUTHORITY_COMPOSE_URL'];
  const composeName = process.env['DOCEDIT_AUTHORITY_COMPOSE_NAME'];
  it.skipIf(!composeUrl || !composeName)(
    'serves the interface and reports ready when `podman compose` started it from compose.json (criterion 1)',
    async () => {
      const url = composeUrl!;
      await ready(url);
      const built = await buildLog(['a', 'b', 'c']);
      const req = await openRequest(built, 3);
      const opened = await fetch(`${url}/v1/authority/documents/${built.doc}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      expect(opened.status).toBe(201);
      const content = await fetch(`${url}/v1/authority/states/${req.stateId}/content`);
      expect(content.status).toBe(200);
      expect(await content.text()).toBe(canonicalText(envelopeOf(built.docs[3]!)));
      const caps = (await (await fetch(`${url}/v1/authority/capabilities`)).json()) as {
        calls: string[];
      };
      expect(caps.calls).toEqual([
        'open',
        'materialise',
        'applyCommit',
        'restoreSteps',
        'diff',
        'attribution',
        'evaluateRules',
        'mapRanges',
      ]);
      // Compose, not `podman run`, made the container: it carries the project's label, and the
      // options of the file are in force, with the file's health check reporting healthy.
      const info = JSON.parse((await run(cli, ['inspect', composeName!])).stdout) as Array<{
        HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string };
        Config: { User: string; Labels: Record<string, string> };
        State: { Health?: { Status: string } };
      }>;
      expect(info[0]!.Config.Labels['com.docker.compose.project']).toMatch(/^docedit-authority/);
      expect(info[0]!.HostConfig.ReadonlyRootfs).toBe(true);
      expect(info[0]!.HostConfig.NetworkMode).toBe('host');
      expect(info[0]!.Config.User).toBe('node');
      expect(info[0]!.State.Health?.Status).toBe('healthy');
    },
    120_000,
  );

  it('gives the same applyCommit answer after it was killed, started again and opened again (criterion 2)', async () => {
    await build();
    const name = `${NAME}-kill`;
    const { url } = await start(name);
    const built = await buildLog(['a', 'b', 'c']);
    const req = await openRequest(built, 3);
    const at = posInside(built.docs[3]!, 'pTwo000000000001');
    const accepted = applyRequest(1, 3, at, 'Again ');
    const refused = applyRequest(2, 3, at, 'No ', 'viewer');
    const next = applyRequest(3, 4, at, 'More ');
    const post = (path: string, body: unknown) =>
      fetch(`${url}/v1/authority/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const open = (body: unknown = req) => post(`documents/${built.doc}/open`, body);
    const apply = (state: string, body: unknown) => post(`states/${state}/commits`, body);
    const state = async () =>
      (
        JSON.parse((await run(cli, ['inspect', name])).stdout) as Array<{
          State: { Status: string; ExitCode: number; StartedAt: string };
        }>
      )[0]!.State;

    // Before the kill: an accepted commit, a rejected one, and a commit on the state the first made.
    expect((await open()).status).toBe(201);
    const first = await apply(req.stateId, accepted);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    const made = JSON.parse(firstText) as {
      stateId: string;
      seq: number;
      commits: Array<{ hash: string }>;
    };
    expect(made.seq).toBe(4);
    expect(made.commits.at(-1)!.hash).toBe(made.stateId);
    const refusedText = await (await apply(req.stateId, refused)).text();
    expect(JSON.parse(refusedText)).toMatchObject({ rejected: { code: 'permission_denied' } });
    const nextText = await (await apply(made.stateId, next)).text();
    expect((JSON.parse(nextText) as { seq: number }).seq).toBe(5);

    // Killed with SIGKILL, so nothing of the service runs on the way out, and started again.
    const startedBefore = (await state()).StartedAt;
    await run(cli, ['kill', '--signal', 'KILL', name]);
    await run(cli, ['wait', name]);
    const dead = await state();
    expect(dead.Status).toBe('exited');
    expect(dead.ExitCode).toBe(137);
    await run(cli, ['start', name]);
    await ready(url);
    expect((await state()).StartedAt).not.toBe(startedBefore);

    // The new process holds nothing.
    const lost = await apply(req.stateId, accepted);
    expect(lost.status).toBe(404);
    expect(((await lost.json()) as { code: string }).code).toBe('unknown_state');

    // `open` again with the same inputs rebuilds the document, and the next applyCommit gives the
    // answer it gave before the kill, byte for byte: the accepted commit and the rejected one.
    expect((await open()).status).toBe(201);
    expect(await (await apply(req.stateId, accepted)).text()).toBe(firstText);
    expect(await (await apply(req.stateId, refused)).text()).toBe(refusedText);
    // So does a commit on the state the first one made, once that state is opened from the log
    // with the commit the first answer carried at its end, as the caller stored it.
    const longer = { ...req, commits: [...req.commits, ...made.commits], stateId: made.stateId };
    expect((await open(longer)).status).toBe(201);
    expect(await (await apply(made.stateId, next)).text()).toBe(nextText);
  }, 600_000);

  it('rebuilds a state a second replica does not hold from storage (criterion 3)', async () => {
    await build();
    const built = await buildLog(['a', 'b', 'c']);
    const req = await openRequest(built, 3);
    const storagePort = await freePort();
    await run(cli, [
      'run',
      '-d',
      '--name',
      `${NAME}-storage`,
      ...(await cgroups()),
      '--network=host',
      '--read-only',
      '--cap-drop=ALL',
      '-e',
      `STATES=${JSON.stringify({ [req.stateId]: req })}`,
      '-e',
      `PORT=${storagePort}`,
      'docker.io/library/node:22.18.0-bookworm-slim',
      'node',
      '-e',
      STORAGE_SCRIPT,
    ]);
    const storageUrl = `http://127.0.0.1:${storagePort}`;
    const a = await start(`${NAME}-a`, { DOCEDIT_AUTHORITY_STORAGE_URL: storageUrl });
    const b = await start(`${NAME}-b`, { DOCEDIT_AUTHORITY_STORAGE_URL: storageUrl });

    // Only replica A is told about the document; B has never seen it.
    const opened = await fetch(`${a.url}/v1/authority/documents/${built.doc}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    expect(opened.status).toBe(201);
    const expected = canonicalText(envelopeOf(built.docs[3]!));
    const fromB = await fetch(`${b.url}/v1/authority/states/${req.stateId}/content`);
    expect(fromB.status).toBe(200);
    expect(await fromB.text()).toBe(expected);
    // A state storage does not have is still unknown.
    const unknown = await fetch(`${b.url}/v1/authority/states/${'c'.repeat(64)}/content`);
    expect(unknown.status).toBe(404);
  }, 600_000);
});
