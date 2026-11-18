/**
 * BE-058: the stage 1 load test of one node, as a command. From the repository root:
 *
 *   node services/document-service/scripts/load/be-058.ts [--storage memory|postgres]
 *     [--out report.json] [--baseline baseline.json] [--tolerance-pct 50] [--floor-ms 10]
 *     [--connections 2000] [--documents 500] [--typists 25,50,75,100,150] [--gate-typists 50]
 *     [--rate 3] [--hold-ms 20000]
 *     [--cold-documents 20] [--cold-paragraphs 4000] [--event-loop-budget-ms 300]
 *     [--drain-wait-ms 90000] [--heap-mib N]
 *
 * It exits 0 when the run passes the gate and 1 when it does not. With `--baseline` the gate
 * compares the run with an earlier report of this command (see `gate` in `stage1.ts`); without it
 * only the hard checks apply (no slow consumer, rooms back to zero, every connection and commit
 * served, event loop within its budget). The report is written with `--out` and printed.
 *
 * With `--storage postgres` the service uses the database of the integration-test environment
 * (FND-010; `pwsh -NoProfile -File infra/test-env.ps1 up`), in a database of its own that is
 * dropped at the end, and the report lists the database settings that matter to the run.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createTestDatabase, postgresUnavailable, settings } from '../../test/support/env.ts';
import { removeSeed, startServiceProcess, type ServiceOptions } from './lib.ts';
import { GATE_DEFAULTS, STAGE1_DEFAULTS, gate, stage1, type Stage1Result } from './stage1.ts';

const { values } = parseArgs({
  options: {
    storage: { type: 'string', default: 'memory' },
    out: { type: 'string' },
    baseline: { type: 'string' },
    'tolerance-pct': { type: 'string', default: String(GATE_DEFAULTS.tolerancePct) },
    'floor-ms': { type: 'string', default: String(GATE_DEFAULTS.floorMs) },
    connections: { type: 'string', default: String(STAGE1_DEFAULTS.connections) },
    documents: { type: 'string', default: String(STAGE1_DEFAULTS.documents) },
    typists: { type: 'string', default: STAGE1_DEFAULTS.typistSteps.join(',') },
    'gate-typists': { type: 'string', default: String(STAGE1_DEFAULTS.gateTypists) },
    rate: { type: 'string', default: String(STAGE1_DEFAULTS.commitsPerSecond) },
    'hold-ms': { type: 'string', default: String(STAGE1_DEFAULTS.holdMs) },
    'cold-documents': { type: 'string', default: String(STAGE1_DEFAULTS.coldDocuments) },
    'cold-paragraphs': { type: 'string', default: String(STAGE1_DEFAULTS.coldParagraphs) },
    'event-loop-budget-ms': { type: 'string', default: String(STAGE1_DEFAULTS.eventLoopBudgetMs) },
    'drain-wait-ms': { type: 'string', default: String(STAGE1_DEFAULTS.drainWaitMs) },
    'heap-mib': { type: 'string' },
  },
});
const storage = values.storage === 'postgres' ? 'postgres' : 'memory';
const metricsToken = randomBytes(24).toString('hex');

const options: ServiceOptions = { env: { DOCEDIT_METRICS_TOKEN: metricsToken } };
let drop: (() => Promise<void>) | null = null;
let database: Record<string, string> | null = null;
if (storage === 'postgres') {
  const why = await postgresUnavailable();
  if (why) {
    console.error(why);
    process.exit(2);
  }
  const db = await createTestDatabase();
  const c = db.serviceConfig;
  options.databaseUrl = `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
  // The settings of the server that bear on commit latency and connection counts.
  const names = [
    'server_version',
    'max_connections',
    'shared_buffers',
    'synchronous_commit',
    'fsync',
    'wal_sync_method',
    'wal_level',
    'checkpoint_timeout',
    'max_wal_size',
  ];
  database = {};
  for (const n of names) {
    const r = await db.service.query(`SELECT current_setting($1) AS v`, [n]);
    database[n] = String((r.rows[0] as { v: string }).v);
  }
  await db.service.end();
  drop = () => db.drop();
  const env = settings();
  Object.assign(
    options.env!,
    Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('DOCEDIT_S3_'))),
  );
}
if (values['heap-mib']) options.env!['NODE_OPTIONS'] = `--max-old-space-size=${values['heap-mib']}`;

const svc = await startServiceProcess(options);
let result: Stage1Result;
try {
  result = await stage1(svc, {
    connections: Number(values.connections),
    documents: Number(values.documents),
    typistSteps: String(values.typists).split(',').map(Number),
    gateTypists: Number(values['gate-typists']),
    commitsPerSecond: Number(values.rate),
    holdMs: Number(values['hold-ms']),
    coldDocuments: Number(values['cold-documents']),
    coldParagraphs: Number(values['cold-paragraphs']),
    connectConcurrency: STAGE1_DEFAULTS.connectConcurrency,
    eventLoopBudgetMs: Number(values['event-loop-budget-ms']),
    drainWaitMs: Number(values['drain-wait-ms']),
    metricsToken,
  });
} finally {
  await svc.stop().catch(() => svc.kill());
  await removeSeed(svc).catch(() => {});
  await drop?.().catch(() => {});
}

let verdict: { baseline: string | null; ok: boolean; failures: string[] };
if (values.baseline) {
  const baseline = JSON.parse(await readFile(values.baseline, 'utf8')) as {
    run: Stage1Result;
  };
  const g = gate(result, baseline.run, {
    tolerancePct: Number(values['tolerance-pct']),
    floorMs: Number(values['floor-ms']),
  });
  verdict = { baseline: values.baseline, ...g };
} else {
  const g = gate(result, result);
  verdict = { baseline: null, ...g };
}

const report = {
  harness: 'BE-058',
  date: new Date().toISOString(),
  storage,
  node: {
    machine: {
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCpus: os.cpus().length,
      memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    },
    nodeVersion: process.version,
    serviceHeapLimitMiB: values['heap-mib'] ? Number(values['heap-mib']) : 'node default',
    note: 'The load generator and the service run on one machine as two processes, over the loopback interface.',
  },
  database,
  run: result,
  gate: verdict,
};
const text = JSON.stringify(report, null, 2);
if (values.out) await writeFile(values.out, text + '\n');
console.log(text);
process.exit(verdict.ok ? 0 : 1);
