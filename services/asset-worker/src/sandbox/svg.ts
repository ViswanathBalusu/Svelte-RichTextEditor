/**
 * SVG uploads (BE-043 criterion 5; SEC-006 criterion 4; 10 §3.1 "SVG is never rendered as live
 * SVG"; 09 §2). The file is parsed strictly (svg-xml.ts), anything that could run or fetch
 * something fails the upload, the supported drawing is reduced to paths (svg-draw.ts), and two new
 * files are written from that drawing alone (svg-write.ts): a sanitised SVG for display, which the
 * asset origin serves as an attachment under a sandboxing content security policy for use in
 * `<img>` only, and a PDF for the typesetter. The uploaded text is never stored or served.
 */
import { AssetError } from './errors.ts';
import type { ContentLimits } from './limits.ts';
import { checkOutput, type Processed } from './output.ts';
import { buildDrawing } from './svg-draw.ts';
import { writePdf, writeSvg } from './svg-write.ts';
import { parseSvgXml } from './svg-xml.ts';
import { PDF, SVG } from './types.ts';

export function processSvg(b: Uint8Array, limits: ContentLimits): Processed {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new AssetError('malformed', 'the SVG file is not valid UTF-8');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
    throw new AssetError('malformed', 'the SVG file has control characters');
  const xml = parseSvgXml(text, limits);
  const drawing = buildDrawing(xml.root, limits);
  if (drawing.shapes.length === 0) drawing.notes.push('nothing_drawn');
  const svg = new TextEncoder().encode(writeSvg(drawing));
  const pdf = writePdf(drawing);
  const notes = [...drawing.notes];
  if (xml.foreign > 0) notes.push('foreign_elements_removed');
  return {
    detected: SVG,
    width: Math.round(drawing.width),
    height: Math.round(drawing.height),
    frames: 1,
    keepOriginal: false,
    outputs: [
      { role: 'display', mime: SVG, data: checkOutput(svg, limits) },
      { role: 'print', mime: PDF, data: checkOutput(pdf, limits) },
    ],
    notes: notes.sort(),
  };
}
