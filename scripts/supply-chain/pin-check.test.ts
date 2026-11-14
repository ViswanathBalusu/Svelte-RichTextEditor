// The pinning check (SEC-052): base images by digest, built with Podman, actions by commit.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkCompose,
  checkContainerfile,
  checkReferences,
  checkScript,
  checkWorkflow,
  composeServices,
  parseContainerfile,
  scanRepository,
} from './pin-check.ts';

const D = `@sha256:${'a'.repeat(64)}`;
const messages = (f: Array<{ message: string }>) => f.map((x) => x.message);

describe('Containerfiles', () => {
  it('joins continuation lines, drops comments and skips heredoc bodies', () => {
    const { instructions, directives } = parseContainerfile(
      [
        '# syntax=docker/dockerfile:1',
        '# a comment',
        `FROM docker.io/library/debian:13${D} AS base`,
        'RUN set -eu; \\',
        '    # inside',
        '    echo hi',
        'RUN <<EOF',
        'FROM not-an-instruction',
        'EOF',
        'COPY x /x',
      ].join('\n'),
    );
    expect(directives.get('syntax')).toBe('docker/dockerfile:1');
    expect(instructions.map((i) => [i.line, i.keyword])).toEqual([
      [3, 'FROM'],
      [4, 'RUN'],
      [7, 'RUN'],
      [10, 'COPY'],
    ]);
    expect(instructions[1]!.args).toBe('set -eu;      echo hi');
  });

  it('passes bases pinned by digest, scratch, earlier stages and images built here', () => {
    const text = [
      `FROM --platform=linux/amd64 docker.io/library/node:22.18${D} AS build`,
      'FROM scratch',
      'FROM build AS final',
      'COPY --from=build /app /app',
      'COPY --from=0 /x /x',
    ].join('\n');
    expect(checkContainerfile(text, 'Containerfile')).toEqual([]);
    // A test image built on the service's own image, as services/asset-worker/test/hostile does.
    expect(
      checkContainerfile('ARG BASE=localhost/docedit-asset-worker:dev\nFROM ${BASE}', 'C'),
    ).toEqual([]);
  });

  it('fails a base without a digest, naming it', () => {
    expect(
      messages(checkContainerfile('FROM docker.io/texlive/texlive:latest', 'Containerfile')),
    ).toEqual([
      'base image "docker.io/texlive/texlive:latest" is not pinned by digest (@sha256:…)',
    ]);
    expect(checkContainerfile('FROM node', 'C')).toHaveLength(1);
  });

  it('expands global build arguments, and fails a base that depends on one without a pinned default', () => {
    expect(
      checkContainerfile(`ARG BASE=docker.io/library/node:22${D}\nFROM \${BASE}`, 'C'),
    ).toEqual([]);
    expect(checkContainerfile(`FROM \${BASE:-docker.io/library/node:22${D}}`, 'C')).toEqual([]);
    expect(messages(checkContainerfile('ARG BASE\nFROM $BASE', 'C'))).toEqual([
      'base image "$BASE" depends on build argument BASE without a pinned default',
    ]);
    expect(checkContainerfile('ARG TAG=22\nFROM docker.io/library/node:${TAG}', 'C')).toHaveLength(
      1,
    );
  });

  it('checks images read by COPY --from and RUN --mount, remote ADD and the syntax directive', () => {
    expect(
      checkContainerfile('FROM scratch\nCOPY --from=docker.io/library/busybox:1 /bin/sh /sh', 'C'),
    ).toHaveLength(1);
    expect(
      checkContainerfile(
        'FROM scratch\nRUN --mount=type=bind,from=ghcr.io/x/y:1,target=/y true',
        'C',
      ),
    ).toHaveLength(1);
    expect(
      checkContainerfile('FROM scratch\nADD https://example.com/a.tgz /a.tgz', 'C'),
    ).toHaveLength(1);
    expect(
      checkContainerfile(
        `FROM scratch\nADD --checksum=sha256:${'b'.repeat(64)} https://example.com/a.tgz /a.tgz`,
        'C',
      ),
    ).toEqual([]);
    expect(
      messages(checkContainerfile(`# syntax=docker/dockerfile:1\nFROM scratch`, 'C'))[0],
    ).toMatch(/BuildKit frontend/);
  });
});

describe('compose files', () => {
  it('reads services from JSON and from block YAML', () => {
    const yaml = [
      'name: x',
      'services:',
      '  db:',
      `    image: docker.io/library/postgres:17${D}`,
      '  web:',
      '    build:',
      '      context: .',
      '    image: localhost/web',
      'volumes:',
      '  data: {}',
    ].join('\n');
    expect(composeServices(yaml, false)).toEqual([
      { name: 'db', line: 3, image: `docker.io/library/postgres:17${D}`, build: false },
      { name: 'web', line: 5, image: 'localhost/web', build: true },
    ]);
  });

  it('fails an image that is neither pinned nor built here', () => {
    const json = JSON.stringify(
      {
        services: {
          s3: { image: 'docker.io/versity/versitygw:v1.10.0' },
          w: { image: '${IMAGE}', build: { context: '.' } },
          v: { image: '${OTHER}' },
        },
      },
      null,
      2,
    );
    expect(messages(checkCompose(json, 'compose.json'))).toEqual([
      'service s3: image "docker.io/versity/versitygw:v1.10.0" is not pinned by digest',
      'service v: image "${OTHER}" comes from a variable and has no build; pin it by digest',
    ]);
  });
});

