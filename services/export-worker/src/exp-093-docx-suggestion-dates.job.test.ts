/**
 * EXP-093 criterion 2, the worker half (lane w2): a `docx` job with `suggestions: markup` writes the
 * date of each tracked change from the commit time that the control plane put in the job payload
 * (`suggestionDates`), and from nothing else. A suggestion with no entry gets no date, and a payload
 * that is not the shape the control plane writes fails the job. Same harness as
 * exp-090-docx.job.test.ts; no Podman.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { entryData, readZip } from '@docedit/export-docx';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';

const INCARNATION = 'inc-w2-exp-093';
const INS = 'insSuggestion001';
const DEL = 'delSuggestion002';
const INS_TIME = '2026-11-01T10:00:00.000Z';
const DEL_TIME = '2026-11-02T11:30:15.250Z';

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

/** The demonstration document with one inserted and one deleted run at the end of the body. */
function withSuggestions(): CdmEnvelope {
  const env = structuredClone(demoDocument().envelope) as unknown as {
    doc: { content: Array<{ type: string; content?: unknown[] }> };
  };
  const body = env.doc.content.find((n) => n.type === 'body')!;
  body.content!.push({
    type: 'paragraph',
    attrs: { id: 'pSuggestAAAAAAA1' },
    content: [
      {
        type: 'text',
        text: 'added words',
        marks: [{ type: 'ins', attrs: { id: INS, user: 'user-0001' } }],
      },
      {
        type: 'text',
        text: 'removed words',
        marks: [{ type: 'del', attrs: { id: DEL, user: 'user-0002' } }],
      },
    ],
  });
  return env as unknown as CdmEnvelope;
}

async function runJob(payload: Record<string, unknown>): Promise<{
  job: JobRecord;
  xml: string | null;
}> {
  const stored: Uint8Array[] = [];
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(withSuggestions()),
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
      }),
    },
    worker: 'w-w2-093',
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
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
      ...payload,
    },
  });
  await runner.runOnce();
  const job = (await queue.get(tenant, queued.id))!;
  const bytes = stored[0];
  if (!bytes) return { job, xml: null };
  const zip = readZip(bytes);
  const xml = new TextDecoder().decode(
    entryData(
      zip,
      zip.entries.find((e) => e.name === 'word/document.xml')!,
    ),
  );
  return { job, xml };
}

/** The `w:date` of the tracked change that wraps `text`. */
function dateOf(xml: string, element: 'ins' | 'del', text: string): string | null {
  const re = new RegExp(`<w:${element}\\b([^>]*)>(?:(?!</w:${element}>).)*${text}`, 's');
  const m = re.exec(xml);
  if (!m) throw new Error(`no w:${element} around ${text}`);
  return /w:date="([^"]*)"/.exec(m[1]!)?.[1] ?? null;
}

describe('EXP-093 criterion 2: the date of a tracked change is the commit time', () => {
  it('writes each w:date from the time the job carries for that suggestion', async () => {
    const run = await runJob({ suggestionDates: { [INS]: INS_TIME, [DEL]: DEL_TIME } });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(dateOf(run.xml!, 'ins', 'added words')).toBe(INS_TIME);
    expect(dateOf(run.xml!, 'del', 'removed words')).toBe(DEL_TIME);
  });

  it('writes no date for a suggestion the job has no time for, and never the job time', async () => {
    const run = await runJob({ suggestionDates: { [INS]: INS_TIME } });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(dateOf(run.xml!, 'ins', 'added words')).toBe(INS_TIME);
    expect(dateOf(run.xml!, 'del', 'removed words')).toBeNull();
    const none = await runJob({});
    expect(dateOf(none.xml!, 'ins', 'added words')).toBeNull();
  });

  it('fails the job when the dates are not the shape the control plane writes', async () => {
    for (const bad of [
      { [INS]: 'yesterday' },
      { [INS]: 7 },
      [INS_TIME],
      { [INS]: '2026-11-01T10:00:00Z<w:x/>' },
    ]) {
      const run = await runJob({ suggestionDates: bad });
      expect(run.job.state).toBe('failed');
      expect(run.xml).toBeNull();
    }
  });
});
