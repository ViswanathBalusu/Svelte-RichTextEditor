/**
 * Output restrictions (UX-040, rule level). Criterion 3 (print refused with a reason) and
 * criterion 6 (other features unaffected) are tested on the rule. The call sites that use it (print,
 * the export command, copy, cut and drag on the editing surface) are not built, so the rest of
 * UX-040 stays open; see the story's Notes.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  NO_COPY,
  NO_EXPORT,
  NO_PRINT,
  commandDecision,
  commandOutputAction,
  outputDecision,
  type OutputAction,
} from '../src/commands/output-restrictions.ts';

const ACTIONS: readonly OutputAction[] = ['export', 'print', 'copy', 'cut', 'drag'];
const REASON: Readonly<Record<OutputAction, string>> = {
  export: NO_EXPORT,
  print: NO_PRINT,
  copy: NO_COPY,
  cut: NO_COPY,
  drag: NO_COPY,
};

const restrictionsArb = fc.uniqueArray(
  fc.constantFrom(NO_EXPORT, NO_COPY, NO_PRINT, 'unknown-restriction'),
  { maxLength: 4 },
);

describe('output restrictions (UX-040, rule level)', () => {
  it('refuses print with the reason no-print, and only under no-print (criterion 3)', () => {
    expect(outputDecision('print', [NO_PRINT])).toEqual({ allowed: false, reason: 'no-print' });
    expect(outputDecision('print', [NO_EXPORT, NO_COPY])).toEqual({ allowed: true });
  });

  it('refuses each output action only under its own restriction, with that reason (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ACTIONS), restrictionsArb, (action, restrictions) => {
        const decision = outputDecision(action, restrictions);
        const limited = (restrictions as readonly string[]).includes(REASON[action]);
        expect(decision.allowed).toBe(!limited);
        if (!decision.allowed) expect(decision.reason).toBe(REASON[action]);
      }),
    );
  });

  it('maps the export command to a disabled decision with a reason under no-export', () => {
    expect(commandOutputAction('document.export')).toBe('export');
    expect(commandDecision('document.export', [NO_EXPORT])).toEqual({
      allowed: false,
      reason: 'no-export',
    });
  });

  it('leaves every command that is not an output action allowed under any restriction (criterion 6, property)', () => {
    const otherCommands = fc.constantFrom(
      'document.bold',
      'comment.new',
      'navigate.outline',
      'view.read',
      'review.accept',
      'shell.view.print',
      'toString',
      '__proto__',
      '',
    );
    fc.assert(
      fc.property(otherCommands, restrictionsArb, (id, restrictions) => {
        expect(commandOutputAction(id)).toBeNull();
        expect(commandDecision(id, restrictions)).toEqual({ allowed: true });
      }),
    );
  });

  it('reads the restrictions it is given each time, so a changed list gives a new answer', () => {
    expect(outputDecision('copy', [])).toEqual({ allowed: true });
    expect(outputDecision('copy', [NO_COPY])).toEqual({ allowed: false, reason: 'no-copy' });
    expect(outputDecision('copy', [])).toEqual({ allowed: true });
  });
});
