/**
 * A hostile "decoder" for the hostile test image. It reads the request, then does what the first
 * four bytes of the upload say: HANG (loops for ever), OOM! (allocates until killed), CRSH (aborts),
 * FLOD (writes without end), FAKE (forges a success reply whose PNG output is an HTML page), or
 * answers with a valid failure reply.
 */
const chunks: Buffer[] = [];
for await (const c of process.stdin as AsyncIterable<Buffer>) chunks.push(c);
const frame = Buffer.concat(chunks);
const headerLength = frame.readUInt32BE(4);
const body = frame.subarray(8 + headerLength);
const mode = body.subarray(0, 4).toString('latin1');

function reply(header: unknown, blobs: Buffer[] = []): Buffer {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  return Buffer.concat([Buffer.from('DAR1'), len, h, ...blobs]);
}

if (mode === 'HANG') {
  for (;;) {
    // spin
  }
} else if (mode === 'OOM!') {
  const hold: Buffer[] = [];
  for (;;) hold.push(Buffer.alloc(16 * 1024 * 1024, 1));
} else if (mode === 'CRSH') {
  process.abort();
} else if (mode === 'FLOD') {
  const junk = Buffer.alloc(1024 * 1024, 0x41);
  const pump = (): void => {
    while (process.stdout.write(junk));
    process.stdout.once('drain', pump);
  };
  pump();
} else if (mode === 'FAKE') {
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
  process.stdout.write(
    reply(
      {
        v: 1,
        ok: true,
        detected: 'image/png',
        keepOriginal: false,
        outputs: [{ role: 'display', mime: 'image/png', bytes: html.length }],
        notes: [],
      },
      [html],
    ),
  );
} else {
  process.stdout.write(
    reply({ v: 1, ok: false, reason: 'decode_failed', message: 'hostile decoder' }),
  );
}
