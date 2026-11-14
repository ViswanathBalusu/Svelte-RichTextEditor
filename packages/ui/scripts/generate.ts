/**
 * Writes the shell's published artifacts: the parity profile (UX-001; spec/parity/) and the
 * shortcut table (UX-013; spec/shortcuts/). Run with `pnpm --filter @docedit/ui generate`
 * (Node.js 22.18 runs this TypeScript file directly). Refuses to write, and exits with 1, while any
 * check fails: for example a built-in command whose capability no row lists, a non-goal with a
 * delivering story, a command whose keys have no row in the shortcut table, or a key bound twice.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinCommands } from '../src/commands/builtin.ts';
import { buildProfile } from '../src/parity/build.ts';
import { buildShortcutTable } from '../src/shortcuts/build.ts';
import { readParityInput } from './parity-input.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const results = [
  { name: 'parity profile', result: buildProfile(readParityInput(root)) },
  {
    name: 'shortcut table',
    result: buildShortcutTable(builtinCommands().map((c) => ({ id: c.id, keys: c.keys ?? [] }))),
  },
];
let failed = false;
for (const { name, result } of results)
  if (result.problems.length) {
    failed = true;
    console.error(`The ${name} fails its checks (${result.problems.length}):`);
    for (const p of result.problems) console.error(`  - ${p}`);
  }
if (failed) process.exit(1);
for (const { result } of results)
  for (const a of result.artifacts) {
    const file = resolve(root, a.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, a.text, 'utf8');
    console.log(`wrote ${a.path}`);
  }
