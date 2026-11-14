/**
 * `node apps/reference-host/scripts/log-report.ts <document-id>`: what the demo stack's commit log
 * holds for one document, read back from PostgreSQL with the service role through the document
 * service's own storage classes (HIS-001, HIS-002, HIS-003; 08 §2), as JSON on standard output.
 * The exit-check scenario uses it for "the commit log is recorded in full" (11 §3).
 */
import { createPool, PgGrantStore, PgLogStore, PgUserDirectory } from '@docedit/document-service';
import { endpoints, seedTenant, stackSettings } from './lib/stack.ts';

const doc = process.argv[2];
if (!doc) {
  console.error('usage: log-report.ts <document-id> [sub ...]');
  process.exit(2);
}
const subs = process.argv.slice(3);

/** The text a step inserts, if any: the text nodes of its slice. */
function inserted(step: unknown): string {
  let out = '';
  const walk = (n: unknown) => {
    if (n === null || typeof n !== 'object') return;
    const node = n as { type?: unknown; text?: unknown; content?: unknown };
    if (node.type === 'text' && typeof node.text === 'string') out += node.text;
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  const slice = (step as { slice?: { content?: unknown } }).slice;
  if (slice && Array.isArray(slice.content)) slice.content.forEach(walk);
  return out;
}

const pool = createPool({
  connectionString: endpoints(stackSettings()).serviceDatabaseUrl,
  max: 2,
});
try {
  const ref = { tenant: seedTenant().id, doc };
  const grants = new PgGrantStore(pool);
  const logs = new PgLogStore(pool, { permissions: (r) => grants.current(r) });
  const users = new PgUserDirectory(pool);
  const head = await logs.head(ref);
  const commits = head.seq > 0 ? await logs.read(ref, 1, head.seq) : [];
  const verdict = await logs.verify(ref);
  const surrogates: Record<string, string> = {};
  for (const sub of subs) surrogates[sub] = (await users.resolve(ref.tenant, sub)).surrogate;
  const report = {
    head: head.seq,
    verdict,
    grantsRevision: (await grants.current(ref)).revision,
    surrogates,
    commits: commits.map((c) => ({
      seq: c.seq,
      kind: c.kind,
      id: c.id,
      user: c.user,
      session: c.session,
      time: c.time,
      origin: c.origin,
      base: c.base ?? null,
      rebased: c.rebased ?? null,
      revision: c.revision,
      scopes: c.scopes,
      jti: c.jti ?? null,
      cdm: c.cdm,
      engine: c.engine,
      steps: c.steps.length,
      inserted: c.steps.map(inserted).join(''),
    })),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await pool.end();
}
