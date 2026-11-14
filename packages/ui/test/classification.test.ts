/**
 * The classification label in the status bar (UX-085, criterion 2): its name is shown as text, not
 * by colour alone, and the bar reads the core's view, so a change reaches an open editor live.
 * The rule for the name is a pure function, tested with property tests; the wiring is checked on
 * the component source. A browser run of the status bar is still needed before this counts as
 * shown on screen (ADR 0137, decision 3).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { classificationName } from '../src/shell/classification.ts';

const statusBar = readFileSync(
  fileURLToPath(new URL('../src/components/StatusBar.svelte', import.meta.url)),
  'utf8',
);
const coreApi = readFileSync(fileURLToPath(new URL('../src/core-api.ts', import.meta.url)), 'utf8');

const blank = fc
  .array(fc.constantFrom(' ', '\t', '\n', ' '), { maxLength: 6 })
  .map((parts) => parts.join(''));

describe('the classification name the status bar shows (UX-085, criterion 2)', () => {
  it('shows nothing for a missing label or a blank name (property)', () => {
    fc.assert(
      fc.property(blank, (name) => {
        expect(classificationName(null)).toBeNull();
        expect(classificationName(undefined)).toBeNull();
        expect(classificationName({ name })).toBeNull();
      }),
    );
  });

  it('shows the name as written, with white space trimmed and collapsed (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        const shown = classificationName({ name });
        const letters = name.replace(/\s/g, '');
        if (letters.length === 0) {
          expect(shown).toBeNull();
          return;
        }
        expect(shown).not.toBeNull();
        expect(shown!.startsWith(' ') || shown!.endsWith(' ')).toBe(false);
        expect(shown!.includes('  ')).toBe(false);
        // Only white space changed: the characters are the same, in the same order.
        expect(shown!.replace(/ /g, '')).toBe(letters);
      }),
    );
  });

  it('never returns a name that is only white space (property)', () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 20 }), { nil: undefined }), (name) => {
        const shown = classificationName(name === undefined ? null : { name });
        if (shown !== null) expect(shown.trim().length).toBeGreaterThan(0);
      }),
    );
  });
});

describe('the words around the classification name are in the string table', () => {
  it('has a message with the label as a placeholder, and no colour word', () => {
    const message = EN_GB['status.classification'];
    expect(message).toBe('Classification: {label}');
    expect(String(message)).not.toMatch(/red|green|amber|colour|color/i);
  });
});

describe('the status bar shows the label as text and reads it live (UX-085, criterion 2)', () => {
  it('the core declares the label as a view that may be null (the document resource)', () => {
    expect(coreApi).toMatch(/readonly classification\?: ReadView<ClassificationLabel \| null>;/);
  });

  it('the bar reads the core view through `live`, so a change re-renders it', () => {
    expect(statusBar).toMatch(
      /const classification = core\.classification \? live\(core\.classification\) : null;/,
    );
    expect(statusBar).toMatch(/classification\?\.current \?\? null/);
  });

  it('the label is a text node in its own element, not only a colour or an attribute', () => {
    expect(statusBar).toMatch(
      /\{#if classificationText\}\s*<span data-status="classification">\{classificationText\}<\/span>\s*\{\/if\}/,
    );
  });
});
