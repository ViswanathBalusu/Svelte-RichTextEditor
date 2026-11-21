/**
 * EXP-008 criteria 2 and 3 through the control plane (Node.js; no Podman): previews asked for over
 * `POST /v1/documents/{id}/exports`, queued by the real route, taken by the export worker from the
 * service's own queue and converted by the real converter. Only the sandbox is a stand-in, which
 * counts its calls, so the test can say whether a compile ran.
 *
 * Criterion 3: the document changes and its bundle does not (two characters typed and deleted
 * again), a preview is asked for, and the job ends `completed` with the first preview's files and
 * no compile. Criterion 2: the second preview starts at least a preview window after the first.
 * The window is set to 300 ms here; the default is the ten seconds of 06 §10.
 */
import type { StoredCommit } from '@docedit/authority';
import { objectKeys, type DocRef, type JobRecord } from '@docedit/document-service';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREVIEW_KEY_MEMBER } from '../src/preview-reuse.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from '../src/sandbox.ts';
import { createExportWorker, type ExportWorker } from '../src/worker.ts';
import { demoDocument } from './documents.ts';
import { TEST_FONTS } from './fonts.ts';
import { startTestService, type TestService } from './service.ts';

const WINDOW_MS = 300;
const END_PARAGRAPH = 'pEnd000000000001';

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

/** The position just inside the last paragraph of the demonstration document. */
function endPosition(): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(demoDocument().envelope.doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === END_PARAGRAPH) at = pos + 1;
      return at < 0;
    });
  return at;
}

