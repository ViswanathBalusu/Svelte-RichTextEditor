// FRW-050: the certificate of completion is appended after the body through the converter's typed
// emitters (docs/adr/0400-w4-FRW-050-certificate-pages.md, proposed). The tests read the generated
// TeX; no compile is run here (see the story's Notes).
import { describe, expect, it } from 'vitest';
import { doc, para, run, blockLines, decodeStrings, type J } from '../test/docs.ts';
import type { CertificateFacts } from './certificate.ts';

const HASH = 'ab'.repeat(32);

function facts(over: Partial<CertificateFacts> = {}): CertificateFacts {
  return {
    documentId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01',
    workflowId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02',
    sentSeq: 12,
    completedSeq: 40,
    chainHeadHash: HASH,
    participants: [
      {
        id: 'p1',
        label: 'Ada Lovelace',
        events: [
          {
            kind: 'viewed',
            serverTimeMs: Date.UTC(2026, 10, 6, 10, 0, 0),
            ipAddress: '203.0.113.7',
            userAgent: 'TestAgent/1.0',
          },
          { kind: 'consent', serverTimeMs: Date.UTC(2026, 10, 6, 10, 1, 0) },
          { kind: 'signed', serverTimeMs: Date.UTC(2026, 10, 6, 10, 2, 0) },
          { kind: 'completed', serverTimeMs: Date.UTC(2026, 10, 6, 10, 3, 0) },
        ],
      },
    ],
    networkIdentityIncluded: true,
    statement: ['A fixed sentence of the certificate.'],
    ...over,
  };
}

const body = (): J[] => [para('First paragraph of the body.'), para('Second paragraph.')];
const textOf = (b: { files: Record<string, string> }) => decodeStrings(b.files['main.tex']!);

describe('the certificate is appended after the body (FRW-050 criteria 1 and 2)', () => {
  it('prints the identifiers, the sequence numbers, the chain head and each event with its time', async () => {
    const b = await run(doc(body()), { certificate: facts() });
    expect(b.ok).toBe(true);
    const t = textOf(b);
    for (const s of [
      'Certificate of completion',
      '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01',
      '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02',
      'Sent at sequence number 12',
      'Completed at sequence number 40',
      HASH,
      'Ada Lovelace',
      'Viewed the document: 2026-11-06 10:00:00 UTC',
      'Accepted the consent text: 2026-11-06 10:01:00 UTC',
      'Signed: 2026-11-06 10:02:00 UTC',
      'Completed: 2026-11-06 10:03:00 UTC',
      'A fixed sentence of the certificate.',
    ])
      expect(t, s).toContain(s);
  });

  it('leaves every block of the body as it was and puts the certificate after it, on a new page', async () => {
    const d = doc(body());
    const plain = await run(d);
    const withCert = await run(d, { certificate: facts() });
    const ids = (d.doc as unknown as { content: Array<{ type: string; content: J[] }> }).content
      .find((c) => c.type === 'body')!
      .content.map((p) => (p['attrs'] as J)['id'] as string);
    for (const id of ids) expect(blockLines(withCert, id)).toEqual(blockLines(plain, id));
    const lines = withCert.files['main.tex']!.split('\n');
    const last = Math.max(...ids.map((id) => lines.indexOf(blockLines(withCert, id).at(-1)!)));
    // The first block of the certificate starts a new page (\DEpb), after the last body line.
    const pageBreak = lines.lastIndexOf(String.raw`\DEpb`);
    expect(pageBreak).toBeGreaterThan(last);
    expect(decodeStrings(lines.slice(pageBreak, pageBreak + 6).join('\n'))).toContain(
      'Certificate of completion',
    );
    expect(plain.files['main.tex']).not.toContain(String.raw`\DEpb`);
    expect(plain.files['main.tex']).not.toContain('Certificate');
    // The option joins the manifest options, so a certificate changes the bundle hash.
    expect(withCert.manifest.options['certificate']).toBe('on');
    expect(plain.manifest.options['certificate']).toBeUndefined();
    expect(withCert.manifest.bundleHash).not.toBe(plain.manifest.bundleHash);
  });

  it('adds nothing without the option', async () => {
    const a = await run(doc(body()));
    const b = await run(doc(body()), {});
    expect(b.files['main.tex']).toBe(a.files['main.tex']);
  });
});

describe('what the certificate prints of the network (FRW-050 criterion 5)', () => {
  it('prints the address and the user agent while the setting is on', async () => {
    const t = textOf(await run(doc(body()), { certificate: facts() }));
    expect(t).toContain('address 203.0.113.7');
    expect(t).toContain('user agent TestAgent/1.0');
  });

  it('prints neither when the setting is off, even if the events hold them', async () => {
    const t = textOf(
      await run(doc(body()), { certificate: facts({ networkIdentityIncluded: false }) }),
    );
    expect(t).not.toContain('203.0.113.7');
    expect(t).not.toContain('TestAgent');
    expect(t).not.toContain('address ');
    expect(t).not.toContain('user agent');
  });
});

describe('a name or an evidence string is data, never TeX (FRW-050 criteria 3 and 4, at the source)', () => {
  const evil = String.raw`\input{/etc/passwd} \write18{x} $\\ %{}^_~#& \directlua{os.exit()} \begin{document}`;
  it('writes the hostile text only through the emitter, with no control sequence of its own', async () => {
    const b = await run(doc(body()), {
      certificate: facts({
        participants: [
          {
            id: 'p1',
            label: evil,
            events: [{ kind: 'viewed', serverTimeMs: 0, userAgent: evil }],
          },
        ],
      }),
    });
    expect(b.ok).toBe(true);
    const main = b.files['main.tex']!;
    for (const raw of [String.raw`\input{/etc`, String.raw`\write18`, String.raw`\directlua{os`]) {
      expect(main.split(raw).length - 1, raw).toBe(0);
    }
    // The one real \begin{document} of the file is the only one: the hostile one is escaped.
    expect(main.split(String.raw`\begin{document}`).length - 1).toBe(1);
    // The characters are still in the document, as text.
    expect(decodeStrings(main)).toContain('input');
  });
});