describe('workflows', () => {
  it('passes actions pinned to a commit and local actions, and fails tags, Docker tooling and unpinned images', () => {
    const sha = 'f'.repeat(40);
    const text = [
      'jobs:',
      '  a:',
      '    container: node:22',
      '    steps:',
      `      - uses: actions/checkout@${sha} # v7.0.1`,
      '      - uses: ./.github/actions/local',
      '      - uses: actions/setup-node@v4',
      `      - uses: docker/build-push-action@${sha}`,
      '      - uses: docker://alpine:3',
      `      - uses: docker://alpine${D}`,
    ].join('\n');
    expect(checkWorkflow(text, 'w.yml').map((f) => [f.line, f.message])).toEqual([
      [3, 'container image node:22 is not pinned by digest'],
      [7, 'actions/setup-node@v4 is not pinned to a full commit SHA'],
      [8, `docker/build-push-action@${sha} is Docker tooling; build and push images with Podman`],
      [9, 'docker://alpine:3 is not pinned by digest'],
    ]);
  });
});

describe('Podman, never Docker', () => {
  it('fails scripts that call the Docker CLI', () => {
    expect(checkScript('spawnSync("docker", ["build", "."]);', 'a.ts')).toHaveLength(1);
    expect(checkScript('docker compose up -d', 'a.sh')).toHaveLength(1);
    expect(checkScript('& docker run --rm x', 'a.ps1')).toHaveLength(1);
    expect(
      checkScript(
        'const image = "docker.io/library/node";\n// docker run in a comment\n * docker build in JSDoc',
        'a.ts',
      ),
    ).toEqual([]);
    expect(checkScript('# docker run in a comment\necho done # docker build', 'a.sh')).toEqual([]);
  });

  it('requires DOCEDIT_CONTAINER_CLI wherever podman is called', () => {
    expect(messages(checkScript("execFileSync('podman', ['info']);", 'a.ts'))).toEqual([
      'calls podman directly; read the CLI from DOCEDIT_CONTAINER_CLI (default podman)',
    ]);
    expect(
      checkScript(
        "const cli = process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';\nspawnSync(cli, ['info']);",
        'a.ts',
      ),
    ).toEqual([]);
    expect(checkScript('podman build -t x .', 'b.sh')).toHaveLength(1);
    expect(
      checkScript('$Cli = $env:DOCEDIT_CONTAINER_CLI ?? "podman"\n& $Cli info', 'c.ps1'),
    ).toEqual([]);
  });

  it('fails image references in code that carry a tag but no digest', () => {
    expect(checkReferences(`const a = 'docker.io/verapdf/cli:v1.30.3${D}';`, 'a.ts')).toEqual([]);
    expect(checkReferences("const b = 'docker.io/verapdf/cli:v1.30.3';", 'a.ts')).toHaveLength(1);
    expect(checkReferences("const push = 'ghcr.io/owner/docedit-export-worker';", 'a.ts')).toEqual(
      [],
    );
  });
});

describe('the repository scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'docedit-pins-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('services/a/Containerfile', `FROM docker.io/library/node:22${D}\n`);
  put('services/b/Dockerfile', 'FROM node:22\n');
  put('services/b/node_modules/x/Containerfile', 'FROM ignored\n');
  put('infra/docker-compose.yml', 'services:\n  x:\n    image: redis:7\n');
  put('.github/workflows/ci.yml', 'steps:\n  - uses: actions/checkout@v4\n');
  put('scripts/run.ps1', 'podman run --rm x\n');
  put('services/c/src/run.ts', "export const IMAGE = 'docker.io/verapdf/cli:v1.30.3';\n");
  put(
    'services/c/Containerfile.dockerignore',
    '**/node_modules\nFROM is not an instruction here\n',
  );
  put('services/c/test/run.test.ts', "const example = 'docker.io/library/node:22';\n");

  it('finds every kind of finding, and skips installed packages and examples in tests', () => {
    const { findings, files } = scanRepository(root);
    expect(findings.map((f) => `${f.file}:${f.line} ${f.rule}`).sort()).toEqual([
      '.github/workflows/ci.yml:2 workflows',
      'infra/docker-compose.yml:1 compose',
      'infra/docker-compose.yml:2 compose',
      'scripts/run.ps1:1 podman',
      'services/b/Dockerfile:1 containerfiles',
      'services/b/Dockerfile:1 containerfiles',
      'services/c/src/run.ts:1 references',
    ]);
    expect(files.containerfiles).toBe(2);
  });

  it('runs only the rules asked for', () => {
    expect(scanRepository(root, ['workflows']).findings.map((f) => f.rule)).toEqual(['workflows']);
  });

  it('passes the export worker Containerfile and the integration-test compose file of this repository', () => {
    const repo = resolve(import.meta.dirname, '../..');
    const containerfile = 'services/export-worker/Containerfile';
    expect(
      checkContainerfile(readFileSync(join(repo, containerfile), 'utf8'), containerfile),
    ).toEqual([]);
    const compose = 'infra/containers/compose.json';
    expect(checkCompose(readFileSync(join(repo, compose), 'utf8'), compose)).toEqual([]);
  });
});
