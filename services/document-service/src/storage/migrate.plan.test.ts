import { describe, expect, it } from 'vitest';
import {
  compatibility,
  loadMigrations,
  loadReleases,
  parseHeader,
  planProblems,
  releaseNotes,
  type Migration,
  type Release,
} from './migrate.ts';

const mig = (version: string, header: string[] = []): Migration => {
  const sql = [...header, 'select 1;'].join('\n') + '\n';
  return {
    version,
    sql,
    checksum: '',
    ...parseHeader(version, sql),
  };
};

const expand = (v: string) => mig(v, ['-- phase: expand', `-- rollback: drop ${v}`]);
const contract = (v: string, of: string) =>
  mig(v, ['-- phase: contract', `-- contracts: ${of}`, '-- rollback: restore the old column']);

describe('expand-and-contract plan over the real migrations (BE-016 criterion 2)', () => {
  it('has no problems in the plan the repository ships', async () => {
    const migrations = await loadMigrations();
    const releases = await loadReleases();
    expect(planProblems(migrations, releases)).toEqual([]);
    // The baseline is the only release so far, so nothing is a contract step yet.
    expect(migrations.every((m) => m.phase !== 'contract')).toBe(true);
  });

  it('lists the baseline migrations as the first release', async () => {
    const releases = await loadReleases();
    expect(releases[0]?.version).toBe('0.1.0-phase1a');
    expect(releases[0]?.migrations).toContain('0007_readiness');
  });
});

describe('planProblems on synthetic plans (BE-016 criterion 2)', () => {
  const releases: Release[] = [
    { version: '1.0.0', migrations: ['0200_add_col'] },
    { version: '1.1.0', migrations: ['0201_drop_old_col'] },
  ];

  it('accepts a contract step that ships one release after its expand step', () => {
    const migrations = [expand('0200_add_col'), contract('0201_drop_old_col', '0200_add_col')];
    expect(planProblems(migrations, releases)).toEqual([]);
  });

  it('refuses a contract step in the same release as its expand step', () => {
    const migrations = [expand('0200_add_col'), contract('0200_drop_old', '0200_add_col')];
    const rel: Release[] = [{ version: '1.0.0', migrations: ['0200_add_col', '0200_drop_old'] }];
    expect(planProblems(migrations, rel)).toEqual([
      '0200_drop_old ships in the same release as 0200_add_col; a contract step ships at least one release later',
    ]);
  });

  it('counts an unreleased contract step as the next release, and refuses it beside its unreleased expand step', () => {
    // Unlisted migrations belong to the next release, so this is a release later and passes.
    const migrations = [expand('0200_add_col'), contract('0201_drop_old_col', '0200_add_col')];
    const rel: Release[] = [{ version: '1.0.0', migrations: ['0200_add_col'] }];
    expect(planProblems(migrations, rel)).toEqual([]);
    // Both unreleased: neither has shipped, so the contract step is not later.
    expect(planProblems(migrations, [])).toEqual([
      '0201_drop_old_col ships in the same release as 0200_add_col; a contract step ships at least one release later',
    ]);
  });

  it('refuses a contract step that names a migration that is not an expand step', () => {
    // A baseline migration is not an expand step, so a contract step may not name it.
    const migrations = [mig('0007_readiness'), contract('0201_drop_old_col', '0007_readiness')];
    expect(planProblems(migrations, [])).toEqual([
      '0201_drop_old_col contracts 0007_readiness, which is not an expand step',
    ]);
  });

  it('refuses a contract step that names no expand step', () => {
    const migrations = [mig('0201_drop', ['-- phase: contract'])];
    expect(planProblems(migrations, [])).toEqual([
      '0201_drop is a contract step but names no expand step (-- contracts:)',
    ]);
  });

  it('treats a migration without a header as a contract step, which needs an expand step', () => {
    const migrations = [mig('0201_unmarked')];
    expect(parseHeader('0201_unmarked', 'select 1;').phase).toBe('contract');
    expect(planProblems(migrations, [])).toEqual([
      '0201_unmarked is a contract step but names no expand step (-- contracts:)',
    ]);
  });

  it('refuses a release that lists a migration that does not exist', () => {
    const rel: Release[] = [{ version: '1.0.0', migrations: ['0299_missing'] }];
    expect(planProblems([], rel)).toEqual([
      'release 1.0.0 lists 0299_missing, which is not a migration',
    ]);
  });
});

