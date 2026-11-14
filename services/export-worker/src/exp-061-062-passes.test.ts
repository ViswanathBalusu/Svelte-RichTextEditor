/**
 * The pass plan of an export job and what each compile receives (09 §8, §9.1; EXP-061 criteria 2
 * and 3; EXP-062 criterion 1). The compile is a stand-in, so these tests need no Podman; the
 * compile script itself is run only by compile.e2e.test.ts.
 */
import fc from 'fast-check';
import type { JobContext, JobRecord } from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, OUTPUT_FILES, type ExportHandlerDeps } from './job.ts';
import { planJob } from './profile.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-pass-1';
const CREATED = 1_700_000_000_000;
const TENANT = uuid7();
const DOC = uuid7();
const BUNDLE_FILES = [
  'docedit.cls',
  'docedit.lua',
  'main.tex',
  'manifest.json',
  'map.json',
  'styles.tex',
];
/** Names an earlier TeX run leaves behind; none may reach a later job's compile (EXP-061 criterion 3). */
const AUXILIARY = /\.(aux|toc|out|lof|lot|bbl|idx|ind|nav|snm|vrb|fls|fdb_latexmk)$/;

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

type Files = Readonly<Record<string, string | Uint8Array>>;

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

/** A compile that records what it was given and reports the passes the options allow. */
function recordingCompile(over: Partial<CompileResult> = {}) {
  const calls: Array<{ files: Files; opts: SandboxOptions }> = [];
  const compile = async (files: Files, opts: SandboxOptions): Promise<CompileResult> => {
    calls.push({ files: { ...files }, opts });
    const n = opts.maxPasses ?? 1;
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: new TextEncoder().encode('%PDF-2.0 pass plan'),
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 900,
      stdout: new Uint8Array(),
      name: 'docedit-pass-plan',
      limits: { ...LIMITS, ...opts.limits },
      passTimeoutSeconds: 110,
      ...over,
    };
  };
  return { compile, calls };
}

/** One export job, run through the handler with a stand-in context. */
function makeRunner(compile: NonNullable<ExportHandlerDeps['compile']>) {
  const stored: Array<{ name: string; bytes: Uint8Array }> = [];
  const handler = createExportHandler({
    stores: stores(demoDocument().envelope),
    outputs: {
      putExport: async (_t, _j, name, bytes) => {
        stored.push({ name, bytes });
      },
    },
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'c'.repeat(64)}`,
    sealKey: new Uint8Array(32).fill(9),
    compile,
  });
  let n = 0;
  const run = async (options: Record<string, unknown>) => {
    n += 1;
    const id = uuid7();
    const job = {
      id,
      tenant: TENANT,
      doc: DOC,
      kind: 'export',
      state: 'running',
      createdAt: CREATED + n,
      payload: {
        doc: DOC,
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
    } as unknown as JobRecord;
    const ctx = {
      report: async () => ({}) as never,
      signal: new AbortController().signal,
    } as JobContext;
    return handler(job, ctx);
  };
  return { run, stored };
}

const manifestOf = (stored: Array<{ name: string; bytes: Uint8Array }>) => {
  const m = stored.find((s) => s.name === OUTPUT_FILES.manifest);
  return JSON.parse(new TextDecoder().decode(m!.bytes)) as Record<string, unknown>;
};

describe('pass plan of an export job (EXP-062 criterion 1)', () => {
  it('plans one pass for every preview and two to four passes for every final export, whatever the tagging', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('final', 'preview', undefined),
        fc.constantFrom('on', 'draft', 'off', undefined),
        (profile, tagging) => {
          const options = {
            ...(profile === undefined ? {} : { profile }),
            ...(tagging === undefined ? {} : { tagging }),
          };
          const r = planJob(options, 'en-GB');
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          const p = r.plan;
          if (p.profile === 'preview') {
            expect(p.minPasses).toBe(1);
            expect(p.maxPasses).toBe(1);
            // A preview defaults to tagging off; a requested draft or off is kept as asked.
            expect(p.tagging).toBe(tagging ?? 'off');
          } else {
            expect(p.minPasses).toBe(2);
            expect(p.maxPasses).toBe(4);
            expect(p.tagging).toBe(tagging ?? 'on');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses every profile name that is neither preview nor final, so no pass plan is guessed', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== 'final' && s !== 'preview'),
        (profile) => {
          const r = planJob({ profile }, 'en-GB');
          expect(r.ok).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('compiles a draft-tagged preview in one pass and reports it as not converged', async () => {
    const { compile, calls } = recordingCompile({ converged: false });
    const { run, stored } = makeRunner(compile);
    const job = await run({ profile: 'preview', tagging: 'draft' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toMatchObject({ minPasses: 1, maxPasses: 1 });
    expect(String(calls[0]!.files['main.tex'])).toMatch(/tagging=draft/);
    expect(job.converged).toBe(false);
    expect(manifestOf(stored)).toMatchObject({
      profile: 'preview',
      tagging: 'draft',
      converged: false,
    });
  });
});

describe('what a final export records and what each compile receives (EXP-061 criteria 2 and 3)', () => {
  it('records in the result and in the manifest the passes run and whether references converged', async () => {
    // Two passes: the second left the auxiliary files unchanged, so the references converged.
    const { compile } = recordingCompile({
      converged: true,
      passes: [1, 2].map((pass) => ({ pass, rc: 0, ms: 100 })),
    });
    const { run, stored } = makeRunner(compile);
    const converged = await run({ profile: 'final' });
    expect(converged.converged).toBe(true);
    const m = manifestOf(stored);
    expect(m).toMatchObject({ profile: 'final', converged: true });
    expect((m['passes'] as unknown[]).length).toBe(2);
  });

  it('records a final export whose references did not converge, and delivers it flagged', async () => {
    // The compile reached the pass cap of 4 with the auxiliary files still changing.
    const { compile } = recordingCompile({
      converged: false,
      passes: [1, 2, 3, 4].map((pass) => ({ pass, rc: 0, ms: 100 })),
    });
    const { run, stored } = makeRunner(compile);
    const job = await run({ profile: 'final' });
    expect(job.converged).toBe(false);
    expect((job.diagnostics as Array<{ code: string }>).map((d) => d.code)).toContain(
      'references_not_converged',
    );
    expect(manifestOf(stored)).toMatchObject({ converged: false });
    expect((manifestOf(stored)['passes'] as unknown[]).length).toBe(4);
  });

  it('gives each job only its own bundle: no auxiliary file of an earlier job reaches a later compile', async () => {
    const { compile, calls } = recordingCompile({ converged: true });
    const { run } = makeRunner(compile);
    await run({ profile: 'final' });
    await run({ profile: 'preview' });
    await run({ profile: 'final', tagging: 'draft' });
    await run({ profile: 'final' });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      const names = Object.keys(c.files).sort();
      // The compile input is the bundle of the converter and the bundle's assets, nothing else.
      expect(names.filter((n) => BUNDLE_FILES.includes(n))).toEqual(BUNDLE_FILES);
      expect(names.filter((n) => AUXILIARY.test(n))).toEqual([]);
    }
    // Two final jobs of the same document send the same bundle bytes (no state carried between).
    expect(calls[3]!.files['main.tex']).toBe(calls[0]!.files['main.tex']);
    expect(calls[3]!.files['styles.tex']).toBe(calls[0]!.files['styles.tex']);
  });
});
