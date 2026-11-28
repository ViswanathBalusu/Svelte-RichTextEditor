/**
 * Reads what the parity profile is built from (UX-001): the profile source, the built-in commands,
 * the epic files of docs/stories and docs/spec/13. Shared by the generator and the tests, so both
 * build from the same inputs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { builtinCommands } from '../src/commands/builtin.ts';
import { homeCommands } from '../src/commands/home.ts';
import { type BuildInput, parseStories } from '../src/parity/build.ts';
import { PROFILE } from '../src/parity/profile.ts';

/** Files of docs/stories that hold no stories. */
const NOT_EPICS = /^(README|BACKLOG|PLAN-.*|PROGRESS|TRACEABILITY)\.md$/;

export function readParityInput(root: string): BuildInput {
  const storiesDir = join(root, 'docs', 'stories');
  const files = readdirSync(storiesDir)
    .filter((name) => name.endsWith('.md') && !NOT_EPICS.test(name))
    .sort()
    .map((name) => ({ text: readFileSync(join(storiesDir, name), 'utf8').replace(/\r\n/g, '\n') }));
  return {
    profile: PROFILE,
    commands: [...builtinCommands(), ...homeCommands()].map((c) => ({
      id: c.id,
      capability: c.capability,
    })),
    stories: parseStories(files),
    spec13: readFileSync(
      join(root, 'docs', 'spec', '13-experience-extensibility.md'),
      'utf8',
    ).replace(/\r\n/g, '\n'),
  };
}
