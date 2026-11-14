/**
 * The structural dump command (BE-089 criteria 3 and 4; 06 §11). The command's core
 * (`runDumpTool`) runs over the memory stores with a capturing logger; the command line itself
 * (`structural-dump-cli.ts`) runs as a child process against PostgreSQL and the S3-compatible
 * store, with the operator's real account and an assignment file. Test values only.
 * The PostgreSQL part skips when PostgreSQL or the object store is not up:
 * pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { createLogger } from '../../src/log.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import {
  AssignmentFileError,
  operatorActor,
  parseOperatorAssignments,
} from '../../src/data-plane/operator-assignments.ts';
import { PgAuditStore } from '../../src/data-plane/pg/audit.ts';
import { collectTextRuns, type StructuralDump } from '../../src/data-plane/structural-dump.ts';
import { EXIT, runDumpTool, type DumpToolDeps } from '../../src/data-plane/structural-dump-tool.ts';
import type { LogStore } from '../../src/storage/types.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  settings,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
/** Canary words written into the document; none may reach a log line, the audit trail or the dump. */
const WORDS = ['Confidential canary alpha', 'secret canary beta', 'canary gamma'];

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function writeWords(p: Plane, doc: string): Promise<void> {
  const a = await p.client('alice', { [doc]: 'owner' });
  await a.open(1, doc);
  for (let i = 0; i < WORDS.length; i++) {
    const r = await a.submit(1, { base: i, steps: [insertText(intro(), WORDS[i]!)] });
    expect(r.t).toBe('sync.ack');
  }
}

function noCanary(text: string): void {
  for (const w of WORDS) expect(text).not.toContain(w);
  expect(text).not.toContain('canary');
}

/** A log store that counts reads, to show a refused run reads nothing. */
function counting(logs: LogStore): { logs: LogStore; reads: () => number } {
  let n = 0;
  const proxy = new Proxy(logs, {
    get(target, key) {
      const v = Reflect.get(target, key, target) as unknown;
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        n += 1;
        return (v as (...x: unknown[]) => unknown).apply(target, a);
      };
    },
  });
  return { reads: () => n, logs: proxy };
}

