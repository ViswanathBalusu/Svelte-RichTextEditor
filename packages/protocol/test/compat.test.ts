// Backward compatibility between published artifact sets (05 §1 rule 2; PRO-006 criterion 2): a
// later set of the same major version may only add. The check runs on the real artifacts in
// spec/dep and on edits of them; the CI job that compares two published sets is not in this package.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ArtifactSetJson, compatibilityProblems } from '../src/generate/compat.ts';
import { readJson } from './support.ts';

type Obj = Record<string, unknown>;

const current = (): ArtifactSetJson => ({
  registry: readJson('spec/dep/dep-1.registry.json'),
  asyncapi: readJson('spec/dep/dep-1.asyncapi.json'),
  openapi: readJson('spec/dep/dep-1.openapi.json'),
});

const clone = (): ArtifactSetJson => structuredClone(current());

/** The `Hello` schema of the AsyncAPI document, the one edited below. */
const hello = (s: ArtifactSetJson): Obj => {
  const components = s.asyncapi['components'] as Obj;
  return (components['schemas'] as Record<string, Obj>)['Hello'] as Obj;
};

const helloProps = (s: ArtifactSetJson): Obj => hello(s)['properties'] as Obj;

describe('compatibility of two artifact sets (05 §1 rule 2)', () => {
  it('finds no problem between a set and itself', () => {
    expect(compatibilityProblems(current(), current())).toEqual([]);
  });

  it('accepts additions: an optional field, a message type, a feature and an event', () => {
    const later = clone();
    helloProps(later)['x-added'] = { type: 'string' };

    const messages = later.registry['messages'] as Obj[];
    messages.push({ ...messages[0], t: 'wf.test-added', spec: 'test' });

    const features = later.registry['features'] as Obj[];
    features.push({ name: 'test-added', relayForbidden: false, port: 'none' });

    const webhooks = later.registry['webhooks'] as Obj[];
    webhooks.push({ type: 'dep.test.added.v1', when: 'A test event.', spec: 'test' });

    expect(compatibilityProblems(current(), later)).toEqual([]);
  });

  it('accepts a change to prose only', () => {
    const later = clone();
    hello(later)['description'] = 'Reworded.';
    helloProps(later)['versions'] = {
      ...(helloProps(later)['versions'] as Obj),
      description: 'Reworded again.',
    };
    expect(compatibilityProblems(current(), later)).toEqual([]);
  });

  it('reports a removed message type, feature, error code and close code by name', () => {
    const later = clone();
    later.registry['messages'] = (later.registry['messages'] as Obj[]).filter(
      (m) => m['t'] !== 'hello',
    );
    later.registry['features'] = (later.registry['features'] as Obj[]).filter(
      (f) => f['name'] !== 'presence',
    );
    later.registry['errors'] = (later.registry['errors'] as Obj[]).filter(
      (e) => e['code'] !== 'bad_message',
    );
    later.registry['closeCodes'] = (later.registry['closeCodes'] as Obj[]).filter(
      (c) => c['code'] !== 4400,
    );
    const problems = compatibilityProblems(current(), later);
    expect(problems).toContain('messages hello was removed');
    expect(problems).toContain('features presence was removed');
    expect(problems).toContain('errors bad_message was removed');
    expect(problems).toContain('closeCodes 4400 was removed');
  });

  it('reports a changed contract field of a message, such as its direction', () => {
    const later = clone();
    const hi = (later.registry['messages'] as Obj[]).find((m) => m['t'] === 'hello') as Obj;
    hi['direction'] = 's2c';
    expect(compatibilityProblems(current(), later)).toContain('messages hello: direction changed');
  });

  it('reports a field that was removed or whose shape changed', () => {
    const later = clone();
    delete helloProps(later)['versions'];
    helloProps(later)['token'] = { type: 'integer' };
    const problems = compatibilityProblems(current(), later);
    expect(problems).toContain('asyncapi Hello.versions was removed');
    expect(problems).toContain('asyncapi Hello.token changed');
  });

  it('reports a new required member and a member that stopped being required', () => {
    const later = clone();
    hello(later)['required'] = [...((hello(later)['required'] as string[]) ?? []), 'x-new'];
    helloProps(later)['x-new'] = { type: 'string' };
    expect(compatibilityProblems(current(), later)).toContain(
      'asyncapi Hello.x-new is newly required',
    );

    const relaxed = clone();
    const required = (hello(relaxed)['required'] as string[]) ?? [];
    expect(required.length).toBeGreaterThan(0);
    hello(relaxed)['required'] = required.slice(1);
    expect(compatibilityProblems(current(), relaxed)).toContain(
      `asyncapi Hello.${required[0]} is no longer required`,
    );
  });

  it('reports a removed operation and a removed response code', () => {
    const later = clone();
    const paths = later.openapi['paths'] as Record<string, Obj>;
    const path = '/tokens';
    const post = paths[path]?.['post'] as Obj;
    const responses = post['responses'] as Obj;
    delete responses['200'];
    expect(compatibilityProblems(current(), later)).toContain(
      'POST /tokens: response 200 was removed',
    );

    const gone = clone();
    Reflect.deleteProperty(gone.openapi['paths'] as Record<string, unknown>, path);
    expect(compatibilityProblems(current(), gone)).toContain('POST /tokens was removed');
  });

  it('reports a new required parameter on an existing operation, and accepts an optional one', () => {
    const required = clone();
    const paths = required.openapi['paths'] as Record<string, Obj>;
    const post = paths['/tokens']?.['post'] as Obj;
    (post['parameters'] as unknown[]).push({ name: 'X-Test', in: 'header', required: true });
    expect(compatibilityProblems(current(), required)).toContain(
      'POST /tokens: new required parameter X-Test',
    );

    const optional = clone();
    const post2 = (optional.openapi['paths'] as Record<string, Obj>)['/tokens']?.['post'] as Obj;
    (post2['parameters'] as unknown[]).push({ name: 'X-Test', in: 'header', required: false });
    expect(compatibilityProblems(current(), optional)).toEqual([]);
  });

  it('refuses a set of another major version', () => {
    const later = clone();
    later.registry['protocol'] = '2.0';
    expect(compatibilityProblems(current(), later)[0]).toMatch(/major version differs/);
  });

  it('accepts any new optional member, whatever its name (property test)', () => {
    const base = current();
    const taken = new Set(Object.keys(helloProps(base)));
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,15}$/).filter((n) => !taken.has(n)),
        (name) => {
          const later = clone();
          helloProps(later)[name] = { type: 'string' };
          expect(compatibilityProblems(current(), later)).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });
});
