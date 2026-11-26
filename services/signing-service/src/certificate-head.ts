/**
 * Reads the facts of the certificate of completion from a sealed PDF's text, for the relying party's
 * command (12 §8.2 step 4, §10; FRW-055 criterion 2).
 *
 * The certificate pages print, each on its own line (`packages/export-latex/src/certificate.ts`):
 * `Document: <id>`, `Workflow: <id>`, `Completed at sequence number <n>` and
 * `Chain head at completion (SHA-256): <64 hexadecimal digits>`. The text of a PDF is read with
 * `pdftotext` (poppler), which the reader installs or names; this package adds no PDF library for it.
 * A line break inside the hash, which a typeset page may make, is allowed for.
 *
 * Nothing here decides whether the head is right: the command compares it with the bundle's chain.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CertificateReading {
  readonly documentId: string | null;
  readonly workflowId: string | null;
  readonly completedSeq: number | null;
  /** Lower-case hexadecimal SHA-256 as printed, with any line break taken out. */
  readonly chainHead: string | null;
}

/** The facts printed in the text of a PDF; each is null when the line is not there. */
export function readCertificate(text: string): CertificateReading {
  const one = (re: RegExp): string | null => re.exec(text)?.[1] ?? null;
  const seq = one(/Completed at sequence number\s+(\d+)/);
  const head = one(/Chain head at completion \(SHA-256\):\s*((?:[0-9a-fA-F]\s*){64})/);
  return {
    documentId: one(/Document:\s*(\S+)/),
    workflowId: one(/Workflow:\s*(\S+)/),
    completedSeq: seq === null ? null : Number(seq),
    chainHead: head === null ? null : head.replace(/\s+/g, '').toLowerCase(),
  };
}

export type PdfText =
  | { readonly ok: true; readonly text: string }
  /** `missing`: the tool could not be started; otherwise it ran and could not read this PDF. */
  | { readonly ok: false; readonly missing: boolean; readonly reason: string };

/** The text of every page, by `pdftotext -raw`; `tool` is the command or the path to it. */
export function pdfText(pdf: Uint8Array, tool = 'pdftotext'): PdfText {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-cert-'));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, pdf);
    const r = spawnSync(tool, ['-enc', 'UTF-8', '-raw', file, '-'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (r.error)
      return { ok: false, missing: true, reason: `cannot run ${tool}: ${r.error.message}` };
    if (r.status !== 0)
      return {
        ok: false,
        missing: false,
        reason: `${tool} could not read the PDF (exit ${String(r.status)})`,
      };
    return { ok: true, text: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
