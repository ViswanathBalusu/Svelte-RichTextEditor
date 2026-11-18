/**
 * FND-009: runs the latency, load and fault scenarios against the real service process and prints
 * a JSON report. From the repository root:
 *
 *   node services/document-service/scripts/load/fnd-009.ts [--storage memory|postgres]
 *     [--only ack,cold,ramp,drop,kill,outage] [--out report.json] [--ramp 100:25,500:125,2000:500]
 *     [--hold-ms 5000] [--interval-ms 2000]
 *     [--writers 20] [--commits 200] [--ack-interval-ms 0]
 *
 * With `--storage postgres` the service uses the database of the integration-test environment
 * (FND-010; `pwsh -NoProfile -File infra/test-env.ps1 up`), in a database of its own that is
 * dropped at the end. The kill scenario needs it: a killed process loses memory storage.
 *
 * The report names the machine and the settings of every run. The targets are the specification's
 * (00 §9; 06 §6); a run on a development machine is a measurement of that machine, not of the
 * reference machine of ADR 0037.
 */
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createTestDatabase, postgresUnavailable, settings } from '../../test/support/env.ts';
import { removeSeed, startServiceProcess, type ServiceHandle, type ServiceOptions } from './lib.ts';
import {
  TARGETS,
  ackLatency,
  coldOpen,
  databaseOutage,
  dropConnections,
  killProcess,
  ramp,
} from './scenarios.ts';

const { values } = parseArgs({
  options: {
    storage: { type: 'string', default: 'memory' },
    only: { type: 'string', default: 'ack,cold,ramp,drop,kill,outage' },
    out: { type: 'string' },
    ramp: { type: 'string', default: '100:25,250:63,500:125,1000:250,1500:375,2000:500' },
    'hold-ms': { type: 'string', default: '5000' },
    'interval-ms': { type: 'string', default: '2000' },
    writers: { type: 'string', default: '20' },
    'ack-interval-ms': { type: 'string', default: '0' },
    commits: { type: 'string', default: '200' },
    documents: { type: 'string', default: '30' },
    paragraphs: { type: 'string', default: '4000' },
  },
});
const only = new Set(String(values.only).split(','));
const storage = values.storage === 'postgres' ? 'postgres' : 'memory';

const machine = {
  platform: `${os.platform()} ${os.release()}`,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  logicalCpus: os.cpus().length,
  memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
  node: process.version,
};

let drop: (() => Promise<void>) | null = null;
const options: ServiceOptions = {};
if (storage === 'postgres') {
  const why = await postgresUnavailable();
  if (why) {
    console.error(why);
    process.exit(2);
  }
  const db = await createTestDatabase();
  const c = db.serviceConfig;
  options.databaseUrl = `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
  await db.service.end();
  drop = () => db.drop();
  // Checkpoints go to the S3-compatible store of the same environment, which outlives the process.
  const env = settings();
  options.env = Object.fromEntries(
    Object.entries(env).filter(([k]) => k.startsWith('DOCEDIT_S3_')),
  );
}

const report: Record<string, unknown> = {
  harness: 'FND-009',
  date: new Date().toISOString(),
  storage,
  machine,
  targets: TARGETS,
  note: 'The load generator and the service run on one machine as two processes, so the network is the loopback interface.',
};
const started: ServiceHandle[] = [];
const spawnService = async (o: ServiceOptions) => {
  const s = await startServiceProcess({ ...options, ...o });
  started.push(s);
  return s;
};

try {
  if (only.has('ack') || only.has('cold') || only.has('ramp')) {
    const svc = await spawnService({});
    if (only.has('ack'))
      report['ackLatency'] = await ackLatency(svc, {
        writers: Number(values.writers),
        commitsPerWriter: Number(values.commits),
        warmup: 20,
        intervalMs: Number(values['ack-interval-ms']),
      });
    if (only.has('cold'))
      report['coldOpen'] = await coldOpen(svc, {
        documents: Number(values.documents),
        paragraphs: Number(values.paragraphs),
      });
    if (only.has('ramp'))
      report['ramp'] = await ramp(svc, {
        steps: String(values.ramp)
          .split(',')
          .map((p) => {
            const [connections, documents] = p.split(':').map(Number);
            return { connections: connections!, documents: documents! };
          }),
        holdMs: Number(values['hold-ms']),
        commitIntervalMs: Number(values['interval-ms']),
        connectConcurrency: 50,
      });
    await svc.stop();
  }
  if (only.has('drop') || only.has('outage')) {
    const svc = await spawnService({ testMode: true });
    if (only.has('drop'))
      report['dropConnections'] = await dropConnections(svc, { writers: 50, commits: 5 });
    if (only.has('outage'))
      report['databaseOutage'] = await databaseOutage(svc, { outageMs: 1500 });
    await svc.stop();
  }
  if (only.has('kill')) {
    if (storage !== 'postgres') report['killProcess'] = { skipped: 'needs --storage postgres' };
    else {
      const svc = await spawnService({});
      const r = await killProcess(svc, options, { documents: 10, commits: 20 });
      started.push(r.restarted);
      const { restarted: _restarted, ...rest } = r;
      report['killProcess'] = rest;
      await r.restarted.stop();
    }
  }
} finally {
  for (const s of started) await s.kill().catch(() => {});
  for (const s of started.slice(0, 1)) await removeSeed(s).catch(() => {});
  await drop?.().catch(() => {});
}
const text = JSON.stringify(report, null, 2);
if (values.out) await writeFile(values.out, text + '\n');
console.log(text);
