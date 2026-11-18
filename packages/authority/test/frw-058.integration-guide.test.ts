import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_PHRASE,
  NATIVE_SIGNING_DESCRIPTION,
  findOverclaims,
} from '../src/workflow/language.ts';

const guidePath = fileURLToPath(
  new URL('../../../apps/reference-host/docs/integration-guide.md', import.meta.url),
);

/** The signing section of the integration guide (FRW-058 criteria 2 to 5). */
function signingSection(): string {
  const text = readFileSync(guidePath, 'utf8');
  const start = text.indexOf('## Signing and identity (FRW-058');
  const end = text.indexOf('## Keeping this guide current');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('FRW-058 signing language in the integration guide', () => {
  it('states the native seal in the words the criterion asks for', () => {
    // The guide says "The platform provides a ..." where the constant starts "A ...".
    expect(signingSection()).toContain(NATIVE_SIGNING_DESCRIPTION.slice(2));
  });

  it('names the SignatureProvider adapter and leaves validity to the operator', () => {
    const section = signingSection();
    expect(section).toContain('SignatureProvider');
    expect(section).toContain('the document hash');
    expect(section).toMatch(/legal question for the operator and its customers/);
  });

  it('addresses intent, consent and retention under ESIGN and UETA without claiming validity', () => {
    const section = signingSection();
    expect(section).toContain('ESIGN');
    expect(section).toContain('UETA');
    expect(section).toMatch(/intent, consent and retention/);
    expect(section).toMatch(/does not claim that any signature is valid/);
  });

  it('describes authentication as asserted by the host and never as verified', () => {
    const section = signingSection();
    expect(section).toContain(AUTHENTICATION_PHRASE);
    expect(section.toLowerCase()).not.toMatch(/verified (identity|participant|signer|user)/);
    expect(section.toLowerCase()).not.toMatch(/(identity|participant|signer) (is )?verified/);
  });

  it('contains no over-claiming phrase from the maintained list', () => {
    expect(findOverclaims(signingSection())).toEqual([]);
  });
});
