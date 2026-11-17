/**
 * The run-time part of the definition (`DEP1_WIRE`) must never drift from `DEP1`: the client
 * validates and negotiates with it, and the generated artifacts come from `DEP1`.
 */
import { describe, expect, it } from 'vitest';
import { DEP1 } from './index.ts';
import { DEP1_WIRE } from './wire.ts';

describe('the run-time part of the DEP definition', () => {
  it('holds the same version, engines, CDM range, shapes, messages and features as DEP1', () => {
    expect(DEP1_WIRE.version).toBe(DEP1.version);
    expect(DEP1_WIRE.engines).toEqual(DEP1.engines);
    expect(DEP1_WIRE.cdm).toEqual(DEP1.cdm);
    expect(DEP1_WIRE.shapes).toEqual(DEP1.shapes);
    expect(DEP1_WIRE.messages).toEqual(DEP1.messages);
    expect(DEP1_WIRE.features).toEqual(DEP1.features);
  });

  it('has no member that DEP1 lacks', () => {
    for (const key of Object.keys(DEP1_WIRE)) expect(DEP1).toHaveProperty(key);
  });
});
