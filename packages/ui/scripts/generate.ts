/**
 * Writes the shell's published artifacts: the parity profile (UX-001; spec/parity/), the
 * shortcut table (UX-013; spec/shortcuts/) and the embedding reference (UX-090; spec/embedding/). Run with `pnpm --filter @docedit/ui generate`
 * (Node.js 22.18 runs this TypeScript file directly). Refuses to write, and exits with 1, while any
 * check fails: for example a built-in command whose capability no row lists, a non-goal with a
 * delivering story, a command whose keys have no row in the shortcut table, or a key bound twice.
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinCommands } from '../src/commands/builtin.ts';
import { homeCommands } from '../src/commands/home.ts';
import { buildProfile } from '../src/parity/build.ts';
import { buildShortcutTable } from '../src/shortcuts/build.ts';
import { readParityInput } from './parity-input.ts';
import { buildEmbeddingReference } from './embedding-reference.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const elementFile = (name: string) =>
  readFileSync(resolve(root, 'packages/element/src', name), 'utf8');
/** The built-in commands: those of the first load, and the Home tab's, which load after it (ADR 0490). */
const commands = [...builtinCommands(), ...homeCommands()];
const results = [
  { name: 'parity profile', result: buildProfile(readParityInput(root)) },
  {
    name: 'shortcut table',
    result: buildShortcutTable(commands.map((c) => ({ id: c.id, keys: c.keys ?? [] }))),
  },
  {
    name: 'embedding reference',
    result: buildEmbeddingReference({
      docEditorSource: elementFile('doc-editor.ts'),
      eventsSource: elementFile('events.ts'),
      versionSource: elementFile('version.ts'),
      registerSource: elementFile('register.ts'),
      configSchema: JSON.parse(elementFile('config.schema.json')),
      commands: commands.map((c) => ({
        id: c.id,
        group: c.group,
        capability: c.capability,
        keys: c.keys ?? [],
        aliases: c.aliases ?? [],
      })),
    }),
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
