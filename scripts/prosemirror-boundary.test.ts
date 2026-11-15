// The ProseMirror boundary rules of `.dependency-cruiser.cjs` (FE-026 criterion 1; 02 §5.1,
// ADR 0003). `packages/ui` has no `prosemirror-*` dependency, so an import of one does not
// resolve and dependency-cruiser reports the bare name, not a `node_modules/` path. The rules
// must match both forms. This test reads the rules; `pnpm deps:check` applies them.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rule = { name: string; severity: string; from: { path: string }; to: { path: string } };

const require = createRequire(import.meta.url);
const config = require(resolve(import.meta.dirname, '..', '.dependency-cruiser.cjs')) as {
  forbidden: Rule[];
};
const rule = (name: string): Rule => {
  const found = config.forbidden.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no rule named ${name}`);
  return found;
};

describe.each(['ui-no-prosemirror', 'hosts-no-prosemirror'])('%s', (name) => {
  const to = new RegExp(rule(name).to.path);

  it('is an error', () => {
    expect(rule(name).severity).toBe('error');
  });

  it('matches an import that does not resolve (the bare module name)', () => {
    expect(to.test('prosemirror-state')).toBe(true);
    expect(to.test('prosemirror-view/style/prosemirror.css')).toBe(true);
  });

  it('matches a resolved import, hoisted or in the pnpm store', () => {
    expect(to.test('node_modules/prosemirror-model/dist/index.js')).toBe(true);
    expect(
      to.test(
        'node_modules/.pnpm/prosemirror-view@1.0.0/node_modules/prosemirror-view/dist/index.js',
      ),
    ).toBe(true);
  });

  it('leaves the document API and other modules alone', () => {
    expect(to.test('packages/engine/src/api.ts')).toBe(false);
    expect(to.test('packages/ui/src/not-prosemirror-like.ts')).toBe(false);
  });
});

describe('the sources the rules cover', () => {
  it('covers the interface, the element source and the hosts', () => {
    const ui = new RegExp(rule('ui-no-prosemirror').from.path);
    const hosts = new RegExp(rule('hosts-no-prosemirror').from.path);
    expect(ui.test('packages/ui/src/toolbar.ts')).toBe(true);
    expect(hosts.test('packages/element/src/element.ts')).toBe(true);
    expect(hosts.test('apps/reference-host/src/lib/editor.ts')).toBe(true);
    expect(hosts.test('packages/engine/src/core.ts')).toBe(false);
  });
});
