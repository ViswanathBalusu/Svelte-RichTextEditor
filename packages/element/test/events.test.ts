// Events of the embedding API (05 §8.1; FE-022; PRO-087): one helper dispatches them, composed and
// bubbling, with a frozen copy of the detail; the package's lint rules refuse any other dispatch
// and any HTML-string sink (FE-016).
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, emit } from '../src/events.ts';

const elementDir = resolve(import.meta.dirname, '..');

async function lint(code: string, file = 'src/sample.ts'): Promise<string[]> {
  const eslint = new ESLint({ cwd: elementDir });
  const [result] = await eslint.lintText(code, { filePath: resolve(elementDir, file) });
  return (result?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`);
}

describe('emit', () => {
  it('dispatches a CustomEvent that bubbles and is composed, with a frozen copy of the detail', () => {
    const target = new EventTarget();
    const seen: CustomEvent[] = [];
    target.addEventListener('de-ready', (e) => seen.push(e as CustomEvent));
    const detail = { docId: 'd1', seq: 3 };
    emit(target, 'de-ready', detail);
    detail.seq = 4;
    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect(e).toBeInstanceOf(CustomEvent);
    expect([e.bubbles, e.composed, e.cancelable]).toEqual([true, true, false]);
    expect(e.detail).toEqual({ docId: 'd1', seq: 3 });
    expect(Object.isFrozen(e.detail)).toBe(true);
  });

  it('raises de-share-request with identifiers only, and nothing breaks without a listener (PRO-089)', () => {
    const host = new EventTarget();
    const seen: CustomEvent[] = [];
    host.addEventListener('de-share-request', (e) => seen.push(e as CustomEvent));
    emit(host, 'de-share-request', { docId: 'doc-7' });
    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect([e.bubbles, e.composed]).toEqual([true, true]);
    expect(e.detail).toEqual({ docId: 'doc-7' });
    // With no listener the dispatch returns normally and raises nothing.
    expect(() => emit(new EventTarget(), 'de-share-request', { docId: 'doc-7' })).not.toThrow();
    expect(EVENT_NAMES).toContain('de-share-request');
  });

  it('names every event with the de- prefix', () => {
    expect(EVENT_NAMES.length).toBeGreaterThan(0);
    for (const name of EVENT_NAMES) expect(name).toMatch(/^de-[a-z-]+$/);
  });
});

describe('lint rules of the element package', () => {
  it('fails any other dispatchEvent and any CustomEvent in the source (FE-022)', async () => {
    const messages = await lint(
      "export function f(el: EventTarget): void {\n  el.dispatchEvent(new CustomEvent('de-ready'));\n}\n",
    );
    expect(messages.filter((m) => m.startsWith('no-restricted-syntax'))).toHaveLength(2);
    expect(await lint("export const e = new CustomEvent('x');\n", 'src/events.ts')).toEqual([]);
  });

  it('fails HTML-string sinks (FE-016)', async () => {
    const messages = await lint(
      [
        'export function f(el: Element, f2: HTMLIFrameElement): void {',
        "  el.innerHTML = '<b>x</b>';",
        "  el.insertAdjacentHTML('beforeend', '<i>y</i>');",
        "  f2.srcdoc = '<p>z</p>';",
        '}',
        '',
      ].join('\n'),
    );
    expect(messages.filter((m) => m.startsWith('no-restricted-properties'))).toHaveLength(3);
  });
});

describe('de-fork-request (HIS-022)', () => {
  it('is raised with the document and the seq only, bubbling and composed, and is in the catalogue', () => {
    const host = new EventTarget();
    const seen: CustomEvent[] = [];
    host.addEventListener('de-fork-request', (e) => seen.push(e as CustomEvent));
    emit(host, 'de-fork-request', { docId: 'doc-7', atSeq: 12 });
    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect([e.bubbles, e.composed]).toEqual([true, true]);
    expect(e.detail).toEqual({ docId: 'doc-7', atSeq: 12 });
    expect(Object.isFrozen(e.detail)).toBe(true);
    expect(EVENT_NAMES).toContain('de-fork-request');
    // Nothing breaks when the host has no listener.
    expect(() =>
      emit(new EventTarget(), 'de-fork-request', { docId: 'd', atSeq: 0 }),
    ).not.toThrow();
  });
});
