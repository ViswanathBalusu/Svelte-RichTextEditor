#!/usr/bin/env node
/**
 * The kit as a command (05 §11; PRO-108): the entry point of its container image.
 *
 *   docedit-tck --discovery https://docs.example.com [--authority-service http://authority:8090] [--test-mode] [--origin https://app.example]
 *               [--profile core,presence] [--scenario core.sync] [--json report.json] [--text report.txt]
 *               [--timeout 10000] [--scenario-timeout 60000] [--fuzz-ms 20000] [--seed 42] [--runs 25]
 *
 * --authority-service names an authority service (05 §10) for the `authority-service` profile. Its
 * bearer token, when it needs one, is read from DEP_TCK_AUTHORITY_TOKEN. A run may name it without
 * --discovery: every DEP profile is then skipped.
 *
 * The service credential is read from the environment (DEP_TCK_CREDENTIAL, or the variable named by
 * --credential-env) or from a file (--credential-file), never from the command line, so that it does
 * not appear in process listings. Exit code 0 when the run passes, 1 when it fails, 2 on a usage error.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { renderText } from './report.ts';
import { runKit } from './runner.ts';

const usage = `usage: docedit-tck [--discovery <url>] [--authority-service <url>] [--test-mode] [--origin <url>] [--receiver-host <host>] [--receiver-port <n>] [--receiver-url <url>] [--profile <ids>] [--scenario <prefixes>]
                   [--json <file>] [--text <file>] [--timeout <ms>] [--scenario-timeout <ms>]
                   [--fuzz-ms <ms>] [--seed <n>] [--runs <n>] [--credential-env <name>] [--credential-file <file>] [--quiet]
One of --discovery and --authority-service is required. The authority service's bearer token comes from DEP_TCK_AUTHORITY_TOKEN.
The service credential comes from DEP_TCK_CREDENTIAL unless --credential-env or --credential-file says otherwise.
A second tenant's service credential in DEP_TCK_OTHER_CREDENTIAL (optional) turns on the cross-tenant scenarios of the authz profile.`;

function fail(message: string): never {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      discovery: { type: 'string' },
      'authority-service': { type: 'string' },
      'test-mode': { type: 'boolean', default: false },
      origin: { type: 'string' },
      'receiver-host': { type: 'string' },
      'receiver-port': { type: 'string' },
      'receiver-url': { type: 'string' },
      profile: { type: 'string' },
      scenario: { type: 'string' },
      json: { type: 'string' },
      text: { type: 'string' },
      timeout: { type: 'string' },
      'scenario-timeout': { type: 'string' },
      'fuzz-ms': { type: 'string' },
      seed: { type: 'string' },
      runs: { type: 'string' },
      'credential-env': { type: 'string' },
      'credential-file': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  }).values;
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
if (args.help) {
  console.log(usage);
  process.exit(0);
}
if (!args.discovery && !args['authority-service'])
  fail('--discovery or --authority-service is required');
const credential = args['credential-file']
  ? readFileSync(args['credential-file'], 'utf8').trim()
  : process.env[args['credential-env'] ?? 'DEP_TCK_CREDENTIAL'];
if (!credential && args.discovery)
  fail(
    'no service credential: set DEP_TCK_CREDENTIAL or pass --credential-env or --credential-file',
  );

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
};
const list = (v: string | undefined) =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

const seed = num(args.seed, 'seed');
const budget = num(args['fuzz-ms'], 'fuzz-ms');
const runs = num(args.runs, 'runs');
const timeoutMs = num(args.timeout, 'timeout');
const scenarioTimeoutMs = num(args['scenario-timeout'], 'scenario-timeout');
const profiles = list(args.profile);
const scenarios = list(args.scenario);

const report = await runKit({
  discovery: args.discovery ?? '',
  credential: credential ?? '',
  testMode: args['test-mode'] === true,
  ...(args.origin ? { origin: args.origin } : {}),
  ...(process.env['DEP_TCK_OTHER_CREDENTIAL']
    ? { otherCredential: process.env['DEP_TCK_OTHER_CREDENTIAL'] }
    : {}),
  ...(args['receiver-host'] || args['receiver-port'] || args['receiver-url']
    ? {
        receiver: {
          ...(args['receiver-host'] ? { host: args['receiver-host'] } : {}),
          ...(num(args['receiver-port'], 'receiver-port') !== undefined
            ? { port: num(args['receiver-port'], 'receiver-port')! }
            : {}),
          ...(args['receiver-url'] ? { url: args['receiver-url'] } : {}),
        },
      }
    : {}),
  ...(args['authority-service']
    ? {
        authorityService: {
          url: args['authority-service'],
          ...(process.env['DEP_TCK_AUTHORITY_TOKEN']
            ? { token: process.env['DEP_TCK_AUTHORITY_TOKEN'] }
            : {}),
        },
      }
    : {}),
  ...(profiles ? { profiles } : {}),
  ...(scenarios ? { scenarios } : {}),
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  ...(scenarioTimeoutMs !== undefined ? { scenarioTimeoutMs } : {}),
  fuzz: {
    ...(budget !== undefined ? { budgetMs: budget } : {}),
    ...(seed !== undefined ? { seed } : {}),
  },
  property: { ...(runs !== undefined ? { runs } : {}), ...(seed !== undefined ? { seed } : {}) },
  log: args.quiet ? () => {} : (line) => console.error(line),
});
const text = renderText(report);
if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
if (args.text) writeFileSync(args.text, text);
process.stdout.write(text);
process.exit(report.ok ? 0 : 1);
