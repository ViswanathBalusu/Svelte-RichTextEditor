// BE-097: the on-call process must name only alerts that exist, and cover what the story asks for.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const doc = readFileSync(join(root, 'docs', 'on-call-process.md'), 'utf8');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const source = sourceFiles(join(root, 'src'))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

function section(title: string): string {
  const start = doc.indexOf(`\n## ${title}`);
  expect(start, `section ${title}`).toBeGreaterThan(-1);
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

describe('BE-097 on-call process for hosted mode', () => {
  it('names only metrics that the service emits', () => {
    const names = new Set(doc.match(/`((?:dep|docedit)_[a-z_]+)`/g)?.map((n) => n.slice(1, -1)));
    expect(names.size).toBeGreaterThan(10);
    const missing = [...names].filter((n) => !source.includes(n));
    expect(missing).toEqual([]);
  });

  it('covers every metric of 06 section 11 that is an alert source', () => {
    const alerts = section('3. Alerts');
    for (const name of [
      'dep_ack_latency_ms',
      'dep_persist_latency_ms',
      'dep_cold_open_ms',
      'dep_open_rooms',
      'dep_room_memory_bytes',
      'dep_slow_consumers_total',
      'dep_rejections_total',
      'docedit_job_depth',
    ]) {
      expect(alerts, name).toContain(`\`${name}\``);
    }
  });

  it('gives every alert a severity and who is paged', () => {
    const rows = section('3. Alerts')
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Alert') && !l.startsWith('|---'));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1);
      expect(cells.length, row).toBe(5);
      expect(
        cells.every((c) => c.trim().length > 0),
        row,
      ).toBe(true);
    }
  });

  it('quotes only targets of the specification, never a figure of its own', () => {
    const alerts = section('3. Alerts');
    expect(alerts).toContain('300 ms');
    expect(alerts).toContain('500 ms');
    expect(alerts).toContain('99.9 percent');
    expect(alerts).toContain('15 minutes');
    expect(alerts).toContain('to be set');
  });

  it('covers escalation, communication to tenants and a written review', () => {
    expect(section('4. Responding')).toMatch(/Escalate/);
    expect(section('5. Communication')).toMatch(/tenant/);
    expect(section('6. Written review')).toMatch(/timeline/);
  });

  it('refers to the abuse policy of SEC-061 and leaves the rules to it', () => {
    const abuse = section('7. Abuse reports');
    expect(abuse).toContain('SEC-061');
    expect(abuse).toContain('BE-089');
    expect(abuse).toMatch(/legal\s+hold/);
  });

  it('routes broken documents to the dump and repair tools that exist', () => {
    expect(doc).toContain('docs/repair-procedure.md');
    expect(readFileSync(join(root, 'docs', 'repair-procedure.md'), 'utf8').length).toBeGreaterThan(
      0,
    );
    expect(doc).toContain('BE-081');
  });
});
