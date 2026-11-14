/**
 * Fixtures for the static checks of an entry (FRW-003, FRW-004; ADR 0030 §8): the type of each
 * kind's value, `required` and empty values, the limits of `validation`, and the presets.
 */
import type { FixtureCase } from '../conformance.ts';
import { PRESETS } from '../fields.ts';
import { check, choice, date, formula, num, text, value } from './build.ts';

const SIGNED = { asset: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d', mode: 'typed' };
const TEXT = text('t');
const NUMBER = num('n');
const DATE = date('d');
const CHOICE = choice('status', ['single', 'married']);
const EMAIL = text('email', { validation: { preset: 'email' } });
const PHONE = text('phone', { validation: { preset: 'phone' } });
const POSTCODE = text('postcode', { validation: { preset: 'postcode' } });
const MONEY = num('amount', { validation: { min: '0', max: '1000000' } });

export const valueCases: FixtureCase[] = [
  value('value.text', TEXT, 'hello', []),
  value('value.text.not-a-string', TEXT, 5, ['type']),
  value('value.text.4-kib', TEXT, 'x'.repeat(4096), []),
  value('value.text.over-4-kib', TEXT, 'x'.repeat(4097), ['too_large']),
  value('value.text.over-4-kib-in-utf-8', TEXT, 'é'.repeat(2049), ['too_large']),
  value('value.number', NUMBER, '12.50', []),
  value('value.number.json-number', NUMBER, 12.5, ['type']),
  value('value.number.json-integer', NUMBER, 12, ['type']),
  value('value.number.exponent', NUMBER, '1e3', ['type']),
  value('value.number.plus-sign', NUMBER, '+1', ['type']),
  value('value.number.leading-zero', NUMBER, '01', ['type']),
  value('value.number.bare-point', NUMBER, '.5', ['type']),
  value('value.number.comma', NUMBER, '12,50', ['type']),
  value('value.date', DATE, '2024-02-29', []),
  value('value.date.not-a-leap-year', DATE, '2026-02-29', ['type']),
  value('value.date.date-time', DATE, '2026-11-06T10:00:00Z', ['type']),
  value('value.date.other-format', DATE, '06/11/2026', ['type']),
  value('value.checkbox', check('c'), true, []),
  value('value.checkbox.string', check('c'), 'true', ['type']),
  value('value.choice', CHOICE, 'married', []),
  value('value.choice.not-an-option', CHOICE, 'divorced', ['not_an_option']),
  value('value.signature', { key: 's', kind: 'signature' }, SIGNED, []),
  value('value.signature.mode', { key: 's', kind: 'signature' }, { ...SIGNED, mode: 'stamped' }, [
    'type',
  ]),
  value('value.signature.extra-member', { key: 's', kind: 'initials' }, { ...SIGNED, by: 'me' }, [
    'type',
  ]),
  value('value.date-signed', { key: 'ds', kind: 'dateSigned' }, '2026-11-06', []),
  value('value.formula.decimal', formula('fx'), '12.5', []),
  value('value.formula.string', formula('fx'), 'twelve', []),
  value('value.formula.json-number', formula('fx'), 12, ['type']),
  value('value.attachment', { key: 'a', kind: 'attachment' }, 'file', ['reserved_kind']),
  value('value.null-is-empty', TEXT, null, []),
  value('value.required.null', text('t', { required: true }), null, ['required'], ['required']),
  value(
    'value.required.empty-string',
    text('t', { required: true }),
    '',
    ['required'],
    ['required'],
  ),
  value('value.required.space-is-content', text('t', { required: true }), ' ', [], ['required']),
  value(
    'value.required.unticked-checkbox',
    check('c', { required: true }),
    false,
    ['required'],
    ['required'],
  ),
  value('value.required.ticked-checkbox', check('c', { required: true }), true, [], ['required']),
  value('value.required.zero', num('n', { required: true }), '0', [], ['required']),
  value('value.min', MONEY, '-1', ['min']),
  value('value.min.equal', MONEY, '0', []),
  value('value.max', MONEY, '1000000.01', ['max']),
  value('value.max.equal', MONEY, '1000000', []),
  value('value.min.compared-as-decimals', num('n', { validation: { min: '0.5' } }), '0.50', []),
  value('value.min-length', text('t', { validation: { minLength: 3 } }), 'ab', ['min_length']),
  value(
    'value.max-length.code-points',
    text('t', { validation: { maxLength: 2 } }),
    '\u{1F600}\u{1F600}',
    [],
  ),
  value(
    'value.max-length.code-points.over',
    text('t', { validation: { maxLength: 2 } }),
    '\u{1F600}\u{1F600}\u{1F600}',
    ['max_length'],
  ),
  value('value.pattern', text('t', { validation: { pattern: '[A-Z]{2}-[0-9]{2}' } }), 'AB-12', []),
  value(
    'value.pattern.refuses',
    text('t', { validation: { pattern: '[A-Z]{2}-[0-9]{2}' } }),
    'ab-12',
    ['pattern'],
  ),
  value(
    'value.pattern.empty-entry',
    text('t', { validation: { pattern: '[A-Z]{2}-[0-9]{2}' } }),
    '',
    [],
  ),
  value('value.type-before-limits', MONEY, 'abc', ['type']),
  value('value.preset.email', EMAIL, 'jane.doe@example.com', [], ['preset']),
  value('value.preset.email.dotless-domain', EMAIL, 'jane@localhost', [], ['preset']),
  value('value.preset.email.no-domain', EMAIL, 'jane@', ['preset'], ['preset']),
  value('value.preset.email.space', EMAIL, 'jane doe@example.com', ['preset'], ['preset']),
  value('value.preset.phone', PHONE, '+49 30 1234567', [], ['preset']),
  value('value.preset.phone.area-code', PHONE, '(030) 1234567', [], ['preset']),
  value('value.preset.phone.separators', PHONE, '+1 (555) 123-4567', [], ['preset']),
  value('value.preset.phone.too-short', PHONE, '12', ['preset'], ['preset']),
  value('value.preset.phone.letters', PHONE, 'phone', ['preset'], ['preset']),
  value('value.preset.postcode.uk', POSTCODE, 'SW1A 1AA', [], ['preset']),
  value('value.preset.postcode.de', POSTCODE, '10115', [], ['preset']),
  value('value.preset.postcode.us-zip-4', POSTCODE, '12345-6789', [], ['preset']),
  value('value.preset.postcode.one-character', POSTCODE, '1', ['preset'], ['preset']),
  value('value.preset.postcode.underscore', POSTCODE, 'AB_12', ['preset'], ['preset']),
];

/** The preset definitions are published with the fixtures (FRW-004). */
export { PRESETS };
