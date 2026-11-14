/**
 * The registered namespace prefixes of preserved element trees (ADR 0017; spike S11, model change
 * 3). A name in a registered namespace is written with its short prefix (`w:val`), and in Clark
 * notation (`{uri}local`) only when its namespace is not registered, so that every name has one
 * spelling: two spellings would hash differently and defeat the sharing of `preserved_def`. The
 * prefixes are the conventional ones of ECMA-376 and of Word's own files; the DOCX writer binds
 * them to the part's own declarations when it serialises a tree.
 */
export const PRESERVED_PREFIXES: Readonly<Record<string, string>> = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  sl: 'http://schemas.openxmlformats.org/schemaLibrary/2006/main',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  w10: 'urn:schemas-microsoft-com:office:word',
  wne: 'http://schemas.microsoft.com/office/word/2006/wordml',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  wp14: 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  wpi: 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk',
  a14: 'http://schemas.microsoft.com/office/drawing/2010/main',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16se: 'http://schemas.microsoft.com/office/word/2015/wordml/symex',
  w16cid: 'http://schemas.microsoft.com/office/word/2016/wordml/cid',
  w16: 'http://schemas.microsoft.com/office/word/2018/wordml',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  w16sdtdh: 'http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash',
  xml: 'http://www.w3.org/XML/1998/namespace',
};

/** Namespace URIs that have a registered prefix, and so may not be written in Clark notation. */
export const REGISTERED_NAMESPACES: ReadonlySet<string> = new Set(
  Object.values(PRESERVED_PREFIXES),
);

/** A preserved name: `prefix:local` with a registered prefix, `{uri}local`, or a bare local name. */
export const PRESERVED_NAME_PATTERN = `^(?:\\{[^{}\\s]{1,256}\\}|(?:${Object.keys(PRESERVED_PREFIXES).join('|')}):)?[A-Za-z_][A-Za-z0-9._-]{0,127}$`;
