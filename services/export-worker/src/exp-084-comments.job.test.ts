/**
 * EXP-084 through the export worker (lane w2): a `tex` job with `comments: margin` writes the
 * threads the control plane put in the payload into `main.tex`, as margin notes, with the text
 * escaped; `none` writes none; a payload that is not the shape the control plane writes fails the
 * job; and an `md` job refuses the option. No compile and no Podman: the bundle is the output.
 */
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
import { createExportHandler } from './job.ts';

const INCARNATION = 'inc-w2-exp-084';

type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[] };

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

/** The identifier of the first paragraph in the body of the demonstration document. */
function firstParagraph(envelope: CdmEnvelope): string {
  const body = (envelope.doc as Node).content!.find((c) => c.type === 'body')!;
  return String(body.content!.find((c) => c.type === 'paragraph')!.attrs!['id']);
}

async function runJob(target: string, payload: Record<string, unknown>) {
  const envelope = demoDocument().envelope;
  const stored: Array<{ name: string; bytes: Uint8Array }> = [];
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(envelope),
        outputs: {
          putExport: async (_t, _j, name, bytes) => {
            stored.push({ name, bytes });
          },
        },
        fonts: async () => TEST_FONTS,
        compile: async () => {
          throw new Error('a tex job must not compile');
        },
        imageId: async () => null,
      }),
    },
    worker: 'w-w2-084',
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
      target,
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
  return { job, stored, block: firstParagraph(envelope) };
}

/** The `main.tex` of a ustar archive. */
function mainTex(bytes: Uint8Array): string {
  const dec = new TextDecoder();
  for (let at = 0; at + 512 <= bytes.length;) {
    const name = dec.decode(bytes.subarray(at, at + 100)).replace(/\0.*$/s, '');
    const size = parseInt(dec.decode(bytes.subarray(at + 124, at + 136)).replace(/\0.*$/s, ''), 8);
    at += 512;
    if (name === 'main.tex') return dec.decode(bytes.subarray(at, at + size));
    at += Math.ceil(size / 512) * 512;
  }
  return '';
}

const threadFor = (block: string) => ({
  id: 't-1',
  block,
  quote: 'the words',
  messages: [{ author: 'Ada Lovelace', text: 'Check 100% of this \\input{x}.' }],
});

describe('EXP-084 margin comments through the export worker', () => {
  it('writes the threads of the payload as margin notes, escaped', async () => {
    const probe = await runJob('tex', {});
    const block = probe.block;
    const run = await runJob('tex', {
      options: { comments: 'margin' },
      commentThreads: [threadFor(block)],
    });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    const tex = mainTex(run.stored[0]!.bytes);
    expect(tex).toContain('\\DEmargin{');
    expect(tex).toContain('\\DEnote{Ada Lovelace}{Check 100\\% of this');
    expect(tex).not.toContain('\\input{x}');
  });

  it('writes none with `none`, and fails a payload of the wrong shape', async () => {
    const block = (await runJob('tex', {})).block;
    const none = await runJob('tex', {
      options: { comments: 'none' },
      commentThreads: [threadFor(block)],
    });
    expect(mainTex(none.stored[0]!.bytes)).not.toContain('DEmargin');
    const bad = await runJob('tex', {
      options: { comments: 'margin' },
      commentThreads: [{ id: 1, block, messages: 'no' }],
    });
    expect(bad.job.state).toBe('failed');
  });

  it('refuses `margin` for an md job, which has no margin', async () => {
    const run = await runJob('md', { options: { comments: 'margin' } });
    expect(run.job.state).toBe('failed');
    expect(run.job.error).toMatchObject({ code: 'validation_failed' });
  });
});
