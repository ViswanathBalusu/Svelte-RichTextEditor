// The pattern subset (FRW-018; ADR 0030 §5) against the ECMAScript engine as an oracle: for
// patterns built from the subset's grammar, the linear-time matcher and `new RegExp('^(?:' + p +
// ')$', 'su')` agree on every value. The oracle only checks the tests; the matcher never calls it.
// The oracle backtracks, so nested quantifiers take it exponential time: groups nest at most two
// deep here and values are at most six characters long.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compilePattern, matchPattern } from '../src/pattern.ts';

// A small alphabet where the subset's ASCII classes and ECMAScript's agree (no non-ASCII space).
const ALPHABET = ['a', 'b', 'c', '1', '7', ' ', '\n', '-', 'é', '\u{1F600}'];

const atom = fc.letrec<{ alt: string; atom: string }>((tie) => ({
  atom: fc.oneof(
    { depthSize: 'small', maxDepth: 2 },
    fc.constantFrom('a', 'b', 'c', '1', ' ', 'é', '\u{1F600}', '\\.', '\\n', '\\u00e9', '\\x61'),
    fc.constantFrom('.', '\\d', '\\D', '\\w', '\\W', '\\s', '\\S'),
    fc.constantFrom(
      '[ab]',
      '[^a]',
      '[a-c]',
      '[0-9a]',
      '[\\d ]',
      '[^\\w]',
      '[-a]',
      '[a-]',
      '[é\u{1F600}]',
      '[]',
      '[^]',
    ),
    tie('alt').map((a) => `(${a})`),
    tie('alt').map((a) => `(?:${a})`),
  ),
  alt: fc
    .array(
      fc
        .array(
          fc.tuple(
            tie('atom'),
            fc.constantFrom('', '', '*', '+', '?', '{2}', '{0,2}', '{1,}', '*?', '+?'),
          ),
          { maxLength: 4 },
        )
        .map((items) => items.map(([a, q]) => a + q).join('')),
      { minLength: 1, maxLength: 3 },
    )
    .map((alts) => alts.join('|')),
}));

const input = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 6 }).map((cs) => cs.join(''));

describe('the pattern subset', () => {
  it('matches exactly as an anchored ECMAScript regular expression would', () => {
    fc.assert(
      fc.property(atom.alt, fc.array(input, { minLength: 1, maxLength: 6 }), (source, values) => {
        const r = compilePattern(source);
        // Generated patterns can exceed the length or size limits; those are refused, not wrong.
        fc.pre(r.ok || r.problem.code !== 'pattern_limit');
        if (!r.ok) throw new Error(`${source}: ${r.problem.message}`);
        const oracle = new RegExp(`^(?:${source})$`, 'su');
        for (const v of values)
          expect(
            matchPattern(r.pattern, v).matched,
            `${JSON.stringify(source)} on ${JSON.stringify(v)}`,
          ).toBe(oracle.test(v));
      }),
      { numRuns: 2000 },
    );
  });

  it('never accepts a pattern the ECMAScript engine refuses, and then agrees with it', () => {
    // Random strings over syntax characters; `\-` outside a class is left out on purpose: the
    // subset reads it as a hyphen, while ECMAScript's Unicode mode refuses it.
    const chars = [
      'a',
      'b',
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      '|',
      '*',
      '+',
      '?',
      '.',
      '^',
      '$',
      '\\',
      'd',
      ',',
      '0',
      '2',
      ':',
      '=',
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...chars), { maxLength: 8 }).map((c) => c.join('')),
        (source) => {
          const r = compilePattern(source);
          if (!r.ok) return;
          let oracle: RegExp;
          try {
            oracle = new RegExp(`^(?:${source})$`, 'su');
          } catch (e) {
            throw new Error(`accepted ${JSON.stringify(source)}, which ECMAScript refuses`, {
              cause: e,
            });
          }
          for (const v of ['', 'a', 'ab', 'aab', 'b', '1', '{', 'd', 'a{2}'])
            expect(
              matchPattern(r.pattern, v).matched,
              `${JSON.stringify(source)} on ${JSON.stringify(v)}`,
            ).toBe(oracle.test(v));
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('never throws on any pattern text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 20 }), (source, value) => {
        const r = compilePattern(source);
        if (r.ok) expect(typeof matchPattern(r.pattern, value).matched).toBe('boolean');
        else expect(r.problem.message.length).toBeGreaterThan(0);
      }),
      { numRuns: 3000 },
    );
  });
});
