// PRO-073 criterion 4: when the review and job webhooks are delivered, the document service sends no
// e-mail or text message. This is a guard, not a proof of behaviour: it checks that the service's
// declared dependencies and its own source import no mail or SMS client, and that no source string
// names an SMTP or sendmail endpoint. A new mail path would have to pass through these checks.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(SERVICE_ROOT, 'src');

/** Module names of e-mail and SMS senders, and the transports they use. */
const MESSAGING = new RegExp(
  '^(nodemailer|sendgrid|@sendgrid/|twilio|mailgun|mailgun-js|postmark|mailchimp|mailparser|' +
    'smtp-|smtp$|@aws-sdk/client-ses|@aws-sdk/client-sesv2|@aws-sdk/client-sns|' +
    '@azure/communication-email|@azure/communication-sms|nexmo|vonage|messagebird)',
  'i',
);
/** Endpoints that send mail: an SMTP or sendmail address written into the source. */
const MAIL_URL = /\b(smtps?:\/\/|sendmail\b)/i;

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(SRC, f));
}

/** The module specifiers a source file imports, re-exports, requires or loads dynamically. */
function specifiersOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g))
    out.push(m[1]!);
  return out;
}

function dependencyNames(): string[] {
  const pkg = JSON.parse(readFileSync(join(SERVICE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
}

describe('PRO-073 criterion 4: delivering the webhooks sends no e-mail or text message', () => {
  it('scans a non-empty set of source files, so that the checks below mean something', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => relative(SRC, f) === join('control-plane', 'events.ts'))).toBe(true);
  });

  it('declares no mail or SMS client as a dependency', () => {
    const offending = dependencyNames().filter((n) => MESSAGING.test(n));
    expect(offending).toEqual([]);
  });

  it('imports no mail or SMS module from its source', () => {
    const offending: string[] = [];
    for (const file of sourceFiles()) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (MESSAGING.test(spec)) offending.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it('names no SMTP or sendmail endpoint in its source', () => {
    const offending = sourceFiles().filter((f) => MAIL_URL.test(readFileSync(f, 'utf8')));
    expect(offending.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('would catch a mail client if one were imported (the check is not vacuous)', () => {
    expect(MESSAGING.test('nodemailer')).toBe(true);
    expect(MESSAGING.test('@sendgrid/mail')).toBe(true);
    expect(MESSAGING.test('@aws-sdk/client-ses')).toBe(true);
    expect(MESSAGING.test('node:http')).toBe(false);
    expect(MESSAGING.test('pg')).toBe(false);
    expect(MAIL_URL.test("const h = 'smtp://mail.example.test:25'")).toBe(true);
    expect(MAIL_URL.test("const h = 'https://hooks.example.test/a'")).toBe(false);
  });
});
