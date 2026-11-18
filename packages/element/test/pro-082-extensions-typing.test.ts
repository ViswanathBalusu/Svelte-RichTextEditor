// PRO-082 criterion 4: the type of the `extensions` property is published and documented in the
// element's typings (`HostExtension`, `HostExtensionApi`, `HostExtensionManifest`, exported from
// the package entry point). The checks of the types are made by the compiler through
// `pnpm --filter @docedit/element run typecheck` (tsconfig.test.json includes this file); the run
// time checks read the entry point and the property's behaviour for values that are not arrays.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  DocEditorElement,
  HostExtension,
  HostExtensionApi,
  HostExtensionManifest,
} from '../src/index.ts';

const src = (name: string) => readFileSync(join(import.meta.dirname, '..', 'src', name), 'utf8');

describe('the typings of the extensions property (PRO-082 criterion 4)', () => {
  it('types the property as an array of HostExtension', () => {
    expectTypeOf<DocEditorElement['extensions']>().toEqualTypeOf<readonly HostExtension[]>();
  });

  it('types an entry: a manifest with id, name and apiVersion, and an activate that takes the API', () => {
    expectTypeOf<HostExtension['manifest']>().toEqualTypeOf<HostExtensionManifest>();
    expectTypeOf<HostExtensionManifest['id']>().toEqualTypeOf<string>();
    expectTypeOf<HostExtensionManifest['name']>().toEqualTypeOf<string>();
    expectTypeOf<HostExtensionManifest['apiVersion']>().toEqualTypeOf<string>();
    expectTypeOf<HostExtension['activate']>().toEqualTypeOf<(api: HostExtensionApi) => void>();
    expectTypeOf<HostExtensionApi['onRemove']>().toEqualTypeOf<(dispose: () => void) => void>();
  });

  it('accepts a manifest with a key the editor does not know (PRO-005)', () => {
    const entry: HostExtension = {
      manifest: { id: 'acme.hello', name: 'Hello', apiVersion: '1', futureKey: { any: 1 } },
      activate: () => {},
    };
    expect(entry.manifest['futureKey']).toEqual({ any: 1 });
  });

  it('documents the type, and the entry point exports it', () => {
    const doc = src('extensions.ts');
    expect(doc).toMatch(/PRO-082 criterion 4/);
    for (const name of ['HostExtension', 'HostExtensionApi', 'HostExtensionManifest'])
      expect(doc, name).toMatch(new RegExp(String.raw`/\*\*[^]*?\*/\s*export interface ${name}\b`));
    expect(src('index.ts')).toMatch(
      /export type \{[^}]*HostExtension,[^}]*HostExtensionApi,[^}]*HostExtensionManifest[^}]*\} from '\.\/extensions\.ts';/,
    );
    expect(src('doc-editor.ts')).toMatch(/get extensions\(\): readonly HostExtension\[\]/);
  });
});
