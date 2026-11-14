/**
 * SEC-034 criterion 1 (part) — a `latex` attribute that defines or primitives is refused at commit
 * time (I8) and again by the converter (09 §6.3; EXP-049, EXP-050).
 *
 * This file checks the two halves separately, each with the real gate of `packages/export-latex`:
 * the room refuses the commit when a math gate is injected (`RoomInit.mathGate`), and the converter
 * writes a placeholder and a `math_refused` diagnostic instead of the equation. It does not prove
 * the production path: the document service's room host (`services/document-service/src/data-plane/
 * room-host.ts`) builds the room without a `mathGate`, so the service does not apply I8 to math yet.
 * Criterion 1 of SEC-034 therefore stays unticked; see the story's Notes.
 *
 * Node.js only. The gate and the converter helpers are imported by relative path, so this package
 * needs no new dependency.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Room } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { basePermissions, schema, USERS } from '../../../packages/authority/test/fixtures.ts';
import { mathGate } from '../../../packages/export-latex/src/math/gate.ts';
import { blockLines, doc, nid, run } from '../../../packages/export-latex/test/docs.ts';

type J = Record<string, unknown>;

const FIXTURES = resolve(import.meta.dirname, '../../../packages/model/fixtures');
const BASE = JSON.parse(readFileSync(resolve(FIXTURES, 'example-03-12.json'), 'utf8')) as J;
const ASSETS = [
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
];

/** Definitions and primitives of the SEC-034 corpus (criterion 1). */
const DEFINITIONS: readonly string[] = [
  '\\def\\a{x}',
  '\\let\\a\\b',
  '\\csname a\\endcsname',
  '\\catcode`\\@=11',
  '\\input file',
  '\\include file',
  '\\openin1=file',
  '\\write18{ls}',
  '\\write 1{x}',
  '\\directlua{os.exit()}',
  '\\special{x}',
  '\\immediate x',
  '\\newcommand{\\a}{x}',
  '^^5cinput file',
  '^^5Cinput file',
  '^^^^005cinput file',
  '\\def\\a{x}\\a',
];

/** A commit that inserts one equation with `latex` into the example document. */
function equationStep(latex: string): J {
  return {
    stepType: 'replace',
    from: 59,
    to: 59,
    slice: {
      content: [
        {
          type: 'equation_block',
          attrs: {
            id: 'eqGate0000000001',
            latex,
            numbered: false,
            label: null,
            preserved: null,
            ext: {},
          },
        },
      ],
    },
  };
}

/** A room over the example document with the real gate injected, as the converter uses it. */
function roomWithGate() {
  return new Room({
    schema,
    initial: schema.nodeFromJSON(BASE['doc'] as J),
    requires: BASE['requires'] as string[],
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_771_000_000_000,
    limits: { maxStepsPerCommit: 5000, maxCommitBytes: 64 << 20, maxRebaseSteps: 5000 },
    attachedAssets: new Set(ASSETS),
    retiredRegionIds: ['rRetiredRegion01'],
    mathGate: (latex: string, display: boolean) => {
      const g = mathGate(latex, display);
      return g.ok ? null : g.reason;
    },
  });
}

describe('SEC-034 criterion 1 (room): a definition or primitive in `latex` is refused at commit time (I8)', () => {
  it('accepts an ordinary equation through the same room, so the refusals below are not vacuous', () => {
    const room = roomWithGate();
    room.open('o1', USERS.alice);
    const fx = room.submit('o1', { id: uuid7(), base: 0, steps: [equationStep('a+b')] });
    expect(fx.send.some((o) => o.channel === 'o1' && o.msg.t === 'sync.reject')).toBe(false);
    expect(fx.write?.commits).toHaveLength(1);
  });

  it.each(DEFINITIONS.map((d) => [d] as const))(
    'refuses %s with invalid_op and stores nothing',
    (latex) => {
      expect(mathGate(latex, true).ok, `the gate itself refuses ${latex}`).toBe(false);
      const room = roomWithGate();
      room.open('o1', USERS.alice);
      const fx = room.submit('o1', { id: uuid7(), base: 0, steps: [equationStep(latex)] });
      const m = fx.send
        .filter((o) => o.channel === 'o1')
        .map((o) => o.msg)
        .find((x) => x.t === 'sync.reject');
      expect(m?.t).toBe('sync.reject');
      if (m?.t !== 'sync.reject') return;
      expect(m.code).toBe('invalid_op');
      expect(m.reason).toContain('I8');
      expect(fx.write).toBeNull();
    },
  );
});

describe('SEC-034 criterion 1 (converter): the same strings never reach the bundle as math', () => {
  it.each(DEFINITIONS.map((d) => [d] as const))(
    'writes a placeholder for %s and a math_refused diagnostic',
    async (latex) => {
      const id = nid('e');
      const b = await run(doc([{ type: 'equation_block', attrs: { id, latex } }]));
      expect(b.diagnostics.map((d) => d.code)).toContain('math_refused');
      const lines = blockLines(b, id).join('\n');
      expect(lines).toContain('\\DEplaceholder');
      expect(lines).not.toContain('\\DEeq{');
      for (const text of Object.values(b.files)) {
        if (typeof text === 'string') expect(text).not.toContain(latex);
      }
    },
  );
});
