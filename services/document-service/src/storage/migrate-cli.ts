/**
 * `pnpm --filter @docedit/document-service migrate`: applies the migrations to the database named
 * by DOCEDIT_DATABASE_URL, connecting as the schema owner (not the service role; BE-011).
 *
 * `migrate notes [release]` prints the database steps of a release (default: the next one, the
 * migrations no release lists yet) and how to roll it back, for the release notes (BE-016
 * criterion 5). `migrate check` checks the expand-and-contract plan (criterion 2) and the row-level
 * security of every table the migrations create (BE-011 criterion 6), and exits 1 when either is
 * broken. Neither needs a database.
 */
import pg from 'pg';
import { ShardMap } from '../control-plane/jobs/sharding.ts';
import { migrateShards } from './shards.ts';
import { tenantProblems } from './tenant-guard.ts';
import {
  cdmNotes,
  expectedSchemaVersion,
  loadMigrations,
  loadReleases,
  migrate,
  planProblems,
  releaseNoteProblems,
  releaseNotes,
} from './migrate.ts';

const [command, arg] = process.argv.slice(2);

if (command === 'notes' || command === 'check') {
  const migrations = await loadMigrations();
  const releases = await loadReleases();
  if (command === 'check') {
    const problems = [
      ...planProblems(migrations, releases),
      ...releaseNoteProblems(releases),
      ...tenantProblems(migrations),
    ];
    for (const p of problems) console.error(p);
    process.exit(problems.length ? 1 : 0);
  }
  const listed = new Set(releases.flatMap((r) => r.migrations));
  const release = arg ? releases.find((r) => r.version === arg) : undefined;
  if (arg && !release) {
    console.error(`no release ${arg} in releases.json`);
    process.exit(2);
  }
  const versions = release
    ? release.migrations
    : migrations.map((m) => m.version).filter((v) => !listed.has(v));
  console.log(`Database steps of ${release ? release.version : 'the next release'}:\n`);
  const notes = Object.assign({}, ...releases.map((r) => r.rollback ?? {})) as Record<
    string,
    string
  >;
  console.log(releaseNotes(migrations, versions, notes));
  console.log(cdmNotes(release));
  process.exit(0);
}

// Several shards (BE-070): a JSON object of shard name to database URL, migrated one after the
// other in the order written; a failure stops the rollout and names the shard.
const shardUrls = process.env['DOCEDIT_SHARD_DATABASE_URLS'];
if (shardUrls) {
  const urls = JSON.parse(shardUrls) as Record<string, string>;
  const map = new ShardMap(Object.keys(urls), {});
  const pools = Object.fromEntries(
    Object.entries(urls).map(([shard, u]) => [shard, new pg.Pool({ connectionString: u, max: 1 })]),
  );
  try {
    const applied = await migrateShards(map, pools);
    for (const [shard, versions] of Object.entries(applied))
      console.log(
        `${shard}: ${versions.length ? `applied ${versions.join(', ')}` : 'nothing to apply'}`,
      );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await Promise.all(Object.values(pools).map((p) => p.end()));
  }
  process.exit(process.exitCode ?? 0);
}

const url = process.env['DOCEDIT_DATABASE_URL'];
if (!url) {
  console.error('Set DOCEDIT_DATABASE_URL to the database to migrate, as its owner.');
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client);
  console.log(
    applied.length
      ? `applied ${applied.join(', ')}`
      : `nothing to apply; schema at ${await expectedSchemaVersion()}`,
  );
} finally {
  await client.end();
}
