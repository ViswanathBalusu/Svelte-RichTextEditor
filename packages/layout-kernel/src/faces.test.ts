/**
 * WASM-005: the font faces the kernel holds. These tests start the real build of the crate in
 * Node.js and give it real font files (the Noto Serif and Harano Aji files of packages/perf/fonts),
 * checked against SHA-256 values that Node.js computes independently.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KERNEL_FILES, KernelFaceError, createKernel, type KernelGlue } from './index.ts';

const dist = resolve(import.meta.dirname, '../dist');
const fonts = resolve(import.meta.dirname, '../../perf/fonts/files');
const built = existsSync(resolve(dist, KERNEL_FILES.wasm));
const required = process.env['DOCEDIT_KERNEL_REQUIRED'] === '1';
if (required && !built) throw new Error('dist/ is not built: run build:wasm first');

const font = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(fonts, name)));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A fresh instance of the generated module for each test, so that each has its own faces. */
async function start() {
  const glue = (await import(
    `${pathToFileURL(resolve(dist, KERNEL_FILES.module)).href}?run=${Math.random()}`
  )) as KernelGlue;
  return createKernel(glue, new Uint8Array(readFileSync(resolve(dist, KERNEL_FILES.wasm))));
}

describe.skipIf(!built)('the kernel holds the faces of the manifest (WASM-005)', () => {
  it('hashes inside the module as Node.js does, for every length around a block', async () => {
    const kernel = await start();
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
      expect(kernel.sha256(bytes), `${length} bytes`).toBe(sha256(bytes));
    }
  });

  it('holds a real font file whose hash is the manifest’s, and says how much memory it takes', async () => {
    const kernel = await start();
    const bytes = font('NotoSerif-Regular.ttf');
    expect(kernel.faces.count()).toBe(0);
    const before = kernel.memoryBytes();
    expect(kernel.faces.load('', 'de-font-a', sha256(bytes), bytes)).toBe('new');
    expect(kernel.faces.has('de-font-a')).toBe(true);
    expect(kernel.faces.count()).toBe(1);
    expect(kernel.faces.bytesHeld()).toBe(bytes.length);
    // The module's linear memory grew to hold the file (and may hold more than the file).
    expect(kernel.memoryBytes()).toBeGreaterThanOrEqual(kernel.faces.bytesHeld());
    expect(kernel.memoryBytes()).toBeGreaterThan(before ?? 0);
  });

  it('refuses a file whose SHA-256 is not the manifest’s, and a damaged copy', async () => {
    const kernel = await start();
    const bytes = font('NotoSerif-Regular.ttf');
    const other = sha256(font('NotoSerif-Bold.ttf'));
    expect(() => kernel.faces.load('', 'de-font-a', other, bytes)).toThrow(KernelFaceError);
    try {
      kernel.faces.load('', 'de-font-a', other, bytes);
    } catch (error) {
      expect((error as KernelFaceError).code).toBe('hash_mismatch');
    }
    const damaged = bytes.slice();
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    expect(() => kernel.faces.load('', 'de-font-a', sha256(bytes), damaged)).toThrow(
      /hash_mismatch/,
    );
    expect(kernel.faces.has('de-font-a')).toBe(false);
    expect(kernel.faces.epoch()).toBe(0);
    expect(kernel.faces.bytesHeld()).toBe(0);
  });

  it('refuses a file that is not a font, a bad hash and an empty alias', async () => {
    const kernel = await start();
    const page = new TextEncoder().encode('<!doctype html><title>not found</title>');
    expect(() => kernel.faces.load('', 'a', sha256(page), page)).toThrow(/not_a_font/);
    const bytes = font('NotoSerif-Regular.ttf');
    expect(() => kernel.faces.load('', 'a', sha256(bytes).toUpperCase(), bytes)).toThrow(
      /bad_hash/,
    );
    expect(() => kernel.faces.load('', '', sha256(bytes), bytes)).toThrow(/empty_alias/);
  });

  it('holds a face once however often it is asked for, and advances the epoch for each new one', async () => {
    const kernel = await start();
    const serif = font('NotoSerif-Regular.ttf');
    const sans = font('NotoSans-Regular.ttf');
    expect(kernel.faces.load('', 'serif', sha256(serif), serif)).toBe('new');
    expect(kernel.faces.epoch()).toBe(1);
    expect(kernel.faces.load('', 'serif', sha256(serif), serif)).toBe('already');
    expect(kernel.faces.epoch()).toBe(1);
    expect(kernel.faces.bytesHeld()).toBe(serif.length);
    expect(kernel.faces.load('', 'sans', sha256(sans), sans)).toBe('new');
    expect(kernel.faces.epoch()).toBe(2);
    expect(kernel.faces.bytesHeld()).toBe(serif.length + sans.length);
  });

  it('counts the memory of a CJK face, and frees it when released', async () => {
    const kernel = await start();
    const cjk = font('HaranoAjiGothic-Regular.otf');
    kernel.faces.load('', 'cjk', sha256(cjk), cjk);
    expect(kernel.faces.bytesHeld()).toBe(cjk.length);
    expect(kernel.faces.release('cjk')).toBe(true);
    expect(kernel.faces.release('cjk')).toBe(false);
    expect(kernel.faces.bytesHeld()).toBe(0);
    expect(kernel.faces.count()).toBe(0);
  });

  it('keeps a tenant’s own face for that tenant only', async () => {
    const kernel = await start();
    const own = font('NotoSans-Bold.ttf');
    const shared = font('NotoSerif-Regular.ttf');
    kernel.faces.load('', 'shared', sha256(shared), shared);
    kernel.faces.load('tenant:a', 'own', sha256(own), own);
    expect(kernel.faces.owner('own')).toBe('tenant:a');
    expect(kernel.faces.owner('shared')).toBe('');
    expect(kernel.faces.owner('missing')).toBeNull();
    expect(() => kernel.faces.load('tenant:b', 'own', sha256(own), own)).toThrow(/owner_conflict/);
    expect(kernel.faces.releaseOwner('tenant:a')).toBe(1);
    expect(kernel.faces.has('own')).toBe(false);
    expect(kernel.faces.has('shared')).toBe(true);
    expect(kernel.faces.load('tenant:b', 'own', sha256(own), own)).toBe('new');
    kernel.faces.releaseAll();
    expect(kernel.faces.count()).toBe(0);
  });
});
