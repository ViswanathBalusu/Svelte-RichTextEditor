// UX-104 criterion 2 (lane V-UX-091-104): asking for access to a placeholder raises `de-access-request`
// for the host, with identifiers only, and the element sends nothing itself.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, emit } from '../src/events.ts';

const srcDir = resolve(import.meta.dirname, '..', 'src');

describe('de-access-request (UX-104)', () => {
  it('is a registered event that goes through emit, bubbles and is composed', () => {
    expect(EVENT_NAMES).toContain('de-access-request');
    const host = new EventTarget();
    const seen: CustomEvent[] = [];
    host.addEventListener('de-access-request', (e) => seen.push(e as CustomEvent));
    emit(host, 'de-access-request', { docId: 'doc-9', scope: 'scope-hidden-1' });
    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect([e.bubbles, e.composed]).toEqual([true, true]);
    expect(e.detail).toEqual({ docId: 'doc-9', scope: 'scope-hidden-1' });
    expect(Object.isFrozen(e.detail)).toBe(true);
  });

  it('nothing breaks without a listener', () => {
    expect(() =>
      emit(new EventTarget(), 'de-access-request', { docId: 'doc-9', scope: 'scope-hidden-1' }),
    ).not.toThrow();
  });

  // A source guard only, not evidence for UX-104 criterion 2: it matches text, it does not run the
  // element. The behaviour is tested in a browser by e2e/ux-104-access-request.spec.ts.
  it('guard: the source still wires the shell request to the element event', () => {
    const doc = readFileSync(resolve(srcDir, 'doc-editor.ts'), 'utf8');
    expect(doc).toMatch(/onAccessRequest: \(\{ scope \}\) => \{/);
    expect(doc).toContain("#emit('de-access-request', { docId, scope })");
    const editor = readFileSync(resolve(srcDir, 'editor.ts'), 'utf8');
    expect(editor).toContain('onAccessRequest?: (detail: { scope: string }) => void;');
    expect(editor).toContain('onAccessRequest: options.onAccessRequest');
  });
});
