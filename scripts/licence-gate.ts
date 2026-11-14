/**
 * The licence gate (FND-011): fails when a production dependency of any workspace package has a
 * licence the policy does not allow, naming the package and its licence. Development-only tools do
 * not ship and are not checked here. A devDependency that a bundler inlines into a shipped bundle
 * (for example pdfjs-dist in the element) does ship: the release pipeline checks those, from the
 * packages found in each bundle (scripts/release/, ADR 0044). A dual licence passes only with a
 * recorded decision naming the option taken (borrow list §15). Exceptions need a decision, a reason
 * and an expiry.
 *
 * Usage: node scripts/licence-gate.ts            (exit code 1 on any violation)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Exception, type Policy, activeException, evaluate } from './licence-policy.ts';

interface PnpmLicenceEntry {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
}

const root = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(join(root, 'licences/policy.json'), 'utf8')) as Policy;
const exceptions = (
  JSON.parse(readFileSync(join(root, 'licences/exceptions.json'), 'utf8')) as {
    exceptions: Exception[];
  }
).exceptions;
const today = new Date().toISOString().slice(0, 10);

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const raw = execFileSync(pnpm, ['licenses', 'list', '--json', '--prod', '-r'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const byLicence = JSON.parse(raw) as Record<string, PnpmLicenceEntry[]>;

const problems: string[] = [];
const notes: string[] = [];
let checked = 0;
for (const entries of Object.values(byLicence)) {
  for (const e of entries) {
    if (e.name.startsWith('@docedit/')) continue; // our own packages carry the project licence
    for (const version of e.versions) {
      checked++;
      const dir = e.paths[0];
      const ex = activeException(exceptions, e.name, version, today);
      if (
        dir &&
        existsSync(dir) &&
        !readdirSync(dir).some((f) => /^(licen[cs]e|copying|notice)/i.test(f))
      ) {
        if (ex)
          notes.push(
            `${e.name}@${version}: no licence file in the package; allowed by exception (${ex.decision}, until ${ex.expires})`,
          );
        else problems.push(`${e.name}@${version}: no licence file in the published package`);
      }
      const v = evaluate(e.license, policy);
      if (!v.ok) {
        if (ex)
          notes.push(
            `${e.name}@${version}: ${e.license} allowed by exception (${ex.decision}, until ${ex.expires})`,
          );
        else problems.push(`${e.name}@${version}: ${v.reason}`);
      } else if (v.dual && !ex) {
        problems.push(
          `${e.name}@${version}: dual licence ${e.license} needs a recorded decision naming the option taken (licences/exceptions.json)`,
        );
      }
    }
  }
}
for (const ex of exceptions) {
  if (!ex.reason || !ex.decision || !/^\d{4}-\d{2}-\d{2}$/.test(ex.expires ?? ''))
    problems.push(
      `exception for ${ex.package} needs a reason, a decision record and an expiry date`,
    );
  else if (ex.expires < today)
    problems.push(`exception for ${ex.package} expired on ${ex.expires}`);
}

console.log(`licence gate: ${checked} production dependencies checked`);
for (const n of notes) console.log(`  note: ${n}`);
if (problems.length) {
  console.error(`licence gate: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('licence gate: passed');
