/**
 * EXP-087 criterion 6 (lane w2): an `html` job delivers its pictures with the page. The control
 * plane names the ready assets of the document in the payload; the worker reads each by hash,
 * checks the hash, and stores one archive, `output.tar`, holding `index.html` and the files its
 * `img` elements name under `assets/`. With no picture the output is `output.html` as before. No
 * Podman: the job runs through the JobRunner and MemoryJobQueue.
 */
import { createHash } from 'node:crypto';
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
import { createExportHandler, HTML_ARCHIVE_FILE, HTML_OUTPUT_FILE } from './job.ts';

const INCARNATION = 'inc-w2-exp-087-pictures';
const ASSET = 'aPICTURE00000001';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const HASH = createHash('sha256').update(PNG).digest('hex');

type Node = { type?: string; content?: unknown[]; attrs?: Record<string, unknown> };

/** The demonstration document with one picture at the end of its first paragraph. */
function withPicture(): CdmEnvelope {
  const envelope = structuredClone(demoDocument().envelope);
  const body = (envelope.doc as Node).content!.find((c) => (c as Node).type === 'body') as Node;
  const first = body.content!.find((c) => (c as Node).type === 'paragraph') as Node;
  first.content = [
    ...(first.content ?? []),
    { type: 'image', attrs: { id: 'iPICTURE00000001', asset: ASSET, alt: 'A small test picture' } },
  ];
  return envelope;
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

async function runJob(
  payload: Record<string, unknown>,
  assetBytes?: (tenant: string, sha256: string) => Promise<Uint8Array | null>,
) {
  const stored: Array<{ name: string; bytes: Uint8Array; type: string }> = [];
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(withPicture()),
        outputs: {
          putExport: async (_t, _j, name, bytes, type) => {
            stored.push({ name, bytes, type });
          },
        },
        fonts: async () => TEST_FONTS,
        compile: async () => {
          throw new Error('an html job must not compile');
        },
        imageId: async () => null,
        ...(assetBytes ? { assetBytes } : {}),
      }),
    },
    worker: 'w-w2-087p',
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
      target: 'html',
      seq: 0,
      incarnation: INCARNATION,
      options: {},
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
      ...payload,
    },
  });
  await runner.runOnce();
  const job: JobRecord = (await queue.get(tenant, queued.id))!;
  return { job, stored };
}

/** The member names and bodies of a ustar archive. */
function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let at = 0; at + 512 <= bytes.length;) {
    if (bytes.subarray(at, at + 512).every((b) => b === 0)) break;
    const name = dec.decode(bytes.subarray(at, at + 100)).replace(/\0.*$/s, '');
    const size = parseInt(dec.decode(bytes.subarray(at + 124, at + 136)).replace(/\0.*$/s, ''), 8);
    at += 512;
    out.set(name, bytes.subarray(at, at + size));
    at += Math.ceil(size / 512) * 512;
  }
  return out;
}

const assets = { [ASSET]: { sha256: HASH, mediaType: 'image/png' } };
const codes = (job: JobRecord) =>
  ((job.result as { diagnostics?: Array<{ code: string }> }).diagnostics ?? []).map((d) => d.code);

describe('EXP-087 criterion 6: pictures travel with the HTML', () => {
  it('stores one archive of index.html and the picture, which the img element names', async () => {
    const read: Array<[string, string]> = [];
    const run = await runJob({ assets }, async (tenant, sha) => {
      read.push([tenant, sha]);
      return PNG;
    });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.stored.map((s) => s.name)).toEqual([HTML_ARCHIVE_FILE]);
    expect(run.stored[0]!.type).toBe('application/x-tar');
    expect((run.job.result as { output: string }).output).toBe(HTML_ARCHIVE_FILE);
    expect(read.map((r) => r[1])).toEqual([HASH]);
    const files = readTar(run.stored[0]!.bytes);
    expect([...files.keys()].sort()).toEqual(['assets/aPICTURE00000001.png', 'index.html']);
    expect([...files.get('assets/aPICTURE00000001.png')!]).toEqual([...PNG]);
    const html = new TextDecoder().decode(files.get('index.html')!);
    expect(html).toContain('<img src="assets/aPICTURE00000001.png" alt="A small test picture">');
    expect(codes(run.job)).not.toContain('image_asset_missing');
  });

  it('stores the page alone, and names the missing picture, when the worker cannot read it', async () => {
    for (const bytes of [undefined, async () => null, async () => new Uint8Array([9, 9, 9])]) {
      const run = await runJob({ assets }, bytes);
      expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
      expect(run.stored.map((s) => s.name)).toEqual([HTML_OUTPUT_FILE]);
      const html = new TextDecoder().decode(run.stored[0]!.bytes);
      expect(html).not.toContain('<img');
      expect(html).toContain('A small test picture');
      expect(codes(run.job)).toContain('image_asset_missing');
    }
  });

  it('does not read a type a page cannot show, and refuses a payload of the wrong shape', async () => {
    let reads = 0;
    const pdf = { [ASSET]: { sha256: HASH, mediaType: 'application/pdf' } };
    const run = await runJob({ assets: pdf }, async () => {
      reads++;
      return PNG;
    });
    expect(reads).toBe(0);
    expect(run.stored.map((s) => s.name)).toEqual([HTML_OUTPUT_FILE]);
    const bad = await runJob({ assets: { [ASSET]: { sha256: 'nope', mediaType: 'image/png' } } });
    expect(bad.job.state).toBe('failed');
  });
});
