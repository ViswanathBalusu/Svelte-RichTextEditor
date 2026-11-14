/**
 * `node apps/reference-host/scripts/seed.ts`: seeds the demo documents once the document service
 * is ready (UX-091 criterion 1): each document of seed/documents.json is created through the
 * service with the host's `externalId`, its region grants are stored, and the host's catalogue
 * records its title and roles. Repeating it changes nothing: documents are found by `externalId`.
 */
import { configFromEnv } from '../src/lib/server/config.ts';
import { createFromTemplate } from '../src/lib/server/documents.ts';
import { composeHost } from '../src/lib/server/host.ts';
import { dataDir, endpoints, readSecrets, roleEnv, stackSettings } from './lib/stack.ts';

const s = stackSettings();
const secrets = await readSecrets(dataDir());
const env = { ...process.env, ...roleEnv('host', s, secrets) };

/** Waits for `/readyz` (BE-001 criterion 5): the database answers and the schema is the code's. */
async function ready(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/readyz`);
      if (r.ok) return;
      last = `HTTP ${r.status}: ${await r.text()}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the document service at ${url} is not ready: ${last}`);
}

await ready(endpoints(s).serviceUrl, 60_000);
const host = await composeHost(configFromEnv(env));
for (const d of host.seed.documents) {
  const template = host.seed.templates.find((t) => t.key === d.template);
  if (!template) throw new Error(`seed document ${d.externalId}: no template ${d.template}`);
  const entry = await createFromTemplate(host, {
    template,
    title: d.title,
    creator: d.creator,
    externalId: d.externalId,
  });
  console.log(`seed: ${d.externalId} is document ${entry.id} ("${entry.title}")`);
}
