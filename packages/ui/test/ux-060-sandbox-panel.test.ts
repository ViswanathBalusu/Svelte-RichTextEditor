/**
 * UX-060 criterion 5, the parts that need no browser: which keys forwarded out of a sandboxed
 * frame move the landmarks (`landmarkStep`, by the shell's own key table), and that a sandboxed
 * extension with a panel registers a pane with the extension and removes it with it. The keys in a
 * real frame, and the focus, are in e2e/ux-060-sandbox-panel.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { sandboxedExtension } from '../src/extensions/sandbox-extension.ts';
import { landmarkKeys, landmarkStep } from '../src/shell/landmarks.ts';
import { PaneRegistry } from '../src/shell/panes.ts';

const key = (k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key: k,
  ctrlKey: mods.ctrl === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
});

describe('UX-060: keys forwarded out of a frame step the landmarks by the shell table', () => {
  const keys = landmarkKeys(false);
  it('Ctrl+F6 and Alt+F6 go forward, with Shift back', () => {
    expect(landmarkStep(key('F6', { ctrl: true }), keys, false)).toBe(1);
    expect(landmarkStep(key('F6', { alt: true }), keys, false)).toBe(1);
    expect(landmarkStep(key('F6', { ctrl: true, shift: true }), keys, false)).toBe(-1);
    expect(landmarkStep(key('F6', { alt: true, shift: true }), keys, false)).toBe(-1);
  });
  it('a bare F6, Shift+F6, Escape and letters move nothing', () => {
    expect(landmarkStep(key('F6'), keys, false)).toBeNull();
    expect(landmarkStep(key('F6', { shift: true }), keys, false)).toBeNull();
    expect(landmarkStep(key('Escape'), keys, false)).toBeNull();
    expect(landmarkStep(key('a', { ctrl: true }), keys, false)).toBeNull();
    expect(landmarkStep(key('', { ctrl: true }), keys, false)).toBeNull();
  });
});

describe('UX-060: a sandboxed extension with a panel', () => {
  const manifest = {
    id: 'ext.sandboxed',
    name: 'Sandboxed notes',
    apiVersion: '1',
    tier: 2,
    access: { read: 'view', write: 'none' },
    entry: 'https://ext.example/panel.js',
  };
  const options = (registry: PaneRegistry) => ({
    manifest,
    frameUrl: 'https://host.example/sandbox-frame.html',
    panel: {
      registry,
      id: 'ext-sandboxed',
      load: () => Promise.reject(new Error('not loaded in Node.js')),
    },
    suggesting: () => false,
    log: () => undefined,
  });
  const documentApi = {} as never;

  it('registers its pane on activation, with the mount function as a prop, and removes it with the extension', () => {
    const registry = new PaneRegistry([]);
    const removers: Array<() => void> = [];
    sandboxedExtension(options(registry)).activate({
      document: documentApi,
      onRemove: (dispose) => removers.push(dispose),
    });
    const pane = registry.get('ext-sandboxed');
    expect(pane?.label).toBe('Sandboxed notes');
    expect(typeof pane?.load).toBe('function');
    expect(typeof pane?.props?.['mount']).toBe('function');
    expect(removers).toHaveLength(1);
    removers[0]!();
    expect(registry.get('ext-sandboxed')).toBeUndefined();
  });

  it('mounts no frame until the pane opens', () => {
    const registry = new PaneRegistry([]);
    // No `document` exists here: a frame mounted at activation would throw.
    expect(() =>
      sandboxedExtension(options(registry)).activate({
        document: documentApi,
        onRemove: () => undefined,
      }),
    ).not.toThrow();
  });

  it('is refused like any other entry without access, and registers no pane', () => {
    const registry = new PaneRegistry([]);
    const entry = sandboxedExtension({
      ...options(registry),
      manifest: { ...manifest, access: undefined },
    });
    expect(() => entry.activate({ document: documentApi, onRemove: () => undefined })).toThrow(
      /access/,
    );
    expect(registry.get('ext-sandboxed')).toBeUndefined();
  });
});
