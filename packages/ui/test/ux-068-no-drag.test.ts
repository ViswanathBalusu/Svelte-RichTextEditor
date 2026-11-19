/**
 * UX-068 criterion 4, a guard (lane w3, 2026-11-15). The criterion asks for a keyboard or dialog
 * alternative to every shell interaction that can be done by dragging (WCAG 2.2, 2.5.7). The shell
 * has no such interaction today. This test reads the shell's source and fails when a drag gesture
 * appears (a `draggable` attribute, a drag event, pointer capture, or a CSS `resize`), unless the
 * file is named in `REVIEWED` with its alternative. It does not show that an alternative exists;
 * it makes sure the question is asked when the first drag is built.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Files with a drag gesture, each with the keyboard or dialog alternative that was reviewed. */
const REVIEWED: Readonly<Record<string, string>> = {
  // Drawing a signature uses pointer capture. It is one of three ways to adopt a signature; the
  // typed name (a text field) and the uploaded image (a file field) need no drag (FRW-045).
  'components/SignatureDialog.svelte': 'the typed name and the uploaded image are the alternatives',
};

const GESTURE =
  /\bdraggable\b|\bon:?drag(start|end|over|enter|leave)?\b|\bon:?drop\b|['"]drag(start|end|over|enter|leave)['"]|['"]drop['"]|setPointerCapture|(^|[\s;{])resize\s*:(?!\s*none)/m;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (/\.(svelte|ts|css)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}

describe('UX-068: the shell has no drag-only interaction', () => {
  it('the pattern finds each gesture form', () => {
    for (const sample of [
      '<li draggable="true">',
      'ondragstart={start}',
      "on(node, 'dragover', over)",
      'el.setPointerCapture(event.pointerId)',
      '.de-pane { resize: horizontal; }',
    ])
      expect(GESTURE.test(sample), sample).toBe(true);
    for (const sample of ['textarea { resize: none; }', 'onpointermove={() => (index = i)}'])
      expect(GESTURE.test(sample), sample).toBe(false);
  });

  it('no shell source has a drag gesture outside the reviewed list', () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(10);
    const found = all
      .filter((file) => GESTURE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'))
      .filter((file) => !(file in REVIEWED));
    expect(found).toEqual([]);
  });
});
