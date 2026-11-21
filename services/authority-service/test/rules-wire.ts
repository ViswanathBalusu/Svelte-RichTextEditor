/**
 * The rules fixtures put to the authority service over its HTTP interface (05 §10), for
 * frw-015.wire-fixtures.test.ts and frw-018.wire-patterns.test.ts. A target is a base URL: the
 * service started in this process on a free port, or a container of its image (built and run with
 * Podman when DOCEDIT_AUTHORITY_CONTAINER=1, as container.test.ts does for BE-007).
 *
 * The service takes documents, so a case becomes a document: its roles and rules in the
 * definitions, its fields in the body. A pattern case becomes a rule whose condition is
 * `matches` of the case's input and pattern; the rule shows a field when it holds and hides it
 * otherwise, so the answer of `evaluateRules` says whether the pattern matched.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type JsonEnvelope, documentHash } from '@docedit/model';
import type { FixtureCase, StateExpect } from '@docedit/rules';
import { listen } from '../src/http.ts';
import { AuthorityService } from '../src/service.ts';
import { baseEnvelope } from './log.ts';

type J = Record<string, unknown>;
export type RulesCase = Extract<FixtureCase, { kind: 'rules' }>;
export type PatternCase = Extract<FixtureCase, { kind: 'pattern' }>;

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const cli = process.env['DOCEDIT_CONTAINER_CLI'] ?? 'podman';

/** Whether the container target runs: it builds an image and starts a container with Podman. */
export const containerEnabled = process.env['DOCEDIT_AUTHORITY_CONTAINER'] === '1';

const fieldId = (i: number): string => `fFx${String(i).padStart(13, '0')}`;

/** A rules case as a CDM document: its roles and rules in the definitions, its fields in the body. */
export function rulesDocument(c: RulesCase): JsonEnvelope {
  const env = baseEnvelope(['fields']);
  const tree = env.doc as unknown as { content: Array<{ content: J[] }> };
  const defs = tree.content[0]!.content;
  for (const role of c.given?.roleDefs ?? [])
    defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#000000' } });
  for (const rule of c.rules) defs.push({ type: 'rule_def', attrs: rule as J });
  const intro = tree.content[1]!.content[0]!;
  const values = c.given?.values ?? {};
  const fields = (c.given?.fields ?? []).map((f, i) => ({
    type: 'form_field',
    attrs: {
      id: fieldId(i),
      key: f.key,
      kind: f.kind,
      label: f.key,
      assignee: null,
      value: values[f.key] ?? null,
      ...(f.options ? { options: f.options.map((o) => ({ id: o, label: o })) } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.readOnly ? { readOnly: true } : {}),
    },
  }));
  const content = (intro['content'] as J[] | undefined) ?? [];
  intro['content'] = [...content, ...fields.flatMap((f) => [{ type: 'text', text: ' ' }, f])];
  return env;
}

/** The key of the field a pattern document shows when the pattern matches the input. */
export const PATTERN_PROBE = 'probe';

/**
 * A pattern and an input as a CDM document: one rule, `matches` of the input and the pattern,
 * that shows the probe field when it holds and hides it otherwise.
 */
export function patternDocument(pattern: string, input: string): JsonEnvelope {
  const env = baseEnvelope(['fields']);
  const tree = env.doc as unknown as { content: Array<{ content: J[] }> };
  tree.content[0]!.content.push({
    type: 'rule_def',
    attrs: {
      id: 'r_pattern',
      when: { matches: [input, pattern] },
      then: [{ show: [PATTERN_PROBE] }],
      else: [{ hide: [PATTERN_PROBE] }],
    },
  });
  const intro = tree.content[1]!.content[0]!;
  intro['content'] = [
    ...((intro['content'] as J[] | undefined) ?? []),
    { type: 'text', text: ' ' },
    {
      type: 'form_field',
      attrs: {
        id: fieldId(0),
        key: PATTERN_PROBE,
        kind: 'text',
        label: PATTERN_PROBE,
        assignee: null,
        value: null,
      },
    },
  ];
  return env;
}

/** What the service answered for one field or rule, as `evaluateRules` writes it on the wire. */
export interface WireEvaluation {
  fields: Array<{
    key: string;
    visible: boolean;
    enabled: boolean;
    required: boolean;
    messages: Array<{ rule: string; message: string }>;
    value?: string | null;
    error?: string;
    by: Record<string, unknown>;
  }>;
  rules: Array<{ id: string; outcome: string | { error: string } }>;
}

