/**
 * Builds the shell's test harness: `node e2e/build.ts` (the Playwright web server runs it). Writes
 * dist/harness, plus a small same-origin avatar image, which a strict `img-src 'self'` allows.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { build } from 'vite';
import { harnessConfig, outDir, uiDir } from './vite-config.ts';

/** A square PNG of one colour, written by hand so the harness needs no image file. */
function png(size: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const started = Date.now();
await build(harnessConfig());
writeFileSync(join(outDir, 'avatar.png'), png(8, [11, 92, 173]));

// The sandboxed extension's frame (UX-060): the runtime built as one classic script, the frame page
// that loads it, and a small extension that draws two buttons.
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    lib: {
      entry: join(uiDir, 'src', 'extensions', 'sandbox-runtime.ts'),
      formats: ['iife'],
      name: 'sandboxRuntime',
      fileName: () => 'sandbox-runtime.js',
    },
  },
});
writeFileSync(
  join(outDir, 'sandbox-frame.html'),
  '<!doctype html><meta charset="utf-8"><title>Extension</title><script src="/sandbox-runtime.js"></script>',
);
writeFileSync(
  join(outDir, 'ext-panel.js'),
  `deExtension.activate(() => {
  document.body.textContent = '';
  for (const id of ['b1', 'b2']) {
    const b = document.createElement('button');
    b.id = id;
    b.textContent = 'Button ' + id;
    document.body.append(b);
  }
  document.body.dataset.ready = '1';
});
`,
);
console.log(`ui harness build: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
