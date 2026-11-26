/**
 * EXP-049 criterion 6: the editor asks the same math gate as the authority and the converter.
 * The math editor service (`math-editor.ts`) runs `mathGateReason` of `@docedit/export-latex` before
 * a confirmed equation leaves the editor. The core here is a stand-in that records what it is asked;
 * the authority's own use of the gate is tested in services/document-service.
 */
import type { EditorCore } from '@docedit/engine';
import { describe, expect, it, vi } from 'vitest';
import { mathGateReason as fromIndex } from '@docedit/export-latex';
import { mathGateReason as fromSubpath } from '@docedit/export-latex/math/gate';
import { mathEditorService } from '../src/math-editor.ts';

function core(display: boolean) {
  const confirmEquation = vi.fn(async () => ({ ok: true, confirmed: true }));
  const stand = {
    equationRequest: { get: () => null, subscribe: () => () => undefined },
    revision: { get: () => 0, subscribe: () => () => undefined },
    selectedEquation: () => ({ pos: 3, latex: 'x', display }),
    equationLimits: { length: 4000, depth: 50 },
    confirmEquation,
  } as unknown as EditorCore;
  return { stand, confirmEquation };
}

describe('the editor uses the shared math gate (EXP-049 criterion 6)', () => {
  it('is the one function the converter and the authority import', () => {
    expect(fromSubpath).toBe(fromIndex);
  });

  it('refuses a forbidden primitive before the request leaves the editor', async () => {
    const { stand, confirmEquation } = core(false);
    const service = mathEditorService(stand);
    for (const latex of ['\\def\\x{1}', '\\input{a}', 'x^^5c', '\\expandafter x']) {
      const outcome = await service.confirm(3, latex);
      expect(outcome).toMatchObject({ ok: false, reason: 'rejected' });
      expect(outcome.ok === false && outcome.message).toBe(fromIndex(latex, false));
    }
    expect(confirmEquation).not.toHaveBeenCalled();
  });

  it('passes an accepted source to the core, with the same verdict as the gate', async () => {
    const { stand, confirmEquation } = core(true);
    const service = mathEditorService(stand);
    expect(fromIndex('\\frac{a}{b}', true)).toBeNull();
    expect(await service.confirm(3, '\\frac{a}{b}')).toEqual({ ok: true, confirmed: true });
    expect(confirmEquation).toHaveBeenCalledWith(3, '\\frac{a}{b}');
  });

  it('gives the equation its display flag, and lets a test replace the gate', async () => {
    const gate = vi.fn(() => null);
    const { stand } = core(true);
    await mathEditorService(stand, { gate }).confirm(3, 'x');
    expect(gate).toHaveBeenCalledWith('x', true);
  });
});
