/**
 * Runs the steps of `pnpm check` side by side instead of one after another.
 *
 * `pnpm check` stays the reference: it runs the same steps in order and stops at the first failure.
 * This script runs every step to the end, writes one log per step and reports them together.
 *
 * Usage: node scripts/check-parallel.ts [--changed <git ref>] [--only a,b] [--skip a,b] [--logs <dir>]
 *
 * --changed <ref>  run only the test files that import something changed since <ref>
 *                  (vitest's own module graph decides). Without it the whole Node.js suite runs.
 * --only, --skip   step names: eslint, prettier, typecheck, deps, build, test.
 * --logs <dir>     where the logs go (default node_modules/.cache/check).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';

type Step = { name: string; command: string };
type Outcome = { name: string; code: number; seconds: number; log: string };

const argv = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const changed = option('--changed');
const only = list(option('--only'));
const skip = list(option('--skip'));
const logs = resolve(option('--logs') ?? join('node_modules', '.cache', 'check'));
if (changed !== undefined && !/^[\w./@^~-]+$/.test(changed))
  throw new Error(`--changed: not a git ref: ${changed}`);

// The test runner takes most of the cores by itself. The type-check is one compiler per package,
// so a third of the cores is enough to keep every package moving without starving the tests.
const cores = availableParallelism();
const typecheckJobs = Math.max(2, Math.floor(cores / 3));

const steps: Step[] = [
  { name: 'eslint', command: 'pnpm exec eslint . --concurrency auto' },
  {
    name: 'prettier',
    command:
      'pnpm exec prettier --check . --cache --cache-strategy content --cache-location node_modules/.cache/prettier/.prettier-cache',
  },
  {
    name: 'typecheck',
    command: `pnpm -r --workspace-concurrency=${typecheckJobs} --if-present typecheck`,
  },
  { name: 'deps', command: 'pnpm deps:check' },
  { name: 'build', command: 'pnpm build' },
  {
    name: 'test',
    command:
      'pnpm exec vitest run --project node' +
      (changed === undefined ? '' : ` --changed ${changed}`),
  },
].filter((s) => (only.length === 0 || only.includes(s.name)) && !skip.includes(s.name));

const known = ['eslint', 'prettier', 'typecheck', 'deps', 'build', 'test'];
for (const name of [...only, ...skip])
  if (!known.includes(name)) throw new Error(`unknown step "${name}" (${known.join(', ')})`);
if (steps.length === 0) throw new Error('no steps left to run');

mkdirSync(logs, { recursive: true });

function run(step: Step): Promise<Outcome> {
  const log = join(logs, `${step.name}.log`);
  const started = performance.now();
  return new Promise((done) => {
    const out = createWriteStream(log);
    // A shell is needed on Windows, where pnpm is a .cmd file. The commands above are fixed
    // strings; the one value from the command line (--changed) is checked against a ref pattern.
    const child = spawn(step.command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    const finish = (code: number): void => {
      out.end(() => {
        const seconds = Math.round((performance.now() - started) / 1000);
        console.log(`${code === 0 ? 'ok    ' : 'FAILED'} ${step.name} (${seconds} s)`);
        done({ name: step.name, code, seconds, log });
      });
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
  });
}

// The reference host's tsconfig extends "$app/tsconfig", which `svelte-kit sync` writes under its
// node_modules. In `pnpm check` the type-check runs before the tests and does it. Side by side the
// tests started first and the files that import the host failed with "Tsconfig not found". So sync
// once, before anything starts.
if (steps.some((s) => s.name === 'test' || s.name === 'typecheck')) {
  const sync = spawnSync('pnpm --filter @docedit/reference-host exec svelte-kit sync', {
    shell: true,
    stdio: 'inherit',
  });
  if (sync.status !== 0) throw new Error('svelte-kit sync failed');
}

const started = performance.now();
console.log(`Running ${steps.map((s) => s.name).join(', ')} side by side. Logs: ${logs}`);
const outcomes = await Promise.all(steps.map(run));
const failed = outcomes.filter((o) => o.code !== 0);

for (const o of failed) {
  const tail = readFileSync(o.log, 'utf8').split(/\r?\n/).slice(-40).join('\n');
  console.log(`\n--- ${o.name}: last lines of ${o.log}\n${tail}`);
}
const total = Math.round((performance.now() - started) / 1000);
console.log(
  `\n${failed.length === 0 ? 'All steps passed' : `Failed: ${failed.map((o) => o.name).join(', ')}`} in ${total} s.`,
);
process.exit(failed.length === 0 ? 0 : 1);
