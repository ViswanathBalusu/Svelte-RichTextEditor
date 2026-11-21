/**
 * UX-008 criterion 5: the context menu asks the core for the finding whose mark was clicked
 * (`proofingFinding(id)`; the mark carries the identifier, proofing-decorations.ts). The answer is the
 * finding as the interface reads it, wherever the caret is, and null once the finding is not shown.
 * The core is given a mock port and a stepped clock. Node.js, no DOM.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { proofingDecorations } from '../src/proofing-decorations.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledEditorAccess } from './fixtures.ts';
import { endOf, manualClock, newCore, settle, wordPort } from './proofing-support.ts';
import { type } from './support.ts';

/** The words of the styled document's body, each once. */
const WORDS = [
  'Introduction',
  'A',
  'quotation',
  'Plain',
  'text',
  'Protected',
  'After',
  'the',
  'region',
];

describe('UX-008 criterion 5: the finding of a clicked mark', () => {
  it('answers with the text, kind, message, suggestions, scope and language, and no position', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: ['Plane', 'Plan'] }), { clock: manualClock() });
    await settle();
    const [located] = core.proofingFindings();
    expect(located?.text).toBe('Plain');
    expect(core.proofingFinding(located!.id)).toEqual({
      id: located!.id,
      kind: 'spelling',
      message: 'Unknown word: Plain',
      text: 'Plain',
      suggestions: ['Plane', 'Plan'],
      scope: 'body',
      lang: 'en-GB',
    });
  });

  it('does not depend on the caret: the caret is in another paragraph', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: ['Plane'] }), { clock: manualClock() });
    await settle();
    endOf(core, STYLE_IDS.heading);
    expect(core.proofing.get().atCaret).toBeNull();
    const id = core.proofingFindings()[0]!.id;
    expect(core.proofingFinding(id)?.text).toBe('Plain');
  });

  it('the identifier a mark carries is the one the lookup takes', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: ['Plane'], quotation: ['quotations'] }), {
      clock: manualClock(),
    });
    await settle();
    const doc = internals(core).state.doc;
    const marks = proofingDecorations(doc, core.proofingFindings(), null).find();
    const ids = marks.map(
      (d) =>
        (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-de-finding'],
    );
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => core.proofingFinding(id!)?.text)).toEqual(['quotation', 'Plain']);
  });

  it('is null without a port, for an unknown identifier and after the port is detached', async () => {
    const core = newCore();
    expect(core.proofingFinding('pPlain0000000001:0:5:spelling')).toBeNull();
    const detach = core.attachProofing(wordPort({ Plain: ['Plane'] }), { clock: manualClock() });
    await settle();
    const id = core.proofingFindings()[0]!.id;
    expect(core.proofingFinding(id)).not.toBeNull();
    expect(core.proofingFinding(`${id}x`)).toBeNull();
    expect(core.proofingFinding('')).toBeNull();
    detach();
    expect(core.proofingFinding(id)).toBeNull();
  });

  it('is null once the text under the mark changed, before the port has answered again', async () => {
    const core = newCore();
    const clock = manualClock();
    core.attachProofing(wordPort({ Plain: ['Plane'] }), { clock });
    await settle();
    const id = core.proofingFindings()[0]!.id;
    endOf(core, STYLE_IDS.plain);
    type(core, '!');
    // The pause has not passed: the old result no longer holds for the block's text.
    expect(core.proofingFinding(id)).toBeNull();
    clock.fire();
    await settle();
    // The same word at the same place has the same identifier again.
    expect(core.proofingFinding(id)?.text).toBe('Plain');
  });

  it('is null for a finding the author ignored, and for one in a scope the reader may no longer view', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: ['Plane'], After: ['Aft'] }), { clock: manualClock() });
    await settle();
    const [plain, after] = core.proofingFindings();
    expect(core.ignoreFinding(plain!.id)).toBe(true);
    expect(core.proofingFinding(plain!.id)).toBeNull();
    expect(core.proofingFinding(after!.id)?.text).toBe('After');
    const access = styledEditorAccess();
    core.setAccess({ ...access, rev: 2, scopes: { ...access.scopes, body: [] } });
    expect(core.proofingFinding(after!.id)).toBeNull();
  });

  it('finds every finding shown by its identifier, and nothing else (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...WORDS), { maxLength: 6 }),
        async (flagged) => {
          const core = newCore();
          core.attachProofing(wordPort(Object.fromEntries(flagged.map((w) => [w, [`${w}s`]]))), {
            clock: manualClock(),
          });
          await settle();
          const shown = core.proofingFindings();
          for (const f of shown) {
            const info = core.proofingFinding(f.id);
            expect(info).toEqual({
              id: f.id,
              kind: f.kind,
              message: f.message,
              text: f.text,
              suggestions: f.suggestions,
              scope: f.scope,
              lang: f.lang,
            });
            // No document position reaches the interface.
            expect(info).not.toHaveProperty('from');
            expect(info).not.toHaveProperty('to');
          }
          // An identifier that is not one of those shown finds nothing.
          const ids = new Set(shown.map((f) => f.id));
          for (const block of Object.values(STYLE_IDS)) {
            const id = `${block}:0:1:spelling`;
            if (!ids.has(id)) expect(core.proofingFinding(id)).toBeNull();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
