// FRW-069: the field members of the embedding API, over a session with no mounted editor and over
// a headless core, in Node.js. The element's methods are one line over `elementMethods`, so this is
// the path from the element to the core without a DOM. The real element, its focus and its
// attribute are in e2e/frw-069-fill-api.spec.ts.
import { DocumentCore } from '@docedit/engine/headless';
import { spikeDocument } from '@docedit/engine/testing';
import { describe, expect, it } from 'vitest';
import { NOT_LOADED_FILL, elementMethods, hostApi } from '../src/host-api.ts';

describe('with no document loaded (the lifecycle rules of 05 §8.1)', () => {
  const methods = elementMethods(() => null);

  it('answers that nothing applies, and throws nothing', async () => {
    expect(methods.nextField()).toBe(false);
    expect(methods.focusField('tenant.name')).toBe(false);
    expect(methods.getFieldValues()).toEqual({});
    expect(methods.validateFields()).toEqual([]);
    expect(await methods.setFieldValue('tenant.name', 'Ada')).toEqual(NOT_LOADED_FILL);
    expect(NOT_LOADED_FILL).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('over a core that has no view and a document with no fields', () => {
  const api = hostApi(
    new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) }),
  );

  it('moves no focus, finds no value and no key, and reports no field', async () => {
    expect(api.nextField()).toBe(false);
    expect(api.focusField('tenant.name')).toBe(false);
    expect(api.getFieldValues()).toEqual({});
    expect(api.validateFields()).toEqual([]);
    expect(await api.setFieldValue('tenant.name', 'Ada')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
