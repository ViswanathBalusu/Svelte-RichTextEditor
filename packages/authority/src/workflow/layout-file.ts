/**
 * The whole `layout.json` of an export, checked against its published schema (09 §7.1; FRW-057
 * criterion 3). The schema constant `LAYOUT_SCHEMA` and the code that writes the file are the export
 * worker's; the check lives here so that the services that read the file (the document service, for
 * the visible appearances) apply the same rules without sharing code with the worker. The export
 * worker's `validateLayout` calls this function, so there is one copy of the rules.
 *
 * Hand-written, no schema library. Returns the problems found, empty when the file is valid. A file
 * that fails any check is not used at all: its rectangles are not trusted either.
 */

const ID = /^[A-Za-z0-9_-]{16}$/;

const isInt = (v: unknown, min = -(2 ** 31), max = 2 ** 31): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function validateLayoutFile(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['not an object'];
  const v = value as Record<string, unknown>;
  const keys = ['seq', 'classVersion', 'granularity', 'unit', 'pages', 'blocks', 'fields'];
  for (const k of Object.keys(v)) if (!keys.includes(k)) errors.push(`unknown member ${k}`);
  if (!(v['seq'] === null || isInt(v['seq'], 0))) errors.push('seq');
  if (
    typeof v['classVersion'] !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$/.test(v['classVersion'])
  )
    errors.push('classVersion');
  if (v['granularity'] !== 'line' && v['granularity'] !== 'block') errors.push('granularity');
  if (v['unit'] !== 'twip') errors.push('unit');
  const pages = v['pages'];
  if (!Array.isArray(pages) || pages.length > 2000) errors.push('pages');
  else
    pages.forEach((p: Record<string, unknown> | null, i) => {
      if (typeof p !== 'object' || p === null) {
        errors.push(`pages[${i}]`);
        return;
      }
      if (p['n'] !== i + 1) errors.push(`pages[${i}].n`);
      if (!(p['setup'] === null || typeof p['setup'] === 'string'))
        errors.push(`pages[${i}].setup`);
      const s = p['starts'] as Record<string, unknown> | null;
      if (
        s !== null &&
        (typeof s !== 'object' ||
          !ID.test(String(s['blockId'])) ||
          !isInt(s['offset'], 0) ||
          !isInt(s['y'], 0, 31680))
      )
        errors.push(`pages[${i}].starts`);
      if (!['text', 'float', 'tableHead', 'footnoteContinuation'].includes(String(p['opensWith'])))
        errors.push(`pages[${i}].opensWith`);
    });
  const blocks = v['blocks'];
  const pageCount = Array.isArray(pages) ? pages.length : 0;
  if (typeof blocks !== 'object' || blocks === null) errors.push('blocks');
  else
    for (const [k, b] of Object.entries(blocks as Record<string, Record<string, unknown>>)) {
      if (!ID.test(k)) errors.push(`blocks key ${k}`);
      if (typeof b !== 'object' || b === null) {
        errors.push(`blocks.${k}`);
        continue;
      }
      if (!isInt(b['page'], 1, pageCount) || !isInt(b['y'], 0, 31680)) errors.push(`blocks.${k}`);
      const ls = b['lineStarts'];
      const lp = b['linePages'];
      if (ls !== undefined && (!Array.isArray(ls) || !ls.every((x) => isInt(x, 0))))
        errors.push(`blocks.${k}.lineStarts`);
      if (lp !== undefined && (!Array.isArray(lp) || !lp.every((x) => isInt(x, 1, pageCount))))
        errors.push(`blocks.${k}.linePages`);
      const rp = b['rowPages'];
      if (
        rp !== undefined &&
        (!Array.isArray(rp) || !rp.every((x) => x === null || isInt(x, 1, pageCount)))
      )
        errors.push(`blocks.${k}.rowPages`);
      const cb = b['columnBreaks'];
      if (cb !== undefined && (!Array.isArray(cb) || !cb.every((x) => isInt(x, 1))))
        errors.push(`blocks.${k}.columnBreaks`);
      if (b['granularity'] !== undefined && b['granularity'] !== 'block')
        errors.push(`blocks.${k}.granularity`);
    }
  const fields = v['fields'];
  if (typeof fields !== 'object' || fields === null) errors.push('fields');
  else
    for (const [k, f] of Object.entries(fields as Record<string, Record<string, unknown>>)) {
      if (!ID.test(k)) errors.push(`fields key ${k}`);
      if (typeof f !== 'object' || f === null) {
        errors.push(`fields.${k}`);
        continue;
      }
      const rect = f['rect'];
      if (
        !isInt(f['page'], 1, pageCount) ||
        !Array.isArray(rect) ||
        rect.length !== 4 ||
        !rect.every((x) => isInt(x, 0, 1_000_000)) ||
        (rect[2] as number) < (rect[0] as number) ||
        (rect[3] as number) < (rect[1] as number)
      )
        errors.push(`fields.${k}`);
    }
  return errors;
}
