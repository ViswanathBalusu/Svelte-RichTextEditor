/**
 * Vertical metrics of a face from its own tables, shared by both kernels so that their
 * `lineMetrics` agree: the OS/2 typographic values when the font sets USE_TYPO_METRICS
 * (fsSelection bit 7), as HarfBuzz does, otherwise `hhea`. In font units.
 */
export interface FaceMetrics {
  readonly upem: number;
  readonly ascender: number;
  /** Below the baseline, positive. */
  readonly descender: number;
  readonly lineGap: number;
}

function table(view: DataView, tag: string): number | null {
  const n = view.getUint16(4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    let t = '';
    for (let j = 0; j < 4; j++) t += String.fromCharCode(view.getUint8(rec + j));
    if (t === tag) return view.getUint32(rec + 8);
  }
  return null;
}

export function faceMetrics(bytes: Uint8Array): FaceMetrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = table(view, 'head');
  const hhea = table(view, 'hhea');
  const os2 = table(view, 'OS/2');
  if (head === null || hhea === null) throw new Error('font without head or hhea table');
  const upem = view.getUint16(head + 18);
  if (os2 !== null && (view.getUint16(os2 + 62) & 0x80) !== 0)
    return {
      upem,
      ascender: view.getInt16(os2 + 68),
      descender: -view.getInt16(os2 + 70),
      lineGap: view.getInt16(os2 + 72),
    };
  return {
    upem,
    ascender: view.getInt16(hhea + 4),
    descender: -view.getInt16(hhea + 6),
    lineGap: view.getInt16(hhea + 8),
  };
}
