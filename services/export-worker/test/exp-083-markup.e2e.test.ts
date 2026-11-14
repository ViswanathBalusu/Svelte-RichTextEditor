/**
 * EXP-083 criterion 2 (lane U-EXP-081-096): an export with `suggestions` set to `markup` gives a
 * PDF whose extracted text holds both the inserted and the deleted text. Runs through the control
 * plane's job resource, the export worker and the real Podman sandbox, as export.e2e.test.ts does.
 *
 * Needs Podman, the worker image and `pdftotext` (skips otherwise).
 */
import { randomBytes } from 'node:crypto';
import { objectKeys } from '@docedit/document-service';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { imageFontManifest } from '../src/fonts.ts';
import { compileInSandbox, IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { createExportWorker, type ExportWorker } from '../src/worker.ts';
import { demoDocument } from './documents.ts';
import { pdftotextAvailable, pdfText, squash } from './pdf-text.ts';
import { startTestService, type TestService } from './service.ts';

vi.setConfig({ testTimeout: 420_000, hookTimeout: 180_000 });

const ready = await sandboxReady();

/** The demonstration document, with one deletion ("old ") and one insertion ("new ") in a paragraph. */
function markedDocument() {
  const envelope = structuredClone(demoDocument().envelope);
  type Node = { type?: string; content?: Node[] } & Record<string, unknown>;
  const find = (node: Node): Node | null => {
    if (node.type === 'paragraph' && JSON.stringify(node).includes('The end of the document.'))
      return node;
    for (const child of node.content ?? []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const paragraph = find(envelope.doc as Node)!;
  paragraph.content = [
    { type: 'text', text: 'Keep ' },
    {
      type: 'text',
      text: 'old ',
      marks: [{ type: 'del', attrs: { id: 'sDel083000000001', user: 'alice' } }],
    },
    {
      type: 'text',
      text: 'new ',
      marks: [{ type: 'ins', attrs: { id: 'sIns083000000002', user: 'alice' } }],
    },
    { type: 'text', text: 'text.' },
  ];
  return envelope;
}

describe.skipIf(!ready.ok)(`EXP-083 markup in the PDF text (${ready.reason})`, () => {
  let t: TestService;
  let worker: ExportWorker;
  const containers: string[] = [];

  beforeAll(async () => {
    t = await startTestService();
    const fonts = await imageFontManifest(IMAGE);
    worker = createExportWorker({
      queue: t.service.parts.queue,
      deps: {
        stores: {
          logs: t.service.parts.logs,
          checkpoints: t.service.checkpoints,
          documents: t.service.parts.documents,
        },
        outputs: t.service.assets,
        fonts: async () => fonts,
        compile: (files, opts) => {
          const name = `docedit-job-u-exp-081-096-${randomBytes(4).toString('hex')}`;
          containers.push(name);
          return compileInSandbox(files, { ...opts, name });
        },
      },
      worker: 'export-u-exp-081-096',
      leaseMs: 3000,
      idleMs: 50,
      retryAfterMs: 1000,
    });
    worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await t?.close();
  });

  it.skipIf(!pdftotextAvailable())(
    'keeps both the inserted and the deleted text in the PDF text under markup (EXP-083 criterion 2)',
    async () => {
      const doc = await t.createDocument(markedDocument());
      const editor = t.userToken({ [doc]: 'editor' });
      const created = await t.call('POST', `/v1/documents/${doc}/exports`, {
        token: editor,
        body: { target: 'pdf', options: { suggestions: 'markup' } },
      });
      expect(created.status, created.text).toBe(202);
      let api: { state: string; result: { url: string } | null; error?: unknown } | null = null;
      for (let i = 0; i < 2400; i++) {
        const r = await t.call('GET', `/v1/exports/${created.json.id}`, { token: editor });
        if (['completed', 'failed', 'cancelled'].includes(r.json?.state)) {
          api = r.json;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(api, 'the export ended').not.toBeNull();
      expect(api!.state, JSON.stringify(api!.error ?? null)).toBe('completed');
      const bytes = t.s3
        ? new Uint8Array(await (await fetch(api!.result!.url)).arrayBuffer())
        : (await t.service.parts.objects.get(
            objectKeys.exportFile(t.tenant, created.json.id, 'output.pdf'),
          ))!;
      expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
      const text = squash(pdfText(bytes)!);
      expect(text).toContain('Keep');
      expect(text).toContain('old');
      expect(text).toContain('new');
      expect(text).toContain('text.');
      expect(containers.length).toBeGreaterThan(0);
    },
  );
});
