// EXP-078 criterion 1: a TeX Live upgrade is handled as a class version change. The Containerfile's
// base image is pinned by digest; the ledger image/engine-releases.json ties each base image to the
// class release that first shipped with it. Node.js only: no image is built here.
import { readFileSync } from 'node:fs';
import { CLASS_VERSION } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';
import {
  baseImageOf,
  checkEngineLedger,
  compareVersions,
  type EngineLedger,
} from './exp-078-engine-ledger.ts';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const containerfile = read('../Containerfile');
const ledger = JSON.parse(read('../image/engine-releases.json')) as EngineLedger;
const releases = (
  JSON.parse(read('../../../packages/export-latex/class/releases.json')) as {
    releases: Array<{ version: string }>;
  }
).releases.map((r) => r.version);

const check = (over: {
  ledger?: EngineLedger;
  containerfile?: string;
  released?: readonly string[];
  classVersion?: string;
}): string[] =>
  checkEngineLedger({
    ledger: over.ledger ?? ledger,
    containerfile: over.containerfile ?? containerfile,
    releasedClassVersions: over.released ?? releases,
    classVersion: over.classVersion ?? CLASS_VERSION,
  });

const NEW_IMAGE = `docker.io/texlive/texlive:latest@sha256:${'a'.repeat(64)}`;
const first = ledger.engines[0]!;

describe('EXP-078 criterion 1: a TeX Live upgrade is a class version change', () => {
  it('the Containerfile and the ledger agree today', () => {
    expect(check({})).toEqual([]);
    expect(baseImageOf(containerfile)).toBe(ledger.engines.at(-1)!.baseImage);
  });

  it('refuses a new base image in the Containerfile that has no ledger entry', () => {
    const upgraded = containerfile.replace(first.baseImage, NEW_IMAGE);
    expect(upgraded).not.toBe(containerfile);
    const problems = check({ containerfile: upgraded });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('needs a new class release and a new entry');
  });

  it('refuses an entry for a class version that has not been released', () => {
    const entry = { classVersion: '99.0.0', texlive: first.texlive, baseImage: NEW_IMAGE };
    const problems = check({
      ledger: { engines: [...ledger.engines, entry] },
      containerfile: containerfile.replace(first.baseImage, NEW_IMAGE),
    });
    expect(problems.some((p) => p.includes('not a released class version'))).toBe(true);
    expect(problems.some((p) => p.includes('later than the class of this build'))).toBe(true);
  });

  it('refuses an entry that is not later than the one before it, or repeats its image', () => {
    const same = { classVersion: first.classVersion, texlive: '2027', baseImage: NEW_IMAGE };
    const repeat = {
      classVersion: CLASS_VERSION,
      texlive: first.texlive,
      baseImage: first.baseImage,
    };
    expect(
      check({
        ledger: { engines: [first, same] },
        containerfile: containerfile.replace(first.baseImage, NEW_IMAGE),
      }).some((p) => p.includes('not later than the entry before it')),
    ).toBe(true);
    expect(
      check({ ledger: { engines: [first, repeat] } }).some((p) =>
        p.includes('the base image is the one of the entry before it'),
      ),
    ).toBe(true);
  });

  it('accepts an upgrade that comes with a released class version and a new entry', () => {
    const upgradedClass = '0.9.0';
    const entry = { classVersion: upgradedClass, texlive: '2027', baseImage: NEW_IMAGE };
    const upgraded = containerfile
      .replace(first.baseImage, NEW_IMAGE)
      .replaceAll('/usr/local/texlive/2026/', '/usr/local/texlive/2027/');
    expect(
      check({
        ledger: { engines: [first, entry] },
        containerfile: upgraded,
        released: [...releases, upgradedClass],
        classVersion: upgradedClass,
      }),
    ).toEqual([]);
  });

  it('refuses a base image that is not pinned by digest', () => {
    const loose = { ...first, baseImage: 'docker.io/texlive/texlive:latest' };
    const problems = check({
      ledger: { engines: [loose] },
      containerfile: containerfile.replace(first.baseImage, loose.baseImage),
    });
    expect(problems.some((p) => p.includes('not pinned by digest'))).toBe(true);
  });

  it('compares versions as numbers', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
  });
});
