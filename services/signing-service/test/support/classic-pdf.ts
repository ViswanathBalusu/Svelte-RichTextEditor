/**
 * A one-page PDF 1.7 with a classic cross-reference table and no object streams, made by hand, to
 * test the sealing code on the other kind of file (LuaTeX writes cross-reference streams).
 *
 * With `certificateLines` a second page holds those lines as text (Helvetica, 7 points), as a
 * stand-in for the certificate pages of a compiled document (FRW-050); a line is drawn as given,
 * so a long line is the caller's to split. Without it the bytes are those of the one-page file.
 */
export function classicPdf(certificateLines?: readonly string[]): Uint8Array {
  const escape = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const pages = certificateLines === undefined ? 1 : 2;
  const stream = 'BT /F1 18 Tf 20 100 Td (Classic table) Tj ET';
  const second =
    certificateLines === undefined
      ? ''
      : `BT /F1 7 Tf 10 190 Td 9 TL ${certificateLines.map((l) => `(${escape(l)}) '`).join(' ')} ET`;
  const objs: Array<string | { stream: string }> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    pages === 1
      ? '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
      : '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    { stream },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (pages === 2) {
    objs.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      { stream: second },
    );
  }
  let out = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out +=
      typeof o === 'string'
        ? `${i + 1} 0 obj\n${o}\nendobj\n`
        : `${i + 1} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n${o.stream}\nendstream\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(out, 'latin1'));
}
