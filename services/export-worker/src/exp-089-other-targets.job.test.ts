/**
 * EXP-089 criterion 4 (lane w2): an `html` and an `md` job carry the document's classification
 * label as docs/adr/0414-w2-EXP-089-classification-other-targets.md states: a block before and a
 * block after the content (HTML, with a meta element) and a line before and a line after (Markdown).
 * A document without a label has no marking. The jobs run through the control plane's JobRunner
 * and MemoryJobQueue, as in exp-088-md.job.test.ts; no Podman is needed.
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

const INCARNATION = 'inc-w2-exp-089';

function stores(envelope: CdmEnvelope, label: string | null): ContentStores {
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
          label,
        }) as never,
    },
  };
}

async function runJob(target: 'html' | 'md', label: string | null): Promise<string> {
  const stored: Array<{ bytes: Uint8Array }> = [];
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(demoDocument().envelope, label),
        outputs: {
          putExport: async (_t, _j, _name, bytes) => {
            stored.push({ bytes });
          },
        },
        fonts: async () => TEST_FONTS,
        compile: async () => {
          throw new Error('this job must not compile');
        },
        imageId: async () => null,
      }),
    },
    worker: 'w-w2-089',
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
    },
  });
  await runner.runOnce();
  const job: JobRecord = (await queue.get(tenant, queued.id))!;
  expect(job.state, JSON.stringify(job.error)).toBe('completed');
  return new TextDecoder().decode(stored[0]!.bytes);
}

describe('EXP-089 criterion 4: the other targets carry the label', () => {
  it('writes the label before and after the content of an html job, escaped', async () => {
    const html = await runJob('html', 'Internal <&> "restricted"');
    const escaped = 'Internal &lt;&amp;&gt; &quot;restricted&quot;';
    expect(html).toContain(`<meta name="classification" content="${escaped}">`);
    expect(html).toContain(`<header class="de-classification">${escaped}</header>`);
    expect(html).toContain(`<footer class="de-classification">${escaped}</footer>`);
    expect(html.indexOf('<header class="de-classification">')).toBeLessThan(html.indexOf('<main>'));
    expect(html.indexOf('<footer class="de-classification">')).toBeGreaterThan(
      html.indexOf('</main>'),
    );
  });

  it('writes no marking in an html job of a document without a label', async () => {
    const html = await runJob('html', null);
    expect(html).not.toContain('classification');
  });

  it('writes the label as the first and the last line of an md job, escaped', async () => {
    const md = await runJob('md', 'Internal_restricted *50*');
    const lines = md.trimEnd().split('\n');
    expect(lines[0]).toBe('**Internal\\_restricted \\*50\\***');
    expect(lines[lines.length - 1]).toBe('**Internal\\_restricted \\*50\\***');
  });

  it('writes no marking in an md job of a document without a label', async () => {
    const md = await runJob('md', null);
    expect(md).not.toMatch(/^\*\*Internal/m);
    const withLabel = await runJob('md', 'Secret');
    expect(withLabel.split('\n').filter((l) => l === '**Secret**')).toHaveLength(2);
    expect(md.split('\n').filter((l) => l === '**Secret**')).toHaveLength(0);
  });
});
