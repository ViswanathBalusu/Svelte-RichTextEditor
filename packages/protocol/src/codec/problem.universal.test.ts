// The registry as the wire carries it (PRO-038 criteria 2 and 3; PRO-028 criterion 4): every
// problem code is a registry code on the surface it names, the retry hints of rate and quota
// problems are present, and a field_invalid rejection names its rule. Universal: Node.js and browsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEP1 } from '../definition/index.ts';
import { CHANNEL_REJECT_CODES, ERRORS, ERROR_CODES } from '../definition/errors.ts';
import { depCodec } from './frame.ts';
import { checkProblem, type ProblemSurface } from './problem.ts';
import { ShapeValidator } from './validate.ts';

const UUID = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const SURFACES_OF_ERRORS: ProblemSurface[] = ['socket', 'rest', 'sync', 'channel-close'];

describe('checkProblem: the registry codes and their surfaces (PRO-038 criterion 2)', () => {
  it('accepts every registry code on each surface the registry lists for it', () => {
    for (const def of ERRORS)
      for (const surface of def.surfaces)
        expect(
          checkProblem({
            surface,
            code: def.code,
            retryAfterMs: 1000,
            retryAfterHeader: '1',
            rule: 'rule.x',
          }),
        ).toEqual([]);
  });

  it('accepts every ch.rejected code', () => {
    for (const code of CHANNEL_REJECT_CODES)
      expect(checkProblem({ surface: 'channel-reject', code })).toEqual([]);
  });

  it('refuses a code outside the registry on every surface (property)', () => {
    const outside = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => !ERROR_CODES.includes(s));
    fc.assert(
      fc.property(outside, fc.constantFrom(...SURFACES_OF_ERRORS), (code, surface) => {
        const v = checkProblem({ surface, code, retryAfterMs: 1, retryAfterHeader: '1' });
        expect(v.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('refuses a registry code on a surface it does not appear on', () => {
    // unauthenticated is socket and REST only; it cannot be a sync.reject or a channel close.
    expect(checkProblem({ surface: 'sync', code: 'unauthenticated' }).length).toBeGreaterThan(0);
    expect(checkProblem({ surface: 'channel-close', code: 'bad_message' }).length).toBeGreaterThan(
      0,
    );
    // slow_consumer is a channel-close code only.
    expect(checkProblem({ surface: 'socket', code: 'slow_consumer' }).length).toBeGreaterThan(0);
  });

  it('refuses a code of the registry that ch.rejected does not list', () => {
    expect(checkProblem({ surface: 'channel-reject', code: 'slow_consumer' }).length).toBe(1);
    expect(checkProblem({ surface: 'channel-reject', code: 42 }).length).toBe(1);
  });
});

describe('checkProblem: retry hints (PRO-038 criterion 3)', () => {
  it('needs retryAfterMs on the socket and on sync.reject for rate_limited and quota_exceeded', () => {
    for (const code of ['rate_limited', 'quota_exceeded'])
      for (const surface of ['socket', 'sync'] as const) {
        expect(checkProblem({ surface, code }).map((v) => v.path)).toEqual(['/retryAfterMs']);
        expect(checkProblem({ surface, code, retryAfterMs: 500 })).toEqual([]);
        expect(checkProblem({ surface, code, retryAfterMs: -1 }).length).toBe(1);
        expect(checkProblem({ surface, code, retryAfterMs: 1.5 }).length).toBe(1);
      }
  });

  it('needs Retry-After on REST for rate_limited and quota_exceeded', () => {
    for (const code of ['rate_limited', 'quota_exceeded']) {
      expect(checkProblem({ surface: 'rest', code }).map((v) => v.path)).toEqual(['/Retry-After']);
      expect(checkProblem({ surface: 'rest', code, retryAfterHeader: '30' })).toEqual([]);
      expect(checkProblem({ surface: 'rest', code, retryAfterHeader: 30 })).toEqual([]);
      expect(checkProblem({ surface: 'rest', code, retryAfterHeader: '' }).length).toBe(1);
    }
  });

  it('does not ask for a hint on codes that have none', () => {
    expect(checkProblem({ surface: 'sync', code: 'busy' })).toEqual([]);
    expect(checkProblem({ surface: 'rest', code: 'not_found' })).toEqual([]);
  });
});

describe('checkProblem: field_invalid names its rule (PRO-028 criterion 4)', () => {
  it('needs a non-empty rule on sync.reject', () => {
    expect(checkProblem({ surface: 'sync', code: 'field_invalid' }).map((v) => v.path)).toEqual([
      '/rule',
    ]);
    expect(checkProblem({ surface: 'sync', code: 'field_invalid', rule: '' }).length).toBe(1);
    expect(checkProblem({ surface: 'sync', code: 'field_invalid', rule: 'FRW-025.name' })).toEqual(
      [],
    );
  });
});

describe('the wire carries the same registry (PRO-038 criterion 2)', () => {
  const codec = depCodec();
  const validator = new ShapeValidator(DEP1);

  it('refuses an error message whose code is outside the registry', () => {
    const v = codec.check(
      { t: 'error', d: { code: 'made_up', message: 'x', retryable: false, fatal: false } },
      'server',
    );
    expect(v.some((x) => x.path === '/d/code')).toBe(true);
  });

  it('accepts an error message whose code is in the registry', () => {
    const v = codec.check(
      { t: 'error', d: { code: 'bad_message', message: 'x', retryable: false, fatal: true } },
      'server',
    );
    expect(v).toEqual([]);
  });

  it('refuses a sync.reject whose code is outside the registry', () => {
    const v = codec.check(
      {
        t: 'sync.reject',
        ch: 1,
        re: UUID,
        d: { id: UUID, code: 'made_up', message: 'x', action: 'drop', head: 1 },
      },
      'server',
    );
    expect(v.some((x) => x.path === '/d/code')).toBe(true);
  });

  it('refuses a ch.closed whose code is not on the channel-close surface', () => {
    const v = codec.check({ t: 'ch.closed', ch: 1, d: { code: 'bad_message' } }, 'server');
    expect(v.some((x) => x.path === '/d/code')).toBe(true);
  });

  it('refuses a ch.rejected whose code is not in the ch.rejected list', () => {
    const v = codec.check(
      { t: 'ch.rejected', ch: 1, re: UUID, d: { code: 'busy', message: 'x' } },
      'server',
    );
    expect(v.some((x) => x.path === '/d/code')).toBe(true);
  });

  it('refuses a REST problem whose code is outside the registry', () => {
    const v = validator.checkNamed('ProblemDetails', {
      type: 'about:blank',
      title: 'x',
      status: 400,
      code: 'made_up',
    });
    expect(v.some((x) => x.path === '/code')).toBe(true);
    const ok = validator.checkNamed('ProblemDetails', {
      type: 'about:blank',
      title: 'x',
      status: 429,
      code: 'rate_limited',
    });
    expect(ok).toEqual([]);
  });
});
