/**
 * EXP-076 criterion 4 (lane U-EXP-065-080, fix round 1): the result manifest of a real export job
 * records the image and the class version. The job runs through the export handler with the real
 * single-use sandbox, the real font manifest of the image and the real image lookup (nothing is
 * stubbed but the content store and the output store). Skips without Podman and the worker image
 * (`sandboxReady`).
 *
 * What "image digest" means is the owner's decision (ADR 0116 decision 4). This test proves only
 * that `image.id` is the Podman image ID that `podman image inspect` reports for the image the job
 * ran in. It does not prove that a registry digest is recorded: none is. The criterion stays
 * unticked until the owner decides.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { JobContext, JobRecord } from '@docedit/document-service';
import { CLASS_VERSION } from '@docedit/export-latex';
import { uuid7 } from '@docedit/model';
import { describe, expect, it, vi } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { containerCli } from './container.ts';
import type { ContentStores } from './content.ts';
import { imageFontManifest } from './fonts.ts';
import { createExportHandler, OUTPUT_FILES } from './job.ts';
import { compileInSandbox, IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

const ready = await sandboxReady();

const INCARNATION = 'inc-u-exp-065-080';

function stores(): ContentStores {
  const envelope = demoDocument().envelope;
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
          title: 'EXP-076 manifest probe',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

/** What Podman itself reports for an image, read independently of container.ts's lookup. */
function inspect(image: string, format: string): string {
  // 120 s: a 30 s inspect timed out on the loaded Podman machine (status null; round 3, 2026-11-14).
  const r = spawnSync(containerCli(), ['image', 'inspect', '--format', format, image], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe.skipIf(!ready.ok)(`EXP-076 result manifest of a real job (${ready.reason})`, () => {
  it('records the Podman image ID of the image the job compiled in, and the class version', async () => {
    const stored = new Map<string, Uint8Array>();
    const containers: string[] = [];
    const fonts = await imageFontManifest(IMAGE);
    const handler = createExportHandler({
      stores: stores(),
      outputs: {
        putExport: async (_t, _j, name, bytes) => {
          stored.set(name, bytes);
        },
      },
      fonts: async () => fonts,
      compile: (files, opts) => {
        const name = `docedit-u-fe-065-080-manifest-${randomBytes(4).toString('hex')}`;
        containers.push(name);
        return compileInSandbox(files, { ...opts, name });
      },
    });
    const doc = uuid7();
    const job = {
      id: uuid7(),
      tenant: uuid7(),
      doc,
      kind: 'export',
      state: 'running',
      createdAt: Date.now(),
      payload: {
        doc,
        target: 'pdf',
        seq: 0,
        incarnation: INCARNATION,
        options: { profile: 'preview' },
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

    const result = await handler(job, ctx);
    expect(result['manifest']).toBe(OUTPUT_FILES.manifest);
    expect(containers).toHaveLength(1);
    const bytes = stored.get(OUTPUT_FILES.manifest);
    expect(bytes, 'the job stored manifest.json').toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      image: { name: string; id: string | null };
      bundle: { classVersion: string };
    };

    // The image the job ran in, and its ID as Podman reports it.
    expect(manifest.image.name).toBe(IMAGE);
    const id = inspect(IMAGE, '{{.Id}}');
    expect(manifest.image.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.image.id).toBe(id.startsWith('sha256:') ? id : `sha256:${id}`);
    // The class version the bundle was written for.
    expect(manifest.bundle.classVersion).toBe(CLASS_VERSION);
    // The image's manifest digest is a different value and is not what the manifest records; which
    // of the two (or a registry digest) the criterion means is open (ADR 0116 decision 4).
    const digest = inspect(IMAGE, '{{.Digest}}');
    if (/^sha256:[0-9a-f]{64}$/.test(digest)) expect(manifest.image.id).not.toBe(digest);
  });
});
