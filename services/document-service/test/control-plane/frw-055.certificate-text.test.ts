// FRW-055 criterion 2: the relying party's command reads the chain head from the certificate pages
// of a compiled PDF. The pages here are a real compile (the export package's sandbox: LuaTeX in
// Podman, the house class), not a stand-in, and the text is read by `pdftotext` as the command
// reads it. The sealing code cannot seal a compile yet (LuaTeX writes cross-reference streams; see
// the classic-table PDF of the live-seal test), so this test shows the reading and that test shows
// the seal and the comparison. Skipped when the sandbox cannot run or `pdftotext` is missing.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { doc, para } from '../../../../packages/export-latex/test/docs.ts';
import { convertAndCompile, sandboxReady } from '../../../../packages/export-latex/test/harness.ts';
import { pdfText, readCertificate } from '../../../signing-service/src/certificate-head.ts';

const sandbox = (await sandboxReady()).ok;
const hasTool = spawnSync('pdftotext', ['-v'], { windowsHide: true }).error === undefined;

const HEAD = '3f9a1c0e5b7d4286a1c3e5f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b';

describe.skipIf(!sandbox || !hasTool)('the certificate pages of a compiled PDF (FRW-055)', () => {
  it('give the document, the workflow, the sequence number and the chain head to the command', async () => {
    const compiled = await convertAndCompile(doc([para('Body paragraph.')]), {
      profile: 'final',
      title: 'frw-055-certificate',
      instant: '2026-11-06T10:00:00.000Z',
      timeZone: 'Europe/London',
      suggestions: 'accept',
      layout: 'block',
      fields: 'flatten',
      certificate: {
        documentId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01',
        workflowId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02',
        sentSeq: 12,
        completedSeq: 40,
        chainHeadHash: HEAD,
        participants: [],
        networkIdentityIncluded: false,
        statement: ['Authentication is shown as asserted by the host.'],
      },
    } as never);
    expect(compiled.compile.ok, compiled.compile.log.slice(-800)).toBe(true);
    const text = pdfText(compiled.compile.pdf!);
    expect(text.ok, text.ok ? '' : text.reason).toBe(true);
    const read = readCertificate(text.ok ? text.text : '');
    expect(read).toEqual({
      documentId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01',
      workflowId: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02',
      completedSeq: 40,
      chainHead: HEAD,
    });
  }, 600_000);
});

describe('reading the certificate from text (FRW-055)', () => {
  it('takes the hash over a line break, in either case, and nothing after it', () => {
    const r = readCertificate(
      `Completed at sequence number 7\nChain head at completion (SHA-256): ${HEAD.slice(0, 40).toUpperCase()}\n${HEAD.slice(40)}\nAda (p1)\nface cafe`,
    );
    expect(r.chainHead).toBe(HEAD);
    expect(r.completedSeq).toBe(7);
    expect(r.documentId).toBeNull();
  });

  it('gives null for a head that is short or missing', () => {
    expect(readCertificate('Chain head at completion (SHA-256): abcd').chainHead).toBeNull();
    expect(readCertificate('nothing here')).toEqual({
      documentId: null,
      workflowId: null,
      completedSeq: null,
      chainHead: null,
    });
  });
});
