// Registration (02 §2; FE-001): importing without a DOM is safe, and the version check decides
// between defining, keeping a same-version definition and warning about another version.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DocEditorElement } from '../src/doc-editor.ts';
import { defineDocEditor } from '../src/register.ts';
import { EMBEDDING_VERSION, RELEASE } from '../src/version.ts';

const here = import.meta.dirname;

class FakeRegistry {
  readonly defined = new Map<string, CustomElementConstructor>();
  define(name: string, c: CustomElementConstructor): void {
    if (this.defined.has(name)) throw new Error(`${name} is already defined`);
    for (const existing of this.defined.values())
      if (existing === c)
        throw Object.assign(new Error('constructor already used'), { name: 'NotSupportedError' });
    this.defined.set(name, c);
  }
  get(name: string): CustomElementConstructor | undefined {
    return this.defined.get(name);
  }
  getName(c: CustomElementConstructor): string | null {
    for (const [name, existing] of this.defined) if (existing === c) return name;
    return null;
  }
}

describe('importing the module', () => {
  it('in Node.js, with no DOM, does not throw, defines nothing and reads no browser global', () => {
    const out = execFileSync(process.execPath, [resolve(here, 'fixtures/import-without-dom.ts')], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const report = JSON.parse(out.trim().split('\n').at(-1)!) as {
      error: string | null;
      exports: string[];
      checked: string[];
      read: string[];
      added: string[];
    };
    expect(report.error).toBeNull();
    expect(report.exports).toContain('DocEditorElement');
    // Existence checks only (`'HTMLElement' in globalThis`), never a read, and no new global.
    expect(report.checked).toEqual(['HTMLElement', 'customElements']);
    expect(report.read).toEqual([]);
    expect(report.added).toEqual([]);
  });
});

describe('defineDocEditor', () => {
  it('defines the exported class under a free name', () => {
    const r = new FakeRegistry();
    expect(defineDocEditor('doc-editor', r as unknown as CustomElementRegistry)).toBe('defined');
    expect(r.get('doc-editor')).toBe(DocEditorElement);
  });

  it('keeps a definition of the same version silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new FakeRegistry();
    const SameBuild = Object.assign(function SameBuild() {}, {
      version: EMBEDDING_VERSION,
      release: RELEASE,
    });
    r.define('doc-editor', SameBuild as unknown as CustomElementConstructor);
    expect(defineDocEditor('doc-editor', r as unknown as CustomElementRegistry)).toBe('same');
    expect(defineDocEditor('doc-editor', r as unknown as CustomElementRegistry)).toBe('same');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns once, naming both versions, and leaves another version in place', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new FakeRegistry();
    const Older = Object.assign(function Older() {}, { version: '0.0', release: '0.0.0-old' });
    r.define('doc-editor', Older as unknown as CustomElementConstructor);
    expect(defineDocEditor('doc-editor', r as unknown as CustomElementRegistry)).toBe('other');
    expect(r.get('doc-editor')).toBe(Older);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('embedding API 0.0, release 0.0.0-old');
    expect(message).toContain(`embedding API ${EMBEDDING_VERSION}, release ${RELEASE}`);
    warn.mockRestore();
  });

  it('defines a subclass when the class already has a name in the registry', () => {
    const r = new FakeRegistry();
    defineDocEditor('doc-editor', r as unknown as CustomElementRegistry);
    expect(defineDocEditor('my-editor', r as unknown as CustomElementRegistry)).toBe('defined');
    const other = r.get('my-editor')!;
    expect(other).not.toBe(DocEditorElement);
    expect(Object.getPrototypeOf(other)).toBe(DocEditorElement);
    expect((other as unknown as typeof DocEditorElement).version).toBe(EMBEDDING_VERSION);
  });
});

describe('versions', () => {
  it('the release equals the package version; the embedding API version is MAJOR.MINOR', () => {
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
      version: string;
    };
    expect(RELEASE).toBe(pkg.version);
    expect(EMBEDDING_VERSION).toMatch(/^\d+\.\d+$/);
    expect(DocEditorElement.version).toBe(EMBEDDING_VERSION);
    expect(DocEditorElement.release).toBe(RELEASE);
  });
});
