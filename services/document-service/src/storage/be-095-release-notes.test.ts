/**
 * BE-095 criteria 2 and 4: the release notes state database steps, CDM steps and the rollback, and
 * the upgrade guide says that more than one minor version cannot be skipped.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  cdmNotes,
  loadMigrations,
  loadReleases,
  releaseNoteProblems,
  releaseNotes,
  type Release,
} from './migrate.ts';

describe('release notes state the CDM steps (BE-095 criterion 2)', () => {
  it('has no problem in the releases the repository ships, and every one states its CDM steps', async () => {
    const releases = await loadReleases();
    expect(releaseNoteProblems(releases)).toEqual([]);
    for (const r of releases) expect(r.cdm, r.version).toBeDefined();
  });

  it('prints the database steps with their rollback and then the CDM steps with theirs', async () => {
    const migrations = await loadMigrations();
    const releases = await loadReleases();
    const notes = Object.assign({}, ...releases.map((r) => r.rollback ?? {})) as Record<
      string,
      string
    >;
    const r = releases[0]!;
    const out = `${releaseNotes(migrations, r.migrations, notes)}\n${cdmNotes(r)}`;
    expect(out).toContain('How to roll back');
    expect(out).toContain('CDM steps of 0.1.0-phase1a');
    expect(out).toContain('No CDM steps.');
    expect(out).toContain('How to roll back the CDM steps: Nothing to undo');
  });

  it('lists the steps of a release that has some', () => {
    const r: Release = {
      version: '1.2.0',
      migrations: [],
      cdm: { steps: ['cdm-1-to-2: re-snapshot each document'], rollback: 'restore the backup' },
    };
    const out = cdmNotes(r);
    expect(out).toContain('- cdm-1-to-2: re-snapshot each document');
    expect(out).toContain('How to roll back the CDM steps: restore the backup');
  });

  it('refuses a release that does not state its CDM steps or gives no rollback for them', () => {
    expect(releaseNoteProblems([{ version: '1.0.0', migrations: [] }])).toEqual([
      'release 1.0.0 does not state its CDM steps (cdm.steps, cdm.rollback)',
    ]);
    expect(
      releaseNoteProblems([{ version: '1.0.0', migrations: [], cdm: { steps: [], rollback: ' ' } }]),
    ).toEqual(['release 1.0.0 gives no rollback note for its CDM steps']);
  });

  it('says plainly when a release is not listed and has no CDM statement', () => {
    expect(cdmNotes(undefined)).toContain('not stated yet');
  });
});

describe('the upgrade guide (BE-095 criterion 4)', () => {
  it('describes skipping one minor and says more than one is not supported', async () => {
    const guide = await readFile(new URL('../../docs/upgrade-guide.md', import.meta.url), 'utf8');
    expect(guide).toMatch(/skips? one minor version/i);
    expect(guide).toMatch(/More than one skipped minor version is not supported/);
    expect(guide).toContain('migrate notes');
  });
});