/** An evaluation in the shape of a fixture's `expect`, as `runCase` of the package gives it. */
export function answerOf(evaluation: WireEvaluation): {
  fields: Record<string, StateExpect>;
  rules: Record<string, string>;
} {
  const fields: Record<string, StateExpect> = {};
  for (const s of evaluation.fields) {
    const o: StateExpect = { visible: s.visible, enabled: s.enabled, required: s.required };
    if (s.messages.length) o.messages = s.messages;
    if ('value' in s) o.value = s.value ?? null;
    if (s.error !== undefined) o.error = s.error;
    const by = Object.fromEntries(Object.entries(s.by).filter(([, v]) => v !== undefined));
    if (Object.keys(by).length) o.by = by as NonNullable<StateExpect['by']>;
    fields[s.key] = o;
  }
  const rules: Record<string, string> = {};
  for (const x of evaluation.rules)
    rules[x.id] = typeof x.outcome === 'string' ? x.outcome : `error:${x.outcome.error}`;
  return { fields, rules };
}

export interface WireProblem {
  status: number;
  code: string;
  /** The `info` member of the problem document: the detail of the refusal. */
  info: unknown;
}

/** The two calls of 05 §10 that the fixtures need, over HTTP. */
export interface Wire {
  readonly url: string;
  calls(): Promise<string[]>;
  open(
    envelope: JsonEnvelope,
  ): Promise<{ ok: true; stateId: string } | ({ ok: false } & WireProblem)>;
  evaluate(
    stateId: string,
    request: Record<string, unknown>,
  ): Promise<{ ok: true; evaluation: WireEvaluation } | ({ ok: false } & WireProblem)>;
}

export function wire(url: string): Wire {
  const problemOf = async (r: Response): Promise<{ ok: false } & WireProblem> => {
    const body = (await r.json()) as { code?: string; info?: unknown };
    return { ok: false, status: r.status, code: String(body.code), info: body.info };
  };
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    url,
    async calls() {
      const r = await fetch(`${url}/v1/authority/capabilities`);
      return ((await r.json()) as { calls: string[] }).calls;
    },
    async open(envelope) {
      const hash = await documentHash(envelope);
      const r = await post(`/v1/authority/documents/doc-rules-wire/open`, {
        checkpointRef: { seq: 0, chainHead: null, contentHash: hash, content: envelope },
        commits: [],
        stateId: hash,
      });
      if (r.status !== 201) return problemOf(r);
      return { ok: true, stateId: ((await r.json()) as { stateId: string }).stateId };
    },
    async evaluate(stateId, request) {
      const r = await post(`/v1/authority/states/${stateId}/evaluate-rules`, request);
      if (r.status !== 200) return problemOf(r);
      return { ok: true, evaluation: (await r.json()) as WireEvaluation };
    },
  };
}

/** What the package's own runner reported for the whole published set, inside the image. */
export interface ImageReport {
  /** The rules version of the set in the image. */
  rules: string;
  cases: number;
  passed: number;
  failed: string[];
  /** The Node.js of the image, as `process.version` gives it. */
  node: string;
  /** The file `@docedit/rules` resolves to from the service's own directory in the image. */
  resolved: string;
}

export interface Target {
  readonly name: string;
  readonly wire: Wire;
  close(): Promise<void>;
  /** For a container: the SHA-256 of each file of the rules package in the image, by path. */
  packageHashes?(): Promise<Map<string, string>>;
  /**
   * For a container: every published case (expressions, patterns, values and rules), run by
   * `runFixtures` of the package as the image holds it, in the Node.js of the image and resolved
   * from the service's own directory, as the service resolves it.
   */
  fixturesInImage?(): Promise<ImageReport>;
}

