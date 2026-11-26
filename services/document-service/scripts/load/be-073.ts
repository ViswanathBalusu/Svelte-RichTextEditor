/**
 * BE-073: a hot document in a dedicated process, as real processes. From the repository root, with
 * PostgreSQL (infra/test-env.ps1 up) and a Valkey server (`--valkey redis://127.0.0.1:PORT`):
 *
 *   node services/document-service/scripts/load/be-073.ts --valkey redis://127.0.0.1:56575
 *     [--seconds 6] [--others 8] [--hot-writers 12] [--out report.json]
 *
 * It starts two service processes over one database and one Valkey bus: a general node and a node
 * dedicated to one document (`DOCEDIT_DEDICATED_DOCUMENT`), pins the dedicated process to one core
 * and the general one to the others, and measures the acknowledgement latency of other documents on
 * the general node in three phases: alone, while writers saturate the hot document (on the
 * dedicated process), and, as a contrast, while the same writers saturate a document that has no
 * dedicated node. The figures belong to the machine and the load of that moment; a report quotes
 * them with `machine`.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { createTestDatabase, postgresUnavailable, settings } from '../../test/support/env.ts';
import {
  LoadClient,
  createDocument,
  makeContent,
  mapLimit,
  mintToken,
  removeSeed,
  round,
  sleep,
  startServiceProcess,
  summarise,
  type ServiceHandle,
} from './lib.ts';

const run = promisify(execFile);

/** Sets the processor affinity of a process to `cpus` (zero-based). False when the host cannot. */
export async function pinProcess(pid: number, cpus: readonly number[]): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const mask = cpus.reduce((m, c) => m | (1n << BigInt(c)), 0n);
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr]${mask.toString()}`,
        ],
        { windowsHide: true },
      );
    } else {
      await run('taskset', ['-cp', cpus.join(','), String(pid)]);
    }
    return true;
  } catch {
    return false;
  }
}

/** The processor affinity of a process as a list of cores, or null when it cannot be read. */
export async function affinityOf(pid: number): Promise<number[] | null> {
  try {
    let mask: bigint;
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-Command', `[int64](Get-Process -Id ${pid}).ProcessorAffinity`],
        { windowsHide: true },
      );
      mask = BigInt(stdout.trim());
    } else {
      const { stdout } = await run('taskset', ['-p', String(pid)]);
      mask = BigInt('0x' + /: ([0-9a-f]+)\s*$/i.exec(stdout.trim())![1]!);
    }
    const cpus: number[] = [];
    for (let i = 0; mask >> BigInt(i) > 0n; i++) if ((mask >> BigInt(i)) & 1n) cpus.push(i);
    return cpus;
  } catch {
    return null;
  }
}

/** Processor seconds a process has used so far, or null when they cannot be read. */
export async function cpuSeconds(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`],
        { windowsHide: true },
      );
      return Number(stdout.trim().replace(',', '.'));
    }
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return null;
  }
}

export interface HotSettings {
  valkeyUrl: string;
  databaseUrl: string;
  /** Seconds each phase runs. */
  seconds: number;
  /** Paced writers on other documents. */
  others: number;
  /** Pause between a paced writer's commits. */
  intervalMs: number;
  /** Writers on the hot document, each with one commit in flight, back to back. */
  hotWriters: number;
  /** Paragraphs in the hot document (each commit works on a document of that size). */
  paragraphs: number;
}

export interface PhaseResult {
  ackMs: { count: number; p50: number; p95: number; p99: number; max: number };
  hotCommits: number;
  /** Processor seconds per wall second of the dedicated and the general process. */
  coresUsed: { dedicated: number | null; general: number | null };
}

export interface HotReport {
  machine: { cpus: number; platform: string; node: string };
  pinned: { dedicated: number[] | null; general: number[] | null };
  routing: { hotDocument: string; channelOpenedOnGeneral: boolean };
  baseline: PhaseResult;
  dedicated: PhaseResult;
  contrast: PhaseResult;
  /** Called with the ids so a test can read the head of the hot document. */
  ids: { hot: string; tenant: string };
}

const ms = (s: ReturnType<typeof summarise>) => ({
  count: s.n,
  p50: round(s.p50, 2),
  p95: round(s.p95, 2),
  p99: round(s.p99, 2),
  max: round(s.max, 2),
});

function ack(m: { t: string; d?: Record<string, unknown> } | null | undefined): number | null {
  return m?.t === 'sync.ack' && typeof m.d?.['seq'] === 'number' ? (m.d['seq'] as number) : null;
}

export interface Topology {
  general: ServiceHandle;
  dedicated: ServiceHandle;
  hot: string;
  contrast: string;
  stop(): Promise<void>;
}

export async function startTopology(s: HotSettings, paragraphs: number): Promise<Topology> {
  const common = {
    databaseUrl: s.databaseUrl,
    env: {
      DOCEDIT_VALKEY_URL: s.valkeyUrl,
      ...Object.fromEntries(
        Object.entries(settings()).filter(([k]) => k.startsWith('DOCEDIT_S3_')),
      ),
    },
  };
  const general = await startServiceProcess({
    ...common,
    env: { ...common.env, DOCEDIT_NODE_ID: 'node-general' },
  });
  const hot = await createDocument(general, makeContent(paragraphs));
  const contrast = await createDocument(general, makeContent(paragraphs));
  const dedicated = await startServiceProcess({
    ...common,
    tenant: general.seed,
    env: { ...common.env, DOCEDIT_NODE_ID: 'node-dedicated', DOCEDIT_DEDICATED_DOCUMENT: hot },
  });
  return {
    general,
    dedicated,
    hot,
    contrast,
    async stop() {
      await dedicated.stop().catch(() => {});
      await general.stop().catch(() => {});
      await removeSeed(general).catch(() => {});
    },
  };
}