describe('the dump command over the stores (BE-089 criteria 3 and 4)', () => {
  async function setUp() {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    await writeWords(p, doc);
    await p.close();
    planes = [];
    const lines: string[] = [];
    const out: string[] = [];
    const audit = new MemoryAudit();
    const c = counting(p.stores.logs);
    const deps = (over: Partial<DumpToolDeps> = {}): DumpToolDeps => ({
      stores: { logs: c.logs, checkpoints: p.checkpoints, audit },
      operator: operatorActor('ops-ana'),
      assignments: parseOperatorAssignments(
        JSON.stringify({ operators: { 'ops-ana': [p.tenant] } }),
      ),
      out: (t) => out.push(t),
      log: createLogger((l) => lines.push(l)),
      now: () => 1_000,
      ...over,
    });
    return { p, doc, lines, out, audit, deps, reads: c.reads };
  }

  it('records the run with the operator and the document, and no log line, audit event or dump holds content', async () => {
    const { p, doc, lines, out, audit, deps } = await setUp();
    const code = await runDumpTool(['dump', '--tenant', p.tenant, '--doc', doc], deps());
    expect(code).toBe(EXIT.ok);

    const events = await audit.query(p.tenant, {
      doc,
      kind: 'document.structural_dump',
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'operator:ops-ana',
      doc,
      tenant: p.tenant,
      at: 1_000,
    });
    noCanary(JSON.stringify(events));

    // Every log line is structured, carries the identifiers, and holds no content.
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.some((l) => JSON.parse(l).event === 'dump.done')).toBe(true);
    noCanary(lines.join('\n'));

    // The dump went to its output, and it holds no text of the source.
    expect(out).toHaveLength(1);
    const dump = JSON.parse(out[0]!) as StructuralDump;
    expect(dump.runs).toBeGreaterThanOrEqual(WORDS.length);
    expect(collectTextRuns(dump.envelope.doc).length).toBeGreaterThan(0);
    noCanary(out[0]!);
  });

  it('refuses a document of a tenant the operator is not assigned to, before reading anything', async () => {
    const { p, doc, lines, out, audit, deps, reads } = await setUp();
    const other = parseOperatorAssignments(
      JSON.stringify({ operators: { 'ops-ana': [randomUUID()], 'ops-ben': [p.tenant] } }),
    );
    const code = await runDumpTool(
      ['dump', '--tenant', p.tenant, '--doc', doc],
      deps({ assignments: other }),
    );
    expect(code).toBe(EXIT.refused);
    expect(reads()).toBe(0);
    expect(out).toEqual([]);
    expect(audit.events).toHaveLength(0);
    expect(lines.map((l) => JSON.parse(l).code)).toContain('not_assigned');
  });

  it('refuses an operator who is not in the assignment file, and a run whose identity cannot be read', async () => {
    const { p, doc, out, audit, deps, reads } = await setUp();
    const argv = ['dump', '--tenant', p.tenant, '--doc', doc];
    expect(await runDumpTool(argv, deps({ operator: operatorActor('ops-unlisted') }))).toBe(
      EXIT.refused,
    );
    expect(await runDumpTool(argv, deps({ operator: null }))).toBe(EXIT.refused);
    expect(reads()).toBe(0);
    expect(out).toEqual([]);
    expect(audit.events).toHaveLength(0);
  });

  it("reads under the tenant it checked: an assigned tenant's name does not reach another tenant's document", async () => {
    const { p, doc, out, audit, deps } = await setUp();
    const mine = randomUUID();
    const assignments = parseOperatorAssignments(
      JSON.stringify({ operators: { 'ops-ana': [mine] } }),
    );
    // The document belongs to p.tenant; named under `mine`, it does not exist.
    const code = await runDumpTool(['dump', '--tenant', mine, '--doc', doc], deps({ assignments }));
    expect(code).toBe(EXIT.failed);
    expect(out).toEqual([]);
    expect(await audit.query(p.tenant, { doc, limit: 10 })).toEqual([]);
  });

  it('refuses a usage error without reading', async () => {
    const { deps, reads, out } = await setUp();
    expect(await runDumpTool(['dump', '--tenant', 't'], deps())).toBe(EXIT.usage);
    expect(await runDumpTool(['other'], deps())).toBe(EXIT.usage);
    expect(reads()).toBe(0);
    expect(out).toEqual([]);
  });
});

describe('the assignment file and the operator identity', () => {
  it('assigns only listed accounts to listed tenants, with no wildcard', () => {
    const a = parseOperatorAssignments(JSON.stringify({ operators: { ana: ['t1'], '*': ['t2'] } }));
    expect(a.isAssigned('t1', 'operator:ana')).toBe(true);
    expect(a.isAssigned('t2', 'operator:ana')).toBe(false);
    expect(a.isAssigned('t1', 'operator:ben')).toBe(false);
    // The actor must carry the operator prefix: a tenant user named "ana" is not the operator.
    expect(a.isAssigned('t1', 'ana')).toBe(false);
  });

  it('refuses a file without the shape as a whole', () => {
    for (const text of [
      'not json',
      '[]',
      '{}',
      '{"operators":[]}',
      '{"operators":{"ana":"t1"}}',
      '{"operators":{"a b":["t1"]}}',
    ])
      expect(() => parseOperatorAssignments(text)).toThrow(AssignmentFileError);
  });

  it('gives no identity for an empty or ambiguous account name', () => {
    expect(operatorActor('ana')).toBe('operator:ana');
    expect(operatorActor('')).toBeNull();
    expect(operatorActor(null)).toBeNull();
    expect(operatorActor('a\nb')).toBeNull();
  });
});

// ---- The command line against PostgreSQL and the S3-compatible store. ----

