/**
 * The pinning check (SEC-052; 10 §3.8; ADR 0044 §5). Fails when
 *
 * - `containerfiles`: a container definition is not a Containerfile, or a base image (`FROM`,
 *   `COPY --from`, `RUN --mount=from=`) is not pinned by digest, or a remote `ADD` has no checksum.
 *   Images built here (`localhost/…`) are judged by their own Containerfile;
 * - `compose`: a compose service runs an image that is neither pinned by digest nor built here;
 * - `workflows`: a GitHub Actions step uses an action that is not pinned to a full commit, a job
 *   runs a container image that is not pinned by digest, or a workflow uses Docker's actions;
 * - `podman`: a script calls the Docker CLI, or calls Podman without honouring
 *   DOCEDIT_CONTAINER_CLI (CLAUDE.md: Podman, never Docker; the CLI overridable, default podman);
 * - `references`: a string in code (not tests or fixtures) names a registry image with a tag but
 *   without a digest.
 *
 * Usage: node scripts/supply-chain/pin-check.ts [--root <dir>] [--rules <rule,rule>] [--json <file>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './bundle.ts';

export type PinRule = 'containerfiles' | 'compose' | 'workflows' | 'podman' | 'references';
export const PIN_RULES: readonly PinRule[] = [
  'containerfiles',
  'compose',
  'workflows',
  'podman',
  'references',
];

export interface PinFinding {
  rule: PinRule;
  file: string;
  line: number;
  message: string;
}

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------------------
// Containerfiles

export interface Instruction {
  line: number;
  keyword: string;
  args: string;
}

/** Instructions of a Containerfile, with continuations joined, comments and heredoc bodies removed. */
export function parseContainerfile(text: string): {
  instructions: Instruction[];
  directives: Map<string, string>;
} {
  const lines = text.split(/\r?\n/);
  const directives = new Map<string, string>();
  let i = 0;
  for (; i < lines.length; i++) {
    const d = /^#\s*([a-zA-Z]+)\s*=\s*(.*?)\s*$/.exec(lines[i]!);
    if (!d) break;
    directives.set(d[1]!.toLowerCase(), d[2]!);
  }
  const escape = directives.get('escape') === '`' ? '`' : '\\';
  const instructions: Instruction[] = [];
  const heredocs: string[] = [];
  while (i < lines.length) {
    const start = i;
    const first = lines[i]!;
    if (heredocs.length) {
      if (first.replace(/^\t+/, '') === heredocs[0]) heredocs.shift();
      i++;
      continue;
    }
    if (/^\s*(#|$)/.test(first)) {
      i++;
      continue;
    }
    let joined = '';
    for (;;) {
      const raw = lines[i] ?? '';
      i++;
      if (/^\s*#/.test(raw) && joined) continue;
      const trimmed = raw.replace(/\s+$/, '');
      if (trimmed.endsWith(escape)) {
        joined += `${trimmed.slice(0, -1)} `;
        if (i >= lines.length) break;
        continue;
      }
      joined += trimmed;
      break;
    }
    const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(joined);
    if (!m) continue;
    const keyword = m[1]!.toUpperCase();
    const args = m[2]!.trim();
    instructions.push({ line: start + 1, keyword, args });
    for (const h of args.matchAll(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g))
      heredocs.push(h[2]!);
  }
  return { instructions, directives };
}

/** Expands `$NAME`, `${NAME}` and `${NAME:-default}` with the global build arguments. */
function substitute(
  text: string,
  vars: ReadonlyMap<string, string | undefined>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const re = /\$\{([A-Za-z_]\w*)(?:(:?[-+])([^}]*))?\}|\$([A-Za-z_]\w*)/g;
  const value = text.replace(
    re,
    (all: string, braced?: string, op?: string, word?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      const v = vars.get(name);
      if (v !== undefined && v !== '') return op?.endsWith('+') ? (word ?? '') : v;
      if (op?.endsWith('-') && word) return word;
      missing.push(name);
      return all;
    },
  );
  return { value, missing };
}

export function checkContainerfile(text: string, file: string): PinFinding[] {
  const findings: PinFinding[] = [];
  const add = (line: number, message: string) =>
    findings.push({ rule: 'containerfiles', file, line, message });
  const { instructions, directives } = parseContainerfile(text);
  if (directives.has('syntax'))
    add(
      1,
      `the "# syntax=${directives.get('syntax')}" directive selects a BuildKit frontend image, a Docker build feature; Containerfiles here are built with Podman, so remove it`,
    );
  const globals = new Map<string, string | undefined>();
  const stages: string[] = [];
  let seenFrom = false;
  // Not pulled from a registry: scratch, an earlier stage, or an image built here (localhost/…),
  // whose own Containerfile this check reads.
  const external = (ref: string) =>
    ref.toLowerCase() !== 'scratch' &&
    !stages.includes(ref.toLowerCase()) &&
    !/^\d+$/.test(ref) &&
    !ref.startsWith('localhost/');
  for (const ins of instructions) {
    if (ins.keyword === 'ARG' && !seenFrom) {
      for (const part of ins.args.split(/\s+/)) {
        const [name, ...rest] = part.split('=');
        if (name)
          globals.set(name, rest.length ? rest.join('=').replace(/^["']|["']$/g, '') : undefined);
      }
    } else if (ins.keyword === 'FROM') {
      seenFrom = true;
      const words = ins.args.split(/\s+/).filter((w) => !w.startsWith('--'));
      const ref = words[0] ?? '';
      const alias = words[1]?.toUpperCase() === 'AS' ? words[2] : undefined;
      const { value, missing } = substitute(ref, globals);
      if (missing.length)
        add(
          ins.line,
          `base image "${ref}" depends on build argument ${missing.join(', ')} without a pinned default`,
        );
      else if (external(value) && !DIGEST.test(value))
        add(ins.line, `base image "${value}" is not pinned by digest (@sha256:…)`);
      if (alias) stages.push(alias.toLowerCase());
    } else if (ins.keyword === 'COPY' || ins.keyword === 'RUN') {
      const from = [
        ...ins.args.matchAll(/--from=(\S+)/g),
        ...ins.args.matchAll(/--mount=\S*?\bfrom=([^,\s]+)/g),
      ].map((m) => m[1]!);
      for (const ref of from) {
        const { value } = substitute(ref, globals);
        if (external(value) && !DIGEST.test(value))
          add(
            ins.line,
            `${ins.keyword} reads from image "${value}", which is not pinned by digest`,
          );
      }
    } else if (ins.keyword === 'ADD') {
      const sources = ins.args.split(/\s+/).filter((w) => !w.startsWith('--'));
      if (
        sources.some((s) => /^(?:https?:\/\/|git@)/.test(s)) &&
        !/--checksum=sha256:[0-9a-f]{64}\b/.test(ins.args)
      )
        add(ins.line, 'ADD downloads a remote source without --checksum=sha256:…');
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Compose files

interface ComposeService {
  name: string;
  line: number;
  image?: string;
  build: boolean;
}

/** Services of a compose file: JSON, or YAML read by indentation (block style only). */
export function composeServices(text: string, json: boolean): ComposeService[] {
  if (json) {
    const doc = JSON.parse(text) as {
      services?: Record<string, { image?: string; build?: unknown }>;
    };
    const lines = text.split(/\r?\n/);
    return Object.entries(doc.services ?? {}).map(([name, s]) => ({
      name,
      line: Math.max(1, lines.findIndex((l) => l.includes(`"${name}"`)) + 1),
      ...(s.image !== undefined ? { image: s.image } : {}),
      build: s.build !== undefined,
    }));
  }
  const out: ComposeService[] = [];
  const lines = text.split(/\r?\n/);
  let servicesIndent = -1;
  let serviceIndent = -1;
  let current: ComposeService | null = null;
  lines.forEach((raw, i) => {
    if (/^\s*(#|$)/.test(raw)) return;
    const indent = raw.length - raw.trimStart().length;
    const key = /^\s*([A-Za-z0-9_.-]+|"[^"]+"|'[^']+'):(?:\s+(.*?))?\s*$/.exec(raw);
    if (servicesIndent < 0) {
      if (key?.[1] === 'services' && indent === 0) servicesIndent = indent;
      return;
    }
    if (indent <= servicesIndent) {
      servicesIndent = -1;
      current = null;
      return;
    }
    if (serviceIndent < 0 || indent === serviceIndent) {
      if (key) {
        serviceIndent = indent;
        current = { name: key[1]!.replace(/^["']|["']$/g, ''), line: i + 1, build: false };
        out.push(current);
      }
      return;
    }
    if (current && key && indent > serviceIndent) {
      if (key[1] === 'image' && key[2])
        current.image = key[2].replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
      if (key[1] === 'build') current.build = true;
    }
  });
  return out;
}

export function checkCompose(text: string, file: string): PinFinding[] {
  const findings: PinFinding[] = [];
  for (const s of composeServices(text, file.endsWith('.json'))) {
    if (!s.image) continue;
    if (s.build) continue; // built here from a Containerfile, whose bases the containerfiles rule checks
    if (/\$\{?[A-Za-z_]/.test(s.image))
      findings.push({
        rule: 'compose',
        file,
        line: s.line,
        message: `service ${s.name}: image "${s.image}" comes from a variable and has no build; pin it by digest`,
      });
    else if (!DIGEST.test(s.image) && !s.image.startsWith('localhost/'))
      findings.push({
        rule: 'compose',
        file,
        line: s.line,
        message: `service ${s.name}: image "${s.image}" is not pinned by digest`,
      });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Workflows

const DOCKER_ACTIONS =
  /^docker\/(?:build-push-action|setup-buildx-action|login-action|setup-qemu-action|metadata-action|bake-action)\b/;

export function checkWorkflow(text: string, file: string): PinFinding[] {
  const findings: PinFinding[] = [];
  const add = (line: number, message: string) =>
    findings.push({ rule: 'workflows', file, line, message });
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '');
    const uses = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s]+)/.exec(line);
    if (uses) {
      const ref = uses[1]!;
      if (ref.startsWith('./')) return;
      if (ref.startsWith('docker://')) {
        if (!DIGEST.test(ref)) add(i + 1, `${ref} is not pinned by digest`);
        return;
      }
      if (DOCKER_ACTIONS.test(ref))
        add(i + 1, `${ref} is Docker tooling; build and push images with Podman`);
      const at = ref.lastIndexOf('@');
      if (at < 0 || !SHA.test(ref.slice(at + 1)))
        add(i + 1, `${ref} is not pinned to a full commit SHA`);
      return;
    }
    const image = /^\s*(?:-\s+)?(?:image|container):\s*["']?([^"'\s{]+)["']?\s*$/.exec(line);
    if (image && /[/:]/.test(image[1]!) && !DIGEST.test(image[1]!))
      add(i + 1, `container image ${image[1]} is not pinned by digest`);
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Podman, never Docker

const DOCKER_CLI =
  /(?<![\w./@:-])(?:docker(?:\.exe)?\s+(?:build|buildx|compose|run|push|pull|tag|login|save|load|create|exec|start|image|images|inspect|system|volume|network|container|ps|rmi?)\b|docker-compose\b)/;
const DOCKER_SPAWN =
  /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|execa)\(\s*["'`]docker(?:\.exe)?["'`]/;
const PODMAN_SPAWN =
  /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|execa)\(\s*["'`]podman(?:\.exe)?["'`\s]/;
const PODMAN_SHELL = /(?:^|[|;&]\s*|^\s*&\s*)podman(?:\.exe)?\s/;
const SCRIPT = /\.(?:[cm]?[jt]s|ps1|psm1|sh|bash)$/;

export function checkScript(text: string, file: string): PinFinding[] {
  const findings: PinFinding[] = [];
  const shell = /\.(?:ps1|psm1|sh|bash)$/.test(file);
  const overridable = text.includes('DOCEDIT_CONTAINER_CLI');
  let podmanLine = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const code = shell
      ? raw.replace(/(^|\s)#.*$/, '$1')
      : raw.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
    if (DOCKER_CLI.test(code) || DOCKER_SPAWN.test(code))
      findings.push({
        rule: 'podman',
        file,
        line: i + 1,
        message: 'calls the Docker CLI; containers are built and run with Podman',
      });
    if (!podmanLine && (shell ? PODMAN_SHELL.test(code.trimStart()) : PODMAN_SPAWN.test(code)))
      podmanLine = i + 1;
  });
  if (podmanLine && !overridable)
    findings.push({
      rule: 'podman',
      file,
      line: podmanLine,
      message: 'calls podman directly; read the CLI from DOCEDIT_CONTAINER_CLI (default podman)',
    });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Image references in code

const REGISTRY_REF =
  /(["'`])((?:docker\.io|ghcr\.io|quay\.io|gcr\.io|[a-z0-9-]+\.gcr\.io|registry\.k8s\.io|mcr\.microsoft\.com|public\.ecr\.aws|registry\.gitlab\.com|registry\.fedoraproject\.org|registry\.access\.redhat\.com)\/[a-z0-9._/-]+(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?)\1/g;

/**
 * A quoted image reference with a tag must also carry its digest. A bare repository name (no tag,
 * no digest) names where images go, for example the release's push target, and passes.
 */
export function checkReferences(text: string, file: string): PinFinding[] {
  const findings: PinFinding[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    for (const m of raw.matchAll(REGISTRY_REF)) {
      const ref = m[2]!;
      const tagged = /:[\w.-]+(?:@|$)/.test(ref.slice(ref.lastIndexOf('/')));
      if (tagged && !DIGEST.test(ref))
        findings.push({
          rule: 'references',
          file,
          line: i + 1,
          message: `image "${ref}" is not pinned by digest`,
        });
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// The repository scan

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
  '.vitest',
  '.install-lock',
]);
/** Files this check must not judge: its own source, tests and deliberately bad fixtures. */
const SELF = [
  /^scripts\/supply-chain\/fixtures\//,
  /^scripts\/supply-chain\/pin-check(?:\.test)?\.ts$/,
];

const TEST_FILE = /(?:^|\/)(?:test|tests|fixtures|e2e)\/|\.test\.[cm]?[jt]s$/;

/** A container definition; `Containerfile.dockerignore` and the like are build-context ignore lists. */
export const isContainerDefinition = (name: string) =>
  /^(?:Containerfile|Dockerfile)(?:\..+)?$|\.(?:Containerfile|Dockerfile|dockerfile)$/.test(name) &&
  !/ignore$/i.test(name);
const isCompose = (name: string) =>
  /^(?:docker-|podman-)?compose(?:\.[\w-]+)*\.(?:ya?ml|json)$/.test(name);

export function scanRepository(
  root: string,
  rules: readonly PinRule[] = PIN_RULES,
): { findings: PinFinding[]; files: Record<PinRule, number> } {
  const findings: PinFinding[] = [];
  const files: Record<PinRule, number> = {
    containerfiles: 0,
    compose: 0,
    workflows: 0,
    podman: 0,
    references: 0,
  };
  const on = new Set(rules);
  for (const abs of walkFiles(root, SKIP)) {
    const rel = relative(root, abs).split(sep).join('/');
    if (SELF.some((re) => re.test(rel))) continue;
    const name = basename(rel);
    const read = () => readFileSync(abs, 'utf8');
    if (isContainerDefinition(name)) {
      if (!on.has('containerfiles')) continue;
      files.containerfiles++;
      if (/^Dockerfile|\.(?:Dockerfile|dockerfile)$/.test(name))
        findings.push({
          rule: 'containerfiles',
          file: rel,
          line: 1,
          message: 'container definitions are named Containerfile and built with Podman',
        });
      findings.push(...checkContainerfile(read(), rel));
    } else if (isCompose(name)) {
      if (!on.has('compose')) continue;
      files.compose++;
      if (name.startsWith('docker-'))
        findings.push({
          rule: 'compose',
          file: rel,
          line: 1,
          message: 'compose files are named compose.* and run with podman compose',
        });
      findings.push(...checkCompose(read(), rel));
    } else if (/^\.github\/(?:workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/.test(rel)) {
      if (!on.has('workflows')) continue;
      files.workflows++;
      findings.push(...checkWorkflow(read(), rel));
    } else if (SCRIPT.test(name) || name === 'package.json' || name === 'Makefile') {
      const text = on.has('podman') || on.has('references') ? read() : '';
      if (on.has('podman')) {
        files.podman++;
        findings.push(...checkScript(text, rel));
      }
      // Tests and fixtures name images as examples; code that pulls or runs an image is judged.
      if (on.has('references') && name !== 'package.json' && !TEST_FILE.test(rel)) {
        files.references++;
        findings.push(...checkReferences(text, rel));
      }
    }
  }
  return { findings, files };
}

function main(argv: string[]): number {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(
    opt('--root') ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'),
  );
  const rules = (opt('--rules')?.split(',') ?? [...PIN_RULES]) as PinRule[];
  for (const r of rules)
    if (!PIN_RULES.includes(r)) {
      console.error(`pin check: unknown rule "${r}" (known: ${PIN_RULES.join(', ')})`);
      return 2;
    }
  const { findings, files } = scanRepository(root, rules);
  console.log(
    `pin check: ${rules.map((r) => `${files[r]} ${r}`).join(', ')} file(s) checked under ${root}`,
  );
  const json = opt('--json');
  if (json) writeFileSync(json, `${JSON.stringify({ root, rules, files, findings }, null, 2)}\n`);
  if (!findings.length) {
    console.log('pin check: passed');
    return 0;
  }
  console.error(`pin check: ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  - ${f.file}:${f.line} [${f.rule}] ${f.message}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
