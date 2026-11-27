/**
 * EXP-123 criterion 3 and EXP-090 criterion 5, the worker's part: a `docx` job for a document
 * imported from Word patches the original package only for a full export. Every other job writes the
 * package from the CDM, and the original, its source map and its fragments are not even read.
 *
 * The document is a real Word file of the SPK-028 corpus (`packages/export-docx/corpus/word`, made
 * by Microsoft Word 16: citations and sources), imported by the real importer; its original, source
 * map and fragments are the assets the import made. The job runs through the control plane's
 * JobRunner and MemoryJobQueue as in exp-090-docx.job.test.ts; no Podman is needed.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { entryData, importDocx, readZip } from '@docedit/export-docx';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, DOCX_OUTPUT_FILE } from './job.ts';

const INCARNATION = 'inc-w2-exp-123-original';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const hash = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const CORPUS = new URL(
  '../../../packages/export-docx/corpus/word/citations-rich.docx',
  import.meta.url,
);

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
          title: 'Imported',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

/** The import of the Word file, with the assets a job would be given by hash. */
async function imported() {
  const original = new Uint8Array(readFileSync(CORPUS));
  const r = await importDocx(original);
  const bytes = new Map<string, Uint8Array>();
  const ref = (b: Uint8Array, mediaType: string) => {
    const sha256 = hash(b);
    bytes.set(sha256, b);
    return { sha256, mediaType };
  };
  const preservation = {
    original: ref(original, DOCX_TYPE),
    sourceMap: ref(
      r.assets.get(r.sourceMapAsset)!.bytes,
      r.assets.get(r.sourceMapAsset)!.contentType,
    ),
    fragments: Object.fromEntries(
      r.assets.ofRole('fragment').map((a) => [a.id, ref(a.bytes, a.contentType)]),
    ),
  };
  return { original, envelope: r.envelope as unknown as CdmEnvelope, bytes, preservation };
}

async function runJob(
  envelope: CdmEnvelope,
  assets: Map<string, Uint8Array>,
  payload: Record<string, unknown>,
): Promise<{ job: JobRecord; stored: Uint8Array[]; read: string[] }> {
  const stored: Uint8Array[] = [];
  const read: string[] = [];
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(envelope),
        outputs: {
          putExport: async (_t, _j, _name, bytes) => {
            stored.push(bytes);
          },
        },
        fonts: async () => TEST_FONTS,
        compile: async () => {
          throw new Error('a docx job must not compile');
        },
        imageId: async () => null,
        assetBytes: async (_t, sha256) => {
          read.push(sha256);
          return assets.get(sha256) ?? null;
        },
      }),
    },
    worker: 'w-w2-123',
    leaseMs: 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const doc = uuid7();
  const queued = await queue.enqueue(tenant, {
    kind: 'export',
    doc,
    createdBy: 'user-1',
    payload: {
      doc,
      target: 'docx',
      seq: 0,
      incarnation: INCARNATION,
      options: { suggestions: 'markup' },
      requester: 'user-1',
      role: 'owner',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
      ...payload,
    },
  });
  await runner.runOnce();
  return { job: (await queue.get(tenant, queued.id))!, stored, read };
}

const documentXml = (bytes: Uint8Array): string => {
  const zip = readZip(bytes);
  return new TextDecoder().decode(
    entryData(
      zip,
      zip.entries.find((e) => e.name === 'word/document.xml')!,
    ),
  );
};

describe('EXP-123 criterion 3: the original is patched only for a full export', () => {
  it('writes an unedited imported document back as the original, for a full export', async () => {
    const i = await imported();
    const run = await runJob(i.envelope, i.bytes, { full: true, preservation: i.preservation });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.job.result).toMatchObject({ output: DOCX_OUTPUT_FILE });
    // Patched, not written again: every byte of the original package comes back (R0 of ADR 0017).
    expect(run.stored[0]).toEqual(i.original);
    const diagnostics = (run.job.result as { diagnostics: Array<{ message: string }> }).diagnostics;
    expect(diagnostics.filter((d) => d.message.includes('original'))).toEqual([]);
  });

  it('keeps what the model does not hold when the full export of an edited document is patched', async () => {
    const i = await imported();
    const env = structuredClone(i.envelope) as unknown as {
      doc: {
        content: Array<{ type: string; content?: Array<{ type: string; content?: unknown[] }> }>;
      };
    };
    const body = env.doc.content.find((n) => n.type === 'body')!;
    const paragraph = body.content!.find((n) => n.type === 'paragraph')!;
    paragraph.content!.unshift({ type: 'text', text: 'Edited. ' } as never);
    const run = await runJob(env as unknown as CdmEnvelope, i.bytes, {
      full: true,
      preservation: i.preservation,
    });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    const xml = documentXml(run.stored[0]!);
    expect(xml).toContain('Edited. ');
    // Word's own revision identifiers and the original controls of the citations survive.
    expect(xml).toContain('w:rsidR=');
    expect(xml).toContain('CITATION Ito21');
  });

  it('writes a requester who may not read everything from the CDM, and reads no original', async () => {
    const i = await imported();
    // Even a payload that names the original (it must not) is not patched: `full` is false.
    const run = await runJob(i.envelope, i.bytes, { full: false, preservation: i.preservation });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.stored[0]).not.toEqual(i.original);
    expect(documentXml(run.stored[0]!)).not.toContain('w:rsidR=');
    expect(run.read).toEqual([]);
    // What the requester may read is all there, written by the direct writer.
    expect(documentXml(run.stored[0]!)).toContain('<w:citation/>');
  });

  it('does not patch when something is hidden from the requester, whatever `full` says', async () => {
    const i = await imported();
    const run = await runJob(i.envelope, i.bytes, {
      full: true,
      hiddenValues: ['someValue'],
      preservation: i.preservation,
    });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.stored[0]).not.toEqual(i.original);
    expect(run.read).toEqual([]);
  });

  it('writes from the document and says so when the original cannot be read', async () => {
    const i = await imported();
    const run = await runJob(i.envelope, new Map(), { full: true, preservation: i.preservation });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.stored[0]).not.toEqual(i.original);
    const diagnostics = (
      run.job.result as { diagnostics: Array<{ code: string; message: string }> }
    ).diagnostics;
    expect(
      diagnostics.some(
        (d) => d.code === 'docx_approximation' && d.message.includes('could not be read'),
      ),
    ).toBe(true);
  });
});