const S = settings();
const s3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).exists(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`skipped: ${unavailable}`);

const CLI = fileURLToPath(new URL('../../src/data-plane/structural-dump-cli.ts', import.meta.url));
const SERVICE_DIR = fileURLToPath(new URL('../../', import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv['DOCEDIT_S3_ENDPOINT'];
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: SERVICE_DIR, env: childEnv, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe.skipIf(unavailable !== null)(
  'structural-dump-cli.ts against PostgreSQL (BE-089 criteria 3 and 4)',
  () => {
    let db: TestDatabase;
    let dir: string;
    beforeAll(async () => {
      db = await createTestDatabase();
      dir = mkdtempSync(join(tmpdir(), 'docedit-be089-'));
    });
    afterAll(async () => {
      await db?.drop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('dumps as the assigned operator, records the run with the account and the document, and refuses an unassigned tenant', async () => {
      const objects = new ObjectCheckpointStore(new S3ObjectStore(s3Settings));
      const s = pgStores(db.service);
      const p = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        deps: { checkpoints: objects },
      });
      planes.push(p);
      const doc = await p.createDocument();
      const ref = p.ref(doc);
      await objects.put(ref, 0, (await p.checkpoints.get(ref, 0))!);
      await writeWords(p, doc);
      await p.close();
      planes = [];

      const c = db.serviceConfig;
      const env = {
        DOCEDIT_DATABASE_URL: `postgres://${encodeURIComponent(String(c.user))}:${encodeURIComponent(String(c.password))}@${c.host}:${c.port}/${c.database}`,
        DOCEDIT_S3_HOST: S['DOCEDIT_S3_HOST'] ?? '',
        DOCEDIT_S3_PORT: S['DOCEDIT_S3_PORT'] ?? '',
        DOCEDIT_S3_REGION: s3Settings.region,
        DOCEDIT_S3_BUCKET: s3Settings.bucket,
        DOCEDIT_S3_ACCESS_KEY: s3Settings.accessKeyId,
        DOCEDIT_S3_SECRET_KEY: s3Settings.secretAccessKey,
      };
      // The operator is the account that runs the command; the test assigns it to the tenant.
      const me = userInfo().username;
      const assigned = join(dir, 'assigned.json');
      writeFileSync(assigned, JSON.stringify({ operators: { [me]: [p.tenant] } }));
      const elsewhere = join(dir, 'elsewhere.json');
      writeFileSync(elsewhere, JSON.stringify({ operators: { [me]: [randomUUID()] } }));
      const audit = new PgAuditStore(db.service);
      const dumpEvents = () =>
        audit.query(p.tenant, { doc, kind: 'document.structural_dump', limit: 10 });

      // Criterion 4: not assigned, the command refuses, writes no dump and records nothing.
      const refused = await runCli(['dump', '--tenant', p.tenant, '--doc', doc], {
        ...env,
        DOCEDIT_OPERATOR_ASSIGNMENTS: elsewhere,
      });
      expect(refused.code).toBe(EXIT.refused);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('not_assigned');
      expect(await dumpEvents()).toEqual([]);

      // Criterion 3: assigned, the command dumps and the audit trail has the run.
      const ran = await runCli(['dump', '--tenant', p.tenant, '--doc', doc], {
        ...env,
        DOCEDIT_OPERATOR_ASSIGNMENTS: assigned,
      });
      expect(ran.code, ran.stderr).toBe(EXIT.ok);
      const events = await dumpEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor: `operator:${me}`, doc, tenant: p.tenant });
      noCanary(JSON.stringify(events));

      // The log lines (standard error) are structured and hold no content; the dump holds no text.
      const lines = ran.stderr.split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
      noCanary(ran.stderr);
      const dump = JSON.parse(ran.stdout) as StructuralDump;
      expect(dump.runs).toBeGreaterThanOrEqual(WORDS.length);
      noCanary(ran.stdout);
    });
  },
);