describe('parseHeader', () => {
  it('reads the phase, the contracted migration and a rollback note that runs on', () => {
    const sql = [
      '-- phase: contract',
      '-- contracts: 0200_add_col',
      '-- rollback: put the column back and',
      '--   refill it from the new one.',
      '--',
      '-- The summary of the step.',
      'alter table t drop column old;',
    ].join('\n');
    expect(parseHeader('0201_drop', sql)).toEqual({
      phase: 'contract',
      contracts: '0200_add_col',
      rollback: 'put the column back and refill it from the new one.',
      summary: 'The summary of the step.',
    });
  });

  it('marks the baseline migrations as baseline regardless of their text', () => {
    expect(parseHeader('0001_platform', 'select 1;').phase).toBe('baseline');
  });
});

describe('compatibility (BE-016 criterion 1, the rule behind it)', () => {
  it('lets a release run against a newer schema whose extra migrations are expand steps', () => {
    const r = compatibility(
      ['0200_a'],
      [
        { version: '0200_a', phase: 'expand' },
        { version: '0201_b', phase: 'expand' },
      ],
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a release against a newer contract step it does not know', () => {
    const r = compatibility(
      ['0200_a'],
      [
        { version: '0200_a', phase: 'expand' },
        { version: '0201_b', phase: 'contract' },
      ],
    );
    expect(r.ok).toBe(false);
  });

  it('refuses a release whose own migrations are not all applied', () => {
    expect(
      compatibility(['0200_a', '0201_b'], [{ version: '0200_a', phase: 'expand' }]).pending,
    ).toEqual(['0201_b']);
  });
});

describe('releaseNotes (BE-016 criterion 5, the table part)', () => {
  it('lists each database step with its phase and rollback note', () => {
    const notes = releaseNotes([expand('0200_add_col')], ['0200_add_col']);
    expect(notes).toContain('| `0200_add_col` | expand | ');
    expect(notes).toContain('| drop 0200_add_col |');
  });

  it('says so when a release has no database steps', () => {
    expect(releaseNotes([expand('0200_add_col')], [])).toBe('No database steps.\n');
  });

  it('uses the note of releases.json for a migration whose file has none, and the file first', () => {
    const noHeader = mig('0001_first');
    const notes = { '0001_first': 'restore the backup', '0200_add_col': 'ignored' };
    const out = releaseNotes(
      [noHeader, expand('0200_add_col')],
      ['0001_first', '0200_add_col'],
      notes,
    );
    expect(out).toContain('| restore the backup |');
    expect(out).toContain('| drop 0200_add_col |');
    expect(out).not.toContain('ignored');
    expect(releaseNotes([noHeader], ['0001_first'])).toContain('not documented');
  });

  it('documents the rollback of every migration, in every release and in the next one (BE-016 criterion 5)', async () => {
    const migrations = await loadMigrations();
    const releases = await loadReleases();
    const notes = Object.assign({}, ...releases.map((r) => r.rollback ?? {})) as Record<
      string,
      string
    >;
    const listed = new Set(releases.flatMap((r) => r.migrations));
    const sets = [
      ...releases.map((r) => ({ name: r.version, versions: r.migrations })),
      {
        name: 'the next release',
        versions: migrations.map((m) => m.version).filter((v) => !listed.has(v)),
      },
    ];
    for (const s of sets) {
      const out = releaseNotes(migrations, s.versions, notes);
      expect(out, s.name).not.toContain('not documented');
      // One table row for each database step of the release.
      const rows = out.split('\n').filter((l) => l.startsWith('| `'));
      expect(rows.length, s.name).toBe(s.versions.length);
    }
    // A note in releases.json names a migration the release lists, never another.
    for (const r of releases)
      for (const k of Object.keys(r.rollback ?? {})) expect(r.migrations, k).toContain(k);
  });
});
