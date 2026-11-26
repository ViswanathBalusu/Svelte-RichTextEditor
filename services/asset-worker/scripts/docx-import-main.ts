/**
 * Entry point of the Word import sandbox image (EXP-099 criterion 1; Containerfile.import). Reads
 * the bytes of one `.docx` file from standard input, runs the importer of `packages/export-docx` and
 * writes one JSON reply to standard output: `{ ok: true, envelope, warnings, preservation }`, or
 * `{ ok: false, message }` when the importer refuses the file (a refusal is a result, not a failure
 * of the sandbox). It runs as an unprivileged user in a container without network, without any
 * writable path and without credentials, under Node.js's permission model (read access to the image's
 * own code only, no child processes, no workers, no native add-ons), with memory, CPU, process and
 * time limits set by the supervisor (src/sandbox-podman.ts, src/docx-import.ts).
 *
 * The file is not run from the package: the image holds the source of `packages/model` and
 * `packages/export-docx` at their repository paths (scripts/build-import-image.ts), so the relative
 * imports below resolve there too. Standard output carries only the reply.
 */
import { importDocx, preservationReport } from '../../../packages/export-docx/src/index.ts';

/** Largest request: the largest upload limit the supervisor may set. */
const MAX_REQUEST = 256 * 1024 * 1024;

const toStderr = (...args: unknown[]): void => {
  process.stderr.write(
    `${args
      .map((a) => String(a))
      .join(' ')
      .slice(0, 500)}\n`,
  );
};
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
console.error = toStderr;

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST) throw new Error('the request is larger than the sandbox accepts');
    chunks.push(chunk);
  }
  const all = Buffer.concat(chunks, size);
  return new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
}

const write = (text: string): Promise<void> =>
  new Promise<void>((resolve, reject) =>
    process.stdout.write(text, (e) => (e ? reject(e) : resolve())),
  );

try {
  const bytes = await readStdin();
  let reply: unknown;
  try {
    const r = await importDocx(bytes);
    reply = {
      ok: true,
      envelope: r.envelope,
      warnings: r.warnings,
      preservation: { ...(await preservationReport(bytes, r)) },
    };
  } catch (e) {
    // The importer's own refusals name the cause without the file's content (EXP-099).
    reply = {
      ok: false,
      message: (e instanceof Error ? e.message : 'the file could not be read').slice(0, 200),
    };
  }
  await write(JSON.stringify(reply));
  process.exitCode = 0;
} catch (e) {
  process.stderr.write(`sandbox: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}\n`);
  process.exitCode = 70;
}