describe('EXP-008 a preview of an unchanged bundle, through the control plane', () => {
  let t: TestService;
  let worker: ExportWorker;
  /** The `main.tex` of every bundle that went into the sandbox stand-in. */
  const compiled: string[] = [];

  beforeAll(async () => {
    t = await startTestService({ config: { previewWindowMs: WINDOW_MS } });
    worker = createExportWorker({
      queue: t.service.parts.queue,
      deps: {
        stores: {
          logs: t.service.parts.logs,
          checkpoints: t.service.checkpoints,
          documents: t.service.parts.documents,
        },
        outputs: t.service.assets,
        fonts: async () => TEST_FONTS,
        imageId: async () => `sha256:${'b'.repeat(64)}`,
        compile: async (
          files: Readonly<Record<string, string | Uint8Array>>,
          opts: SandboxOptions,
        ): Promise<CompileResult> => {
          compiled.push(String(files['main.tex']));
          const n = opts.maxPasses ?? 1;
          return {
            ok: true,
            exitCode: 0,
            timedOut: false,
            outputOverflow: false,
            cancelled: false,
            passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 5 })),
            converged: n > 1,
            pdf: new TextEncoder().encode('%PDF-2.0 test'),
            log: 'This is LuaHBTeX\n',
            layoutRaw: RAW_LAYOUT,
            stderr: '',
            wallMs: 10,
            stdout: new Uint8Array(),
            name: 'docedit-exp-008-route',
            limits: { ...LIMITS },
            passTimeoutSeconds: 110,
          };
        },
      },
      worker: 'export-exp-008',
      leaseMs: 3000,
      idleMs: 20,
      retryAfterMs: 1000,
    });
    worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await t?.close();
  });

  /** Appends one commit to the document's log, as the data plane's commit path does. */
  async function commit(doc: string, step: Record<string, unknown>): Promise<number> {
    const ref: DocRef = { tenant: t.tenant, doc };
    const parts = t.service.parts;
    const epoch = await parts.ownership.claim(ref, 'test-node');
    const head = await parts.logs.head(ref);
    const perms = await parts.grants.current(ref);
    const stored: StoredCommit = {
      seq: head.seq + 1,
      id: uuid7(),
      kind: 'steps',
      steps: [step] as StoredCommit['steps'],
      user: 'editor',
      session: 'session-exp-008',
      time: Date.now(),
      origin: 'input',
      scopes: ['body'],
      revision: perms.revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [],
      claimed: [],
    };
    const appended = await parts.logs.append(ref, {
      epoch,
      revision: perms.revision,
      fromSeq: head.seq + 1,
      commits: [stored],
    });
    expect(appended.status).toBe('ok');
    return head.seq + 1;
  }

  const typeAtEnd = (doc: string, text: string) =>
    commit(doc, {
      stepType: 'replace',
      from: endPosition(),
      to: endPosition(),
      slice: { content: [{ type: 'text', text }] },
    });
  const deleteAtEnd = (doc: string, length: number) =>
    commit(doc, { stepType: 'replace', from: endPosition(), to: endPosition() + length });

  /** Asks for a preview and waits for its job to end. */
  async function preview(doc: string, token: string) {
    const created = await t.call('POST', `/v1/documents/${doc}/exports`, {
      token,
      body: { target: 'pdf', options: { profile: 'preview' } },
    });
    expect(created.status, created.text).toBe(202);
    const id = created.json.id as string;
    for (let i = 0; i < 600; i++) {
      const r = await t.call('GET', `/v1/exports/${id}`, { token });
      if (['completed', 'failed', 'cancelled'].includes(r.json?.state)) {
        const record = (await t.service.parts.queue.get(t.tenant, id)) as JobRecord;
        return { id, created: created.json, api: r.json, record };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`preview ${id} did not end`);
  }

  /** The path of a job's PDF as it appears in a signed URL. */
  const pdfPath = (job: string) =>
    objectKeys.exportFile(t.tenant, job, 'output.pdf').split('/').map(encodeURIComponent).join('/');

  it('answers a preview with the earlier files and no compile when the bundle is unchanged (criterion 3), a window after the first start (criterion 2)', async () => {
    const doc = await t.createDocument(demoDocument().envelope);
    const editor = t.userToken({ [doc]: 'editor' });

    const first = await preview(doc, editor);
    expect(first.api.state, JSON.stringify(first.api.error ?? first.api.diagnostics)).toBe(
      'completed',
    );
    expect(first.api.seq).toBe(0);
    expect(compiled).toHaveLength(1);
    expect(first.api.result.url).toContain(pdfPath(first.id));

    // The document changes twice and prints as before: two characters typed, then deleted.
    expect(await typeAtEnd(doc, 'hi')).toBe(1);
    expect(await deleteAtEnd(doc, 2)).toBe(2);

    const second = await preview(doc, editor);
    // Another request for the control plane (another seq), so a job of its own was queued.
    expect(second.id).not.toBe(first.id);
    expect(second.created.state).toBe('queued');
    expect(second.api.state, JSON.stringify(second.api.error ?? second.api.diagnostics)).toBe(
      'completed',
    );
    expect(second.api.seq).toBe(2);
    // No compile ran, and the result is the first preview's: its files, its page count.
    expect(compiled).toHaveLength(1);
    expect(second.api.result.url).toContain(pdfPath(first.id));
    expect(second.api.result.url).not.toContain(pdfPath(second.id));
    expect(second.api.result.pages).toBe(first.api.result.pages);
    expect(second.api.result.layout).toContain(encodeURIComponent(first.id));
    expect(second.api.diagnostics).toEqual(first.api.diagnostics);
    expect(second.record.result?.['from']).toBe(first.id);
    expect(second.record.result?.[PREVIEW_KEY_MEMBER]).toBe(
      first.record.result?.[PREVIEW_KEY_MEMBER],
    );
    // The second preview started at least a window after the first (the queue's start gap).
    expect(second.record.startGapMs).toBe(WINDOW_MS);
    expect(second.record.startedAt! - first.record.startedAt!).toBeGreaterThanOrEqual(WINDOW_MS);

    // The control: a change that prints is compiled, and its result is its own.
    expect(await typeAtEnd(doc, 'More. ')).toBe(3);
    const third = await preview(doc, editor);
    expect(third.api.state, JSON.stringify(third.api.error ?? third.api.diagnostics)).toBe(
      'completed',
    );
    expect(compiled).toHaveLength(2);
    expect(compiled[1]).toContain('More. The end of the document.');
    expect(compiled[0]).not.toContain('More.');
    expect(third.api.result.url).toContain(pdfPath(third.id));
    expect(third.record.result?.['from']).toBeUndefined();
    expect(third.record.startedAt! - second.record.startedAt!).toBeGreaterThanOrEqual(WINDOW_MS);

    // The change is undone: the bundle is the first preview's again, two previews later.
    expect(await deleteAtEnd(doc, 'More. '.length)).toBe(4);
    const fourth = await preview(doc, editor);
    expect(fourth.api.state).toBe('completed');
    expect(compiled).toHaveLength(2);
    expect(fourth.api.result.url).toContain(pdfPath(first.id));
    expect(fourth.record.result?.['from']).toBe(first.id);
  }, 60_000);
});