/** The service in this process, behind its own HTTP binding on a free port. */
export async function startInProcess(): Promise<Target> {
  const running = await listen({ service: new AuthorityService(), port: 0 });
  return { name: 'this process', wire: wire(running.url), close: () => running.close() };
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

interface ComposeService {
  image: string;
  network_mode?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  environment: Record<string, string>;
}

/**
 * Runs `fn` while no other test process builds the image: two files that start at once would
 * otherwise each install the dependencies. The lock is a directory in the system's temporary
 * folder; one left behind by a process that died is taken over after 20 minutes.
 */
async function buildOnce<T>(fn: () => Promise<T>): Promise<T> {
  const lock = join(tmpdir(), 'docedit-authority-rules-w4.build.lock');
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let age = Infinity;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // released between the two calls: try again
      }
      if (age > 20 * 60_000) rmSync(lock, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** The package's own runner over the whole published set, as a module the image's Node.js runs. */
const IMAGE_RUNNER = [
  "import { runCase, runFixtures } from '@docedit/rules';",
  "import { FIXTURES } from '@docedit/rules/fixtures';",
  'const report = runFixtures(FIXTURES, runCase);',
  'process.stdout.write(JSON.stringify({',
  '  rules: report.rules,',
  '  cases: FIXTURES.cases.length,',
  '  passed: report.passed.length,',
  '  failed: report.failed.map((f) => f.id),',
  '  node: process.version,',
  "  resolved: import.meta.resolve('@docedit/rules'),",
  '}));',
].join('\n');

/**
 * The service as a container: the image is built from the Containerfile and started with the
 * options of compose.json on a free port (host networking, loopback only), under `name`.
 */
export async function startContainer(image: string, name: string): Promise<Target> {
  await buildOnce(() =>
    run(
      cli,
      [
        'build',
        '-f',
        'services/authority-service/Containerfile',
        '--ignorefile',
        'services/authority-service/Containerfile.dockerignore',
        '-t',
        image,
        '.',
      ],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const compose = JSON.parse(
    readFileSync(resolve(root, 'services/authority-service/compose.json'), 'utf8'),
  ) as { services: Record<string, ComposeService> };
  const service = compose.services['authority-service']!;
  const port = await freePort();
  const settings: Record<string, string> = {
    DOCEDIT_AUTHORITY_PORT: String(port),
    DOCEDIT_AUTHORITY_IMAGE: image,
  };
  const interpolate = (text: string): string =>
    text.replace(
      /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
      (_m, key: string, fallback?: string) => settings[key] ?? fallback ?? '',
    );
  const remote =
    (await run(cli, ['info', '--format', '{{.Host.ServiceIsRemote}}'])).stdout.trim() === 'true';
  await run(cli, ['rm', '-f', '-t', '0', name]).catch(() => undefined);
  const args = ['run', '-d', '--name', name, ...(remote ? ['--cgroups=disabled'] : [])];
  if (service.network_mode) args.push(`--network=${service.network_mode}`);
  if (service.read_only) args.push('--read-only');
  for (const c of service.cap_drop ?? []) args.push(`--cap-drop=${c}`);
  for (const o of service.security_opt ?? []) args.push('--security-opt', o);
  for (const [k, v] of Object.entries(service.environment)) {
    const value = interpolate(v);
    if (value !== '') args.push('-e', `${k}=${value}`);
  }
  args.push(image);
  await run(cli, args);
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/v1/authority/ready`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error('the container was not ready within 60 s');
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    name: `a container of ${image}`,
    wire: wire(url),
    close: async () => {
      await run(cli, ['rm', '-f', '-t', '0', name]).catch(() => undefined);
    },
    async packageHashes() {
      const out = await run(
        cli,
        [
          'exec',
          name,
          'sh',
          '-c',
          'cd /app/packages/rules/src && find . -type f -name "*.ts" | sort | xargs sha256sum',
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const hashes = new Map<string, string>();
      for (const line of out.stdout.split('\n')) {
        const m = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(line.trim());
        if (m) hashes.set(m[2]!, m[1]!);
      }
      return hashes;
    },
    async fixturesInImage() {
      // From the service's directory, so the package is found as the service finds it.
      const out = await run(
        cli,
        [
          'exec',
          '--workdir',
          '/app/services/authority-service',
          name,
          'node',
          '--input-type=module',
          '--eval',
          IMAGE_RUNNER,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      return JSON.parse(out.stdout) as ImageReport;
    },
  };
}

/** The SHA-256 of every TypeScript file of the rules package's source here, by path from `src`. */
export function localPackageHashes(): Map<string, string> {
  const src = resolve(root, 'packages/rules/src');
  const hashes = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.name.endsWith('.ts'))
        hashes.set(
          path,
          createHash('sha256')
            .update(readFileSync(join(dir, entry.name)))
            .digest('hex'),
        );
    }
  };
  walk(src, '');
  return hashes;
}

/** The image both test files build and start: one build, two containers. */
export const RULES_IMAGE = 'localhost/docedit-authority-service:rules-w4';

/**
 * The targets of a run: this process always, and the container when it is switched on. The
 * container is named `docedit-authority-<tag>`; a tag ends in `w4`, the lane of these tests.
 */
export function targets(tag: string): Array<{ name: string; start: () => Promise<Target> }> {
  return [
    { name: 'the service in this process', start: startInProcess },
    ...(containerEnabled
      ? [
          {
            name: 'the service in a container',
            start: () => startContainer(RULES_IMAGE, `docedit-authority-${tag}`),
          },
        ]
      : []),
  ];
}
