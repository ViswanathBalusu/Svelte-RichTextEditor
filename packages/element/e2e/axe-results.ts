/**
 * The hand-over of the element's axe results to the accessibility conformance report (FE-126
 * criterion 4; UX-069). When `DOCEDIT_AXE_RESULTS` names a file, each axe run of an FE-126 spec adds
 * one JSON line to it, in the form the report reads (`AxeRecord` in
 * `packages/ui/src/a11y-report/report.ts`). The release script gives the same file to
 * `packages/ui/scripts/a11y-report.ts --axe`. Without the variable nothing is written.
 *
 * Only types are imported from Playwright, so the Node.js tests can load this file.
 */
import { appendFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';

/** One run of axe, as the report reads it (the same fields as `AxeRecord`). */
export interface AxeRecordLine {
  readonly browser: string;
  readonly version: string;
  readonly test: string;
  readonly violations: number;
  readonly rules: readonly string[];
}

/** The record of one run: the count of violations and the distinct rules, in order of first sight. */
export function axeRecord(
  browser: string,
  version: string,
  testTitle: string,
  violations: readonly { readonly id: string }[],
): AxeRecordLine {
  return {
    browser,
    version,
    test: testTitle,
    violations: violations.length,
    rules: [...new Set(violations.map((v) => v.id))],
  };
}

/** Adds the run to the file named by `DOCEDIT_AXE_RESULTS`, if there is one. Returns the record written. */
export function handOverAxe(
  page: Page,
  info: Pick<TestInfo, 'titlePath'>,
  violations: readonly { readonly id: string }[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): AxeRecordLine | null {
  const file = env['DOCEDIT_AXE_RESULTS'];
  if (!file) return null;
  const browser = page.context().browser();
  const line = axeRecord(
    browser?.browserType().name() ?? 'unknown',
    browser?.version() ?? 'unknown',
    info.titlePath.slice(1).join(' > '),
    violations,
  );
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return line;
}
