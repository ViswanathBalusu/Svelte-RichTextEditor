/**
 * EXP-026 criterion 3 (export worker, Node.js only, no sandbox): a final export whose text has a
 * character that no font covers fails before the engine starts, and no PDF is stored. The same text
 * in a preview completes, and the miss is a warning. The compile is replaced by a fake that records
 * its calls, so these tests need no Podman. The converter's own check is in
 * packages/export-latex/src/glyphs.missing.test.ts. The compile's `\tracinglostchars` error
 * (criterion 2) and the job passing with fallback faces (criterion 5) need a real compile and are
 * not covered here.
 */
import type { FontManifest } from '@docedit/export-latex';
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, type ExportHandlerDeps } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-glyphs';
/** The paragraph of the demo document whose text this file changes. */
const PARA = 'pEnd000000000001';
/** Cyrillic zhe (U+0416): no face of the test manifest covers it. */
const MISSING = 'Ж';

/**
 * Latin coverage on every text face and on the math face, which is the fallback chain when the
 * manifest names none. The converter checks a run only when every face it may use has coverage.
 */
const LATIN: Array<[number, number]> = [[0x20, 0x7e]];
const withCoverage = <T extends object>(face: T): T => ({ ...face, coverage: LATIN as never });
const COVERED: FontManifest = {
  ...TEST_FONTS,
  families: TEST_FONTS.families.map((f) => ({
    ...f,
    regular: withCoverage(f.regular),
    bold: withCoverage(f.bold),
    italic: withCoverage(f.italic),
    boldItalic: withCoverage(f.boldItalic),
  })),
  math: withCoverage(TEST_FONTS.math),
};

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

/** The demo document with the text of one paragraph replaced. */
function withParagraphText(envelope: CdmEnvelope, id: string, text: string): CdmEnvelope {
  interface Node {
    type?: string;
    attrs?: { id?: string };
    content?: Node[] | Array<{ type: string; text?: string }>;
  }
  const copy = structuredClone(envelope) as unknown as { doc: Node };
  const walk = (n: Node): void => {
    if (n.type === 'paragraph' && n.attrs?.id === id) n.content = [{ type: 'text', text }];
    for (const c of (n.content ?? []) as Node[]) walk(c);
  };
  walk(copy.doc);
  return copy as unknown as CdmEnvelope;
}

function stores(envelope: CdmEnvelope): ContentStores {
  return {
    logs: {
      head: async () => ({ seq: 0, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 0, content: envelope as never }),
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Demo',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

function fakeCompile() {
  let calls = 0;
  const compile = async (
    _files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ): Promise<CompileResult> => {
    calls += 1;
    const n = opts.maxPasses ?? 2;
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: new TextEncoder().encode('%PDF-2.0 test'),
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 1500,
      stdout: new Uint8Array(),
      name: 'docedit-glyph-test',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, count: () => calls };
}

/** Runs one export job of `envelope` through the control plane's runner; returns what was stored. */
async function exportOf(
  envelope: CdmEnvelope,
  options: Record<string, unknown>,
  fonts: FontManifest,
) {
  const stored: string[] = [];
  const probe = fakeCompile();
  const handler = createExportHandler({
    stores: stores(envelope),
    outputs: {
      putExport: async (_t, _j, name) => {
        stored.push(name);
      },
    },
    fonts: async () => fonts,
    imageId: async () => `sha256:${'b'.repeat(64)}`,
    compile: probe.compile,
  } satisfies ExportHandlerDeps);
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w1',
    leaseMs: 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const doc = uuid7();
  const job = await queue.enqueue(tenant, {
    kind: 'export',
    doc,
    createdBy: 'user-1',
    payload: {
      doc,
      target: 'pdf',
      seq: 0,
      incarnation: INCARNATION,
      options,
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
    },
  });
  await runner.runOnce();
  const done = (await queue.get(tenant, job.id)) as JobRecord;
  return { job: done, stored, compiles: probe.count() };
}

/** The diagnostics a job carries, from its failure or its result. */
function diagnosticsOf(
  job: JobRecord,
): Array<{ code: string; severity: string; blockId: string | null }> {
  const fromResult = (job.result as { diagnostics?: unknown } | null)?.diagnostics;
  const fromError = (job.error as { diagnostics?: unknown } | null)?.diagnostics;
  return (
    (fromResult ?? fromError ?? []) as Array<{
      code: string;
      severity: string;
      blockId: string | null;
    }>
  ).filter((d) => d.code === 'glyph_missing');
}

const envelopeWithMissing = withParagraphText(demoDocument().envelope, PARA, `The end ${MISSING}.`);

describe('EXP-026 criterion 3: a final export with a missing glyph fails and releases no PDF', () => {
  it('fails the job before the engine starts, names the block, and stores nothing', async () => {
    const out = await exportOf(envelopeWithMissing, {}, COVERED);
    expect(out.job.state).toBe('failed');
    expect(out.job.error?.code).toBe('unsupported_feature');
    // The compile never ran, so no PDF, layout or log was written.
    expect(out.compiles).toBe(0);
    expect(out.stored).toEqual([]);
    const missing = diagnosticsOf(out.job);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ severity: 'error', blockId: PARA });
  });

  it('completes and stores a PDF when every character is covered (the same job, no miss)', async () => {
    const out = await exportOf(demoDocument().envelope, {}, COVERED);
    expect(out.job.state).toBe('completed');
    expect(out.compiles).toBe(1);
    expect(out.stored).toContain('output.pdf');
  });
});

describe('EXP-026 criterion 4 (worker side): a preview with a missing glyph still completes', () => {
  it('completes with a warning, and stores its PDF', async () => {
    const out = await exportOf(envelopeWithMissing, { profile: 'preview' }, COVERED);
    expect(out.job.state).toBe('completed');
    expect(out.compiles).toBe(1);
    expect(out.stored).toContain('output.pdf');
    const missing = diagnosticsOf(out.job);
    expect(missing.map((d) => d.severity)).toEqual(['warning']);
  });
});
