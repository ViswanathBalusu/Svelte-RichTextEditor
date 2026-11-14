/**
 * SEC-009 criterion 3 (lane U-SEC-001-016): when a second version of the element registers under a
 * name the first version holds, the collision is reported as a `de-error` event (not only a console
 * warning). In a page the event goes to the global event target; this test passes its own
 * EventTarget as the third argument of defineDocEditor, since Node.js has no page. The event is not
 * fatal, and its message names both versions and no content.
 */
import { describe, expect, it, vi } from 'vitest';
import { DocEditorElement } from '../src/doc-editor.ts';
import { defineDocEditor } from '../src/register.ts';

class FakeRegistry {
  readonly defined = new Map<string, CustomElementConstructor>();
  define(name: string, c: CustomElementConstructor): void {
    this.defined.set(name, c);
  }
  get(name: string): CustomElementConstructor | undefined {
    return this.defined.get(name);
  }
  getName(): string | null {
    return null;
  }
}

describe('SEC-009 criterion 3: a version collision is reported as de-error', () => {
  it('dispatches one non-fatal de-error that names both versions and carries no content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = new EventTarget();
    const seen: unknown[] = [];
    events.addEventListener('de-error', (e) => seen.push((e as CustomEvent).detail));

    const r = new FakeRegistry();
    const Older = Object.assign(function Older() {}, { version: '0.0', release: '0.0.0-old' });
    r.define('doc-editor', Older as unknown as CustomElementConstructor);

    expect(defineDocEditor('doc-editor', r as unknown as CustomElementRegistry, events)).toBe(
      'other',
    );

    expect(seen).toHaveLength(1);
    const detail = seen[0] as { code: string; message: string; fatal: boolean };
    expect(detail.fatal).toBe(false);
    expect(detail.code).toBe('internal');
    expect(detail.message).toContain('embedding API 0.0, release 0.0.0-old');
    expect(detail.message).toContain(`release ${DocEditorElement.release}`);
    warn.mockRestore();
  });

  it('dispatches nothing when the same version registers again', () => {
    const events = new EventTarget();
    const seen: unknown[] = [];
    events.addEventListener('de-error', (e) => seen.push((e as CustomEvent).detail));
    const r = new FakeRegistry();
    const SameBuild = Object.assign(function SameBuild() {}, {
      version: DocEditorElement.version,
      release: DocEditorElement.release,
    });
    r.define('doc-editor', SameBuild as unknown as CustomElementConstructor);
    expect(defineDocEditor('doc-editor', r as unknown as CustomElementRegistry, events)).toBe(
      'same',
    );
    expect(seen).toHaveLength(0);
  });
});
