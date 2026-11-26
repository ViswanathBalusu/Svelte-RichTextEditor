// SYN-046 criterion 2 as reworded by owner decision 217: the session layer of the data plane and the
// protocol package name no ProseMirror type. The projection gateway and the room host are the
// `pm-steps/1` engine's own code and are behind the engine interface (ADR 0001, 04 section 15), so
// they are not checked here. The authority's contract file is checked in
// `packages/authority/test/engine-contract.test.ts`.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const plane = new URL('../../src/data-plane/', import.meta.url);
const protocol = new URL('../../../../packages/protocol/src/', import.meta.url);

/** Module specifiers named by import and export statements and dynamic imports. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}
const isProseMirror = (s: string): boolean =>
  /^prosemirror-/.test(s) || s === '@docedit/model/prosemirror';

describe('SYN-046: no ProseMirror type in the session layer or the protocol layer', () => {
  // The files that speak DEP to a client and route its channels: the session, its wire form, the
  // engine negotiation, the forwarding of channels to another node, and the admission gate.
  const SESSION_LAYER = ['session.ts', 'wire.ts', 'engines.ts', 'forwarding.ts', 'gate.ts'];

  it.each(SESSION_LAYER)('%s imports no ProseMirror module', (file) => {
    const source = readFileSync(new URL(file, plane), 'utf8');
    expect(specifiers(source).filter(isProseMirror), file).toEqual([]);
  });

  it('reads the right files: each names the engine interface or a channel', () => {
    for (const file of SESSION_LAYER) {
      const source = readFileSync(new URL(file, plane), 'utf8');
      expect(source.length, file).toBeGreaterThan(500);
    }
    expect(readFileSync(new URL('engines.ts', plane), 'utf8')).toMatch(
      /negotiatedEngine|EngineRegistry/,
    );
  });

  it('the protocol package imports no ProseMirror module', () => {
    const files = readdirSync(protocol, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const source = readFileSync(new URL(f.replaceAll('\\', '/'), protocol), 'utf8');
      expect(specifiers(source).filter(isProseMirror), f).toEqual([]);
    }
  });

  it('the checker would catch a ProseMirror import', () => {
    expect(
      specifiers(
        `import type { Step } from 'prosemirror-transform';\nimport { x } from './a.ts';`,
      ).filter(isProseMirror),
    ).toEqual(['prosemirror-transform']);
    expect(
      specifiers(`import { cdmSchema } from '@docedit/model/prosemirror';`).filter(isProseMirror),
    ).toEqual(['@docedit/model/prosemirror']);
  });
});
