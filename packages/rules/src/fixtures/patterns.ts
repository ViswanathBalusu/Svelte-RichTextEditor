/**
 * Fixtures for the pattern subset (FRW-018; ADR 0030 §5): what it accepts and how it matches (the
 * whole value, by code point, case-sensitive, ASCII classes), and every construct it refuses, by
 * the stable name of the construct.
 */
import type { FixtureCase, ProblemExpect } from '../conformance.ts';
import { pattern } from './build.ts';

const yes = { matches: true };
const no = { matches: false };
const refused = (code: ProblemExpect['code'], construct: string) => ({
  problems: [{ code, path: '', construct }],
});
const unsupported = (construct: string) => refused('pattern_unsupported', construct);
const syntax = (construct: string) => refused('pattern_syntax', construct);
const limit = (construct: string) => refused('pattern_limit', construct);
const PATHOLOGICAL = ['pathological'];

export const patternCases: FixtureCase[] = [
  pattern('pattern.literal', 'abc', 'abc', yes),
  pattern('pattern.whole-value', 'abc', 'abcd', no),
  pattern('pattern.whole-value.prefix', 'abc', 'xabc', no),
  pattern('pattern.class', '[a-c]+', 'abcabc', yes),
  pattern('pattern.class.negated', '[^0-9]+', 'abc', yes),
  pattern('pattern.class.negated.refuses', '[^0-9]+', 'ab1', no),
  pattern('pattern.digits', '\\d{3}-\\d{4}', '555-1234', yes),
  pattern('pattern.alternation', 'cat|dog', 'dog', yes),
  pattern('pattern.alternation.refuses', 'cat|dog', 'cow', no),
  pattern('pattern.optional', 'colou?r', 'color', yes),
  pattern('pattern.counted', 'a{2,3}', 'aaa', yes),
  pattern('pattern.counted.too-many', 'a{2,3}', 'aaaa', no),
  pattern('pattern.counted.at-least', 'a{2,}', 'aaaaaa', yes),
  pattern('pattern.dot-matches-line-feed', 'a.b', 'a\nb', yes),
  pattern('pattern.dot-is-one-code-point', '.', '\u{1F600}', yes),
  pattern('pattern.class-of-astral-characters', '[\u{1F600}-\u{1F602}]', '\u{1F601}', yes),
  pattern('pattern.anchors-are-allowed', '^\\d+$', '123', yes),
  pattern('pattern.anchor-in-the-middle', 'a^b', 'ab', no),
  pattern('pattern.escaped-dot', '\\.', '.', yes),
  pattern('pattern.escaped-dot.refuses', '\\.', 'a', no),
  pattern('pattern.unicode-escape', '\\u00e9', 'é', yes),
  pattern('pattern.code-point-escape', '\\u{1F600}', '\u{1F600}', yes),
  pattern('pattern.hex-escape', '\\x41', 'A', yes),
  pattern('pattern.lazy-quantifier', 'a+?', 'aaa', yes),
  pattern('pattern.empty', '', '', yes),
  pattern('pattern.empty.refuses', '', 'a', no),
  pattern('pattern.empty-class', '[]', 'a', no),
  pattern('pattern.any-class', '[^]', 'x', yes),
  pattern('pattern.case-sensitive', 'abc', 'ABC', no),
  pattern('pattern.space-is-ascii', '\\s', ' ', no),
  pattern('pattern.space-tab', '\\s', '\t', yes),
  pattern('pattern.word-is-ascii', '\\w+', 'é', no),
  pattern('pattern.class-dash', '[a-]', '-', yes),
  pattern('pattern.class-bracket', '[[]', '[', yes),
  pattern('pattern.group', '(?:ab)+', 'ababab', yes),
  pattern('pattern.capturing-group-is-a-group', '(ab)+', 'abab', yes),
  pattern('pattern.nested-empty-loop', '(a*)*b', 'aaab', yes),
  pattern('pattern.pathological.nested-plus', '(a+)+b', 'a'.repeat(64), no, PATHOLOGICAL),
  pattern('pattern.pathological.alternation', '(a|aa)*c', 'a'.repeat(64), no, PATHOLOGICAL),
  pattern(
    'pattern.pathological.dot-star',
    '(.*a){10}',
    'a'.repeat(9) + 'b'.repeat(55),
    no,
    PATHOLOGICAL,
  ),

  pattern('pattern.back-reference', '(a)\\1', undefined, unsupported('back-reference')),
  pattern('pattern.named-back-reference', '(a)\\k<x>', undefined, unsupported('back-reference')),
  pattern('pattern.look-ahead', '(?=a)a', undefined, unsupported('look-ahead')),
  pattern('pattern.negative-look-ahead', '(?!a)b', undefined, unsupported('look-ahead')),
  pattern('pattern.look-behind', '(?<=a)b', undefined, unsupported('look-behind')),
  pattern('pattern.negative-look-behind', '(?<!a)b', undefined, unsupported('look-behind')),
  pattern('pattern.named-group', '(?<year>\\d{4})', undefined, unsupported('named group')),
  pattern('pattern.flags', '(?i)abc', undefined, unsupported('group modifier')),
  pattern('pattern.word-boundary', '\\bword\\b', undefined, unsupported('word boundary')),
  pattern('pattern.property-escape', '\\p{L}+', undefined, unsupported('unicode property escape')),
  pattern('pattern.control-escape', '\\cA', undefined, unsupported('control escape')),
  pattern('pattern.unknown-escape', '\\e', undefined, unsupported('escape')),
  pattern('pattern.nul-escape', '\\0', undefined, unsupported('escape')),
  pattern('pattern.possessive', 'a*+', undefined, unsupported('quantifier after quantifier')),
  pattern(
    'pattern.quantifier-twice',
    'a{2}{3}',
    undefined,
    unsupported('quantifier after quantifier'),
  ),
  pattern('pattern.nothing-to-repeat', '*a', undefined, syntax('nothing to repeat')),
  pattern('pattern.anchor-repeated', '^*', undefined, syntax('nothing to repeat')),
  pattern('pattern.lone-brace', 'a{', undefined, syntax('lone brace')),
  pattern('pattern.lone-closing-brace', 'a}', undefined, syntax('lone brace')),
  pattern('pattern.lone-bracket', 'a]', undefined, syntax('lone bracket')),
  pattern('pattern.unterminated-class', '[a', undefined, syntax('unterminated class')),
  pattern('pattern.missing-parenthesis', '(a', undefined, syntax('missing parenthesis')),
  pattern('pattern.unmatched-parenthesis', 'a)', undefined, syntax('unmatched parenthesis')),
  pattern('pattern.range-order', '[z-a]', undefined, syntax('range order')),
  pattern('pattern.class-escape-in-range', '[\\d-z]', undefined, syntax('class escape in range')),
  pattern('pattern.quantifier-order', 'a{3,1}', undefined, syntax('quantifier order')),
  pattern('pattern.trailing-backslash', 'abc\\', undefined, syntax('trailing backslash')),
  pattern('pattern.repetition-limit', 'a{101}', undefined, limit('repetition count')),
  pattern('pattern.length-limit', 'a'.repeat(257), undefined, limit('pattern length')),
  pattern('pattern.program-limit', '(?:a{100}){11}', undefined, limit('program size')),
];
