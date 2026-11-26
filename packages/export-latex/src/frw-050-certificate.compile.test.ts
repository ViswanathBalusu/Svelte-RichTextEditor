/**
 * FRW-050 criteria 4 and 6 (Node.js, sandbox and veraPDF in Podman): the certificate pages are
 * compiled to a real PDF.
 *
 * Criterion 4: a participant name, a label and a user-agent string full of TeX control sequences
 * and markup compile, and `pdftotext` reads them back literally from the certificate pages.
 * Criterion 6: the PDF with the certificate pages is tagged and passes veraPDF as PDF/UA-2 and
 * PDF/A-4f, the same checks as the body alone (EXP-111), and the structure tree holds the
 * certificate's text. The tests skip when `sandboxReady()` reports that sandboxed compiles cannot
 * run here (EXP-070).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, para } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady, validatePdf } from '../test/harness.ts';
import type { CertificateFacts } from './certificate.ts';

const ready = (await sandboxReady()).ok;

const HASH = 'ab'.repeat(32);
const INSTANT = '2026-11-06T10:00:00.000Z';

const HOSTILE_NAME = String.raw`Ada \textbackslash \end{document} $x^2$ 50% & #1 _a_ ~b~ {c}`;
const HOSTILE_AGENT = String.raw`Agent/1.0 \input{/etc/passwd} <b>bold</b> \write18{id} ^^41`;

function facts(): CertificateFacts {
  return {
    documentId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01',
    workflowId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02',
    sentSeq: 12,
    completedSeq: 40,
    chainHeadHash: HASH,
    participants: [
      {
        id: 'p1',
        label: HOSTILE_NAME,
        events: [
          {
            kind: 'viewed',
            serverTimeMs: Date.UTC(2026, 10, 6, 10, 0, 0),
            ipAddress: '203.0.113.7',
            userAgent: HOSTILE_AGENT,
          },
          { kind: 'consent', serverTimeMs: Date.UTC(2026, 10, 6, 10, 1, 0) },
          { kind: 'signed', serverTimeMs: Date.UTC(2026, 10, 6, 10, 2, 0) },
          { kind: 'completed', serverTimeMs: Date.UTC(2026, 10, 6, 10, 3, 0) },
        ],
      },
    ],
    networkIdentityIncluded: true,
    statement: ['Authentication is shown as asserted by the host.'],
  };
}

const body = () => doc([para('Body paragraph one.'), para('Body paragraph two.')]);

async function compile(name: string, options: Record<string, unknown>) {
  const c = await convertAndCompile(body(), {
    profile: 'final',
    title: name,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    fields: 'flatten',
    certificate: facts(),
    ...options,
  } as never);
  if (!c.compile.ok || !c.compile.pdf) {
    throw new Error(`the compile of ${name} failed:\n${c.compile.log.slice(-1500)}`);
  }
  return c.compile.pdf;
}

/** Every Flate stream inflated, beside the file's own bytes, as latin1 text. */
function asText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  let at = 0;
  for (;;) {
    const s = raw.indexOf('stream', at);
    if (s < 0) break;
    const end = raw.indexOf('endstream', s);
    if (end < 0) break;
    let start = s + 'stream'.length;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    try {
      parts.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a Flate stream.
    }
    at = end + 'endstream'.length;
  }
  return parts.join('\n');
}

const squash = (s: string): string => s.replace(/\s+/g, ' ');

describe.skipIf(!ready)(
  'FRW-050 criterion 4: hostile evidence strings are printed literally',
  () => {
    it('compiles, and the certificate pages show the name and the agent as typed', async () => {
      const pdf = await compile('frw-050-hostile', { tagging: 'on', pdfStandard: 'none' });
      const text = pdfText(pdf, '-raw');
      expect(text, 'pdftotext read the PDF').not.toBeNull();
      const t = squash(text!);
      expect(t).toContain('Certificate of completion');
      expect(t).toContain(squash(HOSTILE_NAME));
      expect(t).toContain(squash(HOSTILE_AGENT));
      // The body comes first and is unchanged; the hostile text did not end the document early.
      expect(t.indexOf('Body paragraph two.')).toBeGreaterThanOrEqual(0);
      expect(t.indexOf('Body paragraph two.')).toBeLessThan(t.indexOf('Certificate of completion'));
      // Nothing from /etc/passwd was read in.
      expect(t).not.toMatch(/root:.*:0:0/);
    }, 600_000);
  },
);

describe.skipIf(!ready)(
  'FRW-050 criterion 6: the certificate pages are tagged like the body',
  () => {
    it('is tagged, declares PDF/UA-2 and PDF/A-4f, passes veraPDF, and tags the certificate text', async () => {
      const pdf = await compile('frw-050-tagged', { tagging: 'on', pdfStandard: 'ua-2+a-4f' });
      const all = asText(pdf);
      expect(all).toMatch(/\/StructTreeRoot/);
      expect(all).toMatch(/<pdfuaid:part>2<\/pdfuaid:part>/);
      const ua2 = await validatePdf(pdf, 'ua2');
      expect(ua2.error, 'the validator output parses').toBeUndefined();
      expect(ua2.failures, 'no PDF/UA-2 rule fails').toEqual([]);
      expect(ua2.compliant).toBe(true);
      const a4f = await validatePdf(pdf, '4f');
      expect(a4f.error, 'the validator output parses').toBeUndefined();
      expect(a4f.compliant).toBe(true);
      // The certificate pages are marked content too: more than the two body paragraphs carry MCIDs.
      const mcids = new Set([...all.matchAll(/\/MCID\s+(\d+)/g)].map((m) => m[1]));
      expect(mcids.size).toBeGreaterThan(8);
    }, 600_000);
  },
);