export async function measure(
  t: Topology,
  s: HotSettings,
  hotDoc: string | null,
): Promise<PhaseResult> {
  const { general, dedicated } = t;
  const otherDocs = await mapLimit(Array.from({ length: s.others }), 8, () =>
    createDocument(general, makeContent()),
  );
  const open = async (doc: string, sub: string) => {
    const c = await LoadClient.connect(
      general.wsUrl,
      await mintToken(general, sub, { [doc]: 'editor' }),
    );
    const o = await c.open(1, doc);
    if (o.msg?.t !== 'ch.opened') throw new Error(`open answered ${JSON.stringify(o.msg)}`);
    return { c, head: Number((o.msg.d as { head?: number } | undefined)?.head ?? 0) };
  };
  const others = (await mapLimit(otherDocs, 8, (d, i) => open(d, `other-${i}`))).map((o) => o.c);
  const hotOpened = hotDoc
    ? await mapLimit(Array.from({ length: s.hotWriters }), 8, (_, i) => open(hotDoc, `hot-${i}`))
    : [];
  const hotClients = hotOpened.map((o) => o.c);
  const samples: number[] = [];
  let hotCommits = 0;
  let stop = false;
  const cpu0 = { d: await cpuSeconds(dedicated.pid), g: await cpuSeconds(general.pid) };
  const wall0 = performance.now();
  const hotRuns = hotOpened.map(async ({ c, head }) => {
    let base = head;
    while (!stop) {
      const r = await c.submit(1, base, 'h', 30_000).catch(() => null);
      const seq = ack(r?.msg);
      if (seq !== null) {
        base = seq;
        hotCommits++;
      } else await sleep(1);
    }
  });
  const paced = others.map(async (c) => {
    let base = 0;
    for (let i = 0; i < 5; i++) base = ack((await c.submit(1, base, 'w')).msg) ?? base;
    const end = performance.now() + s.seconds * 1000;
    while (performance.now() < end) {
      const r = await c.submit(1, base, 'x');
      const seq = ack(r.msg);
      if (seq !== null) {
        base = seq;
        samples.push(r.ms);
      }
      await sleep(s.intervalMs);
    }
  });
  await Promise.all(paced);
  const wall = (performance.now() - wall0) / 1000;
  const cpu1 = { d: await cpuSeconds(dedicated.pid), g: await cpuSeconds(general.pid) };
  stop = true;
  await Promise.all(hotRuns);
  for (const c of [...others, ...hotClients]) c.close();
  const use = (a: number | null, b: number | null) =>
    a === null || b === null ? null : round((b - a) / wall, 2);
  return {
    ackMs: ms(summarise(samples)),
    hotCommits,
    coresUsed: { dedicated: use(cpu0.d, cpu1.d), general: use(cpu0.g, cpu1.g) },
  };
}

export async function runHotDocument(s: HotSettings): Promise<HotReport> {
  const t = await startTopology(s, s.paragraphs);
  try {
    const cores = os.availableParallelism();
    const last = cores - 1;
    const dedicatedPinned =
      cores >= 3 && (await pinProcess(t.dedicated.pid, [last]))
        ? await affinityOf(t.dedicated.pid)
        : null;
    const generalPinned =
      dedicatedPinned &&
      (await pinProcess(
        t.general.pid,
        Array.from({ length: last }, (_, i) => i),
      ))
        ? await affinityOf(t.general.pid)
        : null;
    // The hot document's room must be on the dedicated node, whichever node the client reaches.
    const probe = await LoadClient.connect(
      t.general.wsUrl,
      await mintToken(t.general, 'probe', { [t.hot]: 'editor' }),
    );
    const opened = await probe.open(1, t.hot);
    await probe.submit(1, 0, 'p');
    probe.close();
    const baseline = await measure(t, s, null);
    const dedicated = await measure(t, s, t.hot);
    const contrast = await measure(t, s, t.contrast);
    return {
      machine: { cpus: cores, platform: process.platform, node: process.version },
      pinned: { dedicated: dedicatedPinned, general: generalPinned },
      routing: { hotDocument: t.hot, channelOpenedOnGeneral: opened.msg?.t === 'ch.opened' },
      baseline,
      dedicated,
      contrast,
      ids: { hot: t.hot, tenant: t.general.tenant },
    };
  } finally {
    await t.stop();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      valkey: { type: 'string' },
      seconds: { type: 'string', default: '6' },
      others: { type: 'string', default: '8' },
      'hot-writers': { type: 'string', default: '8' },
      paragraphs: { type: 'string', default: '300' },
      out: { type: 'string' },
    },
  });
  if (!values.valkey) {
    console.error('--valkey redis://127.0.0.1:PORT is required');
    process.exit(2);
  }
  const why = await postgresUnavailable();
  if (why) {
    console.error(why);
    process.exit(2);
  }
  const db = await createTestDatabase();
  try {
    const c = db.serviceConfig;
    const report = await runHotDocument({
      valkeyUrl: values.valkey,
      databaseUrl: `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`,
      seconds: Number(values.seconds),
      others: Number(values.others),
      intervalMs: 20,
      hotWriters: Number(values['hot-writers']),
      paragraphs: Number(values.paragraphs),
    });
    const text = JSON.stringify(report, null, 2);
    if (values.out) await writeFile(values.out, text);
    console.log(text);
  } finally {
    await db.drop();
  }
}
