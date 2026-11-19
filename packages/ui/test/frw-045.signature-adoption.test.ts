// The model of the adoption step (FRW-045): the default mode, what is missing, the text preview and
// the initials. Node.js only; the step itself is run in the browser (e2e/frw-045-adoption-step.spec.ts).
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import {
  adoptionFilename,
  DEFAULT_SIGNATURE_MODE,
  draftProblem,
  EMPTY_DRAFT,
  initialsOf,
  otherKind,
  SIGNATURE_MODES,
  typedPreview,
  UPLOAD_ACCEPT,
} from '../src/shell/signature-adoption.ts';

describe('the modes (FRW-045 criterion 1)', () => {
  it('offers typed first and by default, then drawn and uploaded', () => {
    expect(DEFAULT_SIGNATURE_MODE).toBe('typed');
    expect(SIGNATURE_MODES).toEqual(['typed', 'drawn', 'uploaded']);
    expect(EMPTY_DRAFT.mode).toBe('typed');
  });

  it('says what each mode still needs', () => {
    expect(draftProblem(EMPTY_DRAFT)).toBe('signature.problem.typed');
    expect(draftProblem({ ...EMPTY_DRAFT, typed: ' \n ' })).toBe('signature.problem.typed');
    expect(draftProblem({ ...EMPTY_DRAFT, typed: 'Ada' })).toBeNull();
    expect(draftProblem({ ...EMPTY_DRAFT, mode: 'drawn' })).toBe('signature.problem.drawn');
    expect(draftProblem({ ...EMPTY_DRAFT, mode: 'drawn', drawn: true })).toBeNull();
    expect(draftProblem({ ...EMPTY_DRAFT, mode: 'uploaded' })).toBe('signature.problem.file');
    expect(
      draftProblem({
        ...EMPTY_DRAFT,
        mode: 'uploaded',
        file: { name: 'a.gif', type: 'image/gif' },
      }),
    ).toBe('signature.problem.file');
    for (const type of UPLOAD_ACCEPT.split(','))
      expect(
        draftProblem({ ...EMPTY_DRAFT, mode: 'uploaded', file: { name: 'a', type } }),
      ).toBeNull();
  });

  it('has the words it names in the source table', () => {
    for (const key of [
      'signature.problem.typed',
      'signature.problem.drawn',
      'signature.problem.file',
    ] as const)
      expect(typeof EN_GB[key]).toBe('string');
    for (const m of SIGNATURE_MODES) expect(typeof EN_GB[`signature.mode.${m}`]).toBe('string');
  });
});

describe('the text of a typed signature (FRW-045 criterion 6)', () => {
  it('is the typed text with the white space tidied', () => {
    expect(typedPreview('  Ada \n  Lovelace\t')).toBe('Ada Lovelace');
    expect(typedPreview('   ')).toBe('');
  });
});

describe('initials are adopted on their own (FRW-045 criterion 4)', () => {
  it('suggests the first letters of the words of a name, in capitals', () => {
    expect(initialsOf('Ada King Lovelace')).toBe('AKL');
    expect(initialsOf('  ada   lovelace ')).toBe('AL');
    expect(initialsOf('')).toBe('');
    // A letter outside the basic plane is one letter, not half of a pair.
    expect(initialsOf('\u{1D4D0}da Lovelace')).toBe('\u{1D4D0}L');
    expect(initialsOf('a b c d e f')).toBe('ABCD');
  });

  it('names the other kind and a file for each', () => {
    expect(otherKind('signature')).toBe('initials');
    expect(otherKind('initials')).toBe('signature');
    expect(adoptionFilename('signature', 'typed', 'image/png')).toBe('signature-typed.png');
    expect(adoptionFilename('initials', 'uploaded', 'image/jpeg')).toBe('initials-uploaded.jpg');
  });
});
