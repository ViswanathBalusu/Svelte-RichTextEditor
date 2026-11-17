/**
 * The math editor's port over the core (FE-070; `math-editor.ts`): the visual field's module is
 * not asked for until `mount`, a limit and a refusal come back as the shell's reasons, and the
 * service passes the host's font directory to the field. The core is a stand-in that records what
 * it was asked; the real core is exercised in packages/engine/test/fe-070-math-editor.test.ts and
 * the real field in e2e/fe-070-math-editor.spec.ts.
 */
import type { EditorCore } from '@docedit/engine';
import { describe, expect, it, vi } from 'vitest';
import { mathEditorService } from '../src/math-editor.ts';

function core(confirm: (pos: number, latex: string) => Promise<unknown>): EditorCore {
  const listeners = new Set<() => void>();
  let selected: { pos: number; latex: string; display: boolean } | null = null;
  return {
    equationRequest: { get: () => null, subscribe: () => () => undefined },
    revision: {
      get: () => 0,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    selectedEquation: () => selected,
    requestEquationEdit: () => selected !== null,
    selectEquation: (pos: number) => {
      selected = { pos, latex: 'x', display: false };
      return true;
    },
    equationAccess: () => ({ canEdit: true }),
    equationLimits: { length: 4000, depth: 50 },
    checkEquationSource: (latex: string) => (latex.length > 4000 ? 'too-long' : null),
    confirmEquation: confirm,
  } as unknown as EditorCore;
}

describe('the math editor service (FE-070)', () => {
  it('asks for the visual field only when it is mounted, and tells it the font directory', async () => {
    const mountMathField = vi.fn(async () => ({
      value: 'x',
      setValue: () => undefined,
      focus: () => undefined,
      destroy: () => undefined,
    }));
    const load = vi.fn(async () => ({ mountMathField }));
    const service = mathEditorService(
      core(async () => ({ ok: true, confirmed: true })),
      {
        fontsUrl: 'https://fonts.example/math/',
        load,
      },
    );
    expect(service.limits).toEqual({ length: 4000, depth: 50 });
    expect(service.check('x'.repeat(4001))).toBe('too-long');
    expect(service.access(0)).toEqual({ canEdit: true });
    expect(load).not.toHaveBeenCalled();

    const container = {} as HTMLElement;
    const options = {
      latex: 'x',
      readOnly: false,
      label: 'Equation editor',
      onInput: () => undefined,
      onEscape: () => undefined,
    };
    await service.mount(container, options);
    expect(load).toHaveBeenCalledTimes(1);
    expect(mountMathField).toHaveBeenCalledWith(container, options, {
      fontsUrl: 'https://fonts.example/math/',
    });
  });

  it('reports a failed load of the field as a rejection, so the dialog falls back to the source', async () => {
    const service = mathEditorService(
      core(async () => ({ ok: true, confirmed: true })),
      {
        load: () => Promise.reject(new Error('offline')),
      },
    );
    await expect(
      service.mount({} as HTMLElement, {
        latex: '',
        readOnly: false,
        label: '',
        onInput: () => undefined,
        onEscape: () => undefined,
      }),
    ).rejects.toThrow('offline');
  });

  it('turns the core answers into the shell reasons', async () => {
    const answers: unknown[] = [
      { ok: true, confirmed: false },
      { ok: false, reason: 'too-deep' },
      { ok: false, reason: 'rejected', message: 'not allowed' },
      { ok: false, reason: 'no-access' },
      { ok: false, reason: 'suggestion' },
    ];
    const service = mathEditorService(core(async () => answers.shift()));
    expect(await service.confirm(1, 'x')).toEqual({ ok: true, confirmed: false });
    expect(await service.confirm(1, 'x')).toEqual({ ok: false, reason: 'too-deep' });
    expect(await service.confirm(1, 'x')).toEqual({
      ok: false,
      reason: 'rejected',
      message: 'not allowed',
    });
    expect(await service.confirm(1, 'x')).toEqual({ ok: false, reason: 'refused' });
    expect(await service.confirm(1, 'x')).toEqual({ ok: false, reason: 'suggestion' });
  });

  it('keeps the selected equation stable while it does not change', () => {
    const c = core(async () => ({ ok: true, confirmed: true }));
    const service = mathEditorService(c);
    expect(service.selected.get()).toBeNull();
    service.select(5);
    const first = service.selected.get();
    expect(first).toEqual({ pos: 5, latex: 'x', display: false });
    expect(service.selected.get()).toBe(first);
  });
});
