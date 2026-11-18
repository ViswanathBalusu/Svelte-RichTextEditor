/**
 * Hostile PDFs for the viewer's isolation tests (FE-071 criterion 2; 09 §9.3 rule 7; 10 §3.1):
 *
 * - `scripts`: an OpenAction with JavaScript, page open and close actions with JavaScript, a launch
 *   action, a form field with keystroke, format and calculate scripts, and link annotations (one
 *   launch, one URI, SEC-036). Each
 *   script calls back to the demo server (`/pwned?case=…`), so a script that ran leaves a request;
 * - `pages`: a document with a very large number of real pages;
 * - `lying`: a page tree whose /Count claims a million pages while it holds one.
 *
 * Geometry is irrelevant; every page is 200 by 200 points with one line of text.
 */

/** Writes objects (1-based) into a PDF with a cross-reference table. */
function writePdf(objects: readonly string[], root = 1): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root ${root} 0 R >>`,
    'startxref',
    String(length),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

const stream = (data: string) =>
  `<< /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;
const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** `base` is where the scripts would call: the demo server's origin. */
export function scriptsPdf(base: string): Buffer {
  const call = (name: string) =>
    `app.launchURL("${base}/pwned?case=${name}", true); this.submitForm("${base}/pwned?case=${name}-submit");`;
  const js = (name: string) => `<< /S /JavaScript /JS (${call(name)}) >>`;
  return writePdf([
    // 1 catalogue: an OpenAction script, document-level actions, the form
    `<< /Type /Catalog /Pages 2 0 R /OpenAction ${js('open-action')} /AA << /WC ${js('will-close')} /WP ${js('will-print')} >> /AcroForm << /Fields [6 0 R] /NeedAppearances true >> /Names << /JavaScript << /Names [(init) ${js('names')}] >> >> >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    // 3 the page: open and close scripts, a launch action, the field and a link
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /AA << /O ${js('page-open')} /C << /S /Launch /F (calc.exe) /Win << /F (cmd.exe) /P (/c calc) >> >> >> /Annots [6 0 R 7 0 R 8 0 R] >>`,
    stream('BT /F1 12 Tf 20 180 Td (Hostile PDF) Tj ET'),
    FONT,
    // 6 a text field with keystroke, format and calculate scripts
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (field) /Rect [20 100 180 130] /P 3 0 R /V (value) /AA << /K ${js('keystroke')} /F ${js('format')} /C ${js('calculate')} /Fo ${js('focus')} >> >>`,
    // 7 a link that would launch an application
    `<< /Type /Annot /Subtype /Link /Rect [20 40 180 70] /A << /S /Launch /F (calc.exe) >> >>`,
    // 8 a link with a URI action to the demo server (SEC-036): following it would leave a request
    `<< /Type /Annot /Subtype /Link /Rect [20 140 180 170] /A << /S /URI /URI (${base}/pwned?case=uri) >> >>`,
  ]);
}

/** `count` real pages that share one content stream and font. */
export function manyPagesPdf(count: number): Buffer {
  const objects: string[] = [];
  const first = 5;
  const kids = Array.from({ length: count }, (_, i) => `${first + i} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`);
  objects.push(stream('BT /F1 12 Tf 20 180 Td (Page) Tj ET'));
  objects.push(FONT);
  for (let i = 0; i < count; i++)
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    );
  return writePdf(objects);
}

/** One page, with a page tree that claims a million. */
export function lyingCountPdf(): Buffer {
  return writePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1000000 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    stream('BT /F1 12 Tf 20 180 Td (Lying page tree) Tj ET'),
    FONT,
  ]);
}
