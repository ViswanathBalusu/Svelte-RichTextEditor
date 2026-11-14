/**
 * Entry point of the asset worker's sandbox image (Containerfile). Reads one request frame from
 * standard input, processes it, writes one reply frame to standard output and exits. It runs as an
 * unprivileged user in a container without network, without any writable path and without
 * credentials, under Node.js's permission model (read access to its own code only, no child
 * processes, no workers, no native add-ons), with memory, CPU, process and time limits set by the
 * supervisor (sandbox-podman.ts).
 *
 * Standard output carries only the reply: anything a library prints goes to standard error, which
 * the supervisor bounds and never parses.
 */
import { handleRequest } from './process.ts';

/** Largest request: the largest upload limit the supervisor may set, plus the frame header. */
const MAX_REQUEST = 256 * 1024 * 1024 + 64 * 1024;

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

try {
  const reply = await handleRequest(await readStdin());
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(reply, (e) => (e ? reject(e) : resolve())),
  );
  process.exitCode = 0;
} catch (e) {
  process.stderr.write(`sandbox: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}\n`);
  process.exitCode = 70;
}
