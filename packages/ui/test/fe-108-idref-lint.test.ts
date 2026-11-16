/**
 * FE-108 criterion 2: the ID-reference rule (support/idref-lint.ts) over every component of the
 * shell. A component that references an element it does not own fails this test, and with it
 * `pnpm test` and `pnpm check`. The first block shows the rule can fail.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDREF_ATTRIBUTES, expressionShapes, idrefFindings, scan } from './support/idref-lint.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function components(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return components(full);
    return name.endsWith('.svelte') ? [full] : [];
  });
}

const component = (script: string, markup: string) =>
  `<script lang="ts">\n${script}\n</script>\n\n${markup}\n`;

describe('the ID-reference rule (FE-108 criterion 2)', () => {
  it('passes a reference to an id of the same component, literal or generated', () => {
    const source = component(
      'const id = `x-${n}`;\nconst titleId = `${id}-title`;\nfunction reasonId(i: Item) {\n  return `${id}-reason-${i.id}`;\n}',
      [
        '<h2 id={titleId}>T</h2>',
        '<div role="dialog" aria-labelledby={titleId} aria-describedby="hint"></div>',
        '<p id="hint">H</p>',
        '<label for="{id}-name">N</label><input id={`${id}-name`} />',
        '<button aria-describedby={item.enabled ? undefined : reasonId(item)}>B</button>',
        '<span id={reasonId(item)}>R</span>',
        '<input aria-describedby={`${id}-a ${id}-b`} /><i id="{id}-a"></i><i id={`${id}-b`}></i>',
      ].join('\n'),
    );
    expect(idrefFindings(source, 'Ok.svelte')).toEqual([]);
  });

  it('follows a list built in the script to its members', () => {
    const source = component(
      "const id = 'c';\nconst describedBy = $derived([busy ? `${id}-busy` : undefined, `${id}-hint`].filter(Boolean).join(' '));",
      '<textarea aria-describedby={describedBy}></textarea>\n<p id={`${id}-busy`}></p><p id="{id}-hint"></p>',
    );
    expect(idrefFindings(source, 'List.svelte')).toEqual([]);
  });

  it('fails a reference to an id that comes from a property', () => {
    const source = component(
      'let { labelId }: { labelId: string } = $props();',
      '<input aria-labelledby={labelId} />',
    );
    const findings = idrefFindings(source, 'Prop.svelte');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      attribute: 'aria-labelledby',
      line: 5,
      file: 'Prop.svelte',
    });
    expect(findings[0]!.message).toContain('name:labelId');
  });

  it('fails a literal that no element of the component carries, and one missing member of a list', () => {
    const source = component(
      '',
      '<label for="outside">L</label>\n<input id="inside" aria-describedby="inside elsewhere" />',
    );
    expect(idrefFindings(source, 'Literal.svelte').map((f) => [f.attribute, f.line])).toEqual([
      ['for', 5],
      ['aria-describedby', 6],
    ]);
  });

  it("fails when only one side of a condition is the component's own", () => {
    const source = component(
      'let { other }: { other: string } = $props();',
      '<button aria-controls={open ? "menu" : other}>B</button><ul id="menu"></ul>',
    );
    expect(idrefFindings(source, 'Half.svelte')).toHaveLength(1);
  });

  it('reads every reference attribute, and not attributes that only end like one', () => {
    const { ids, references } = scan(
      '<a id="a" data-for="x" aria-owns="a" aria-activedescendant={current} aria-details="a"\n aria-errormessage="a" aria-flowto="a" aria-controls="a" for="a"></a>',
    );
    expect(ids.map((i) => i.value)).toEqual(['"a"']);
    expect(references.map((r) => r.attribute)).toEqual([
      'aria-owns',
      'aria-activedescendant',
      'aria-details',
      'aria-errormessage',
      'aria-flowto',
      'aria-controls',
      'for',
    ]);
    expect(expressionShapes('a?.b ?? `${x}-y`')).toEqual(['name:a?.b', 'id:${}-y']);
  });
});

describe('every component of the shell keeps its ID references to itself (FE-108 criterion 2)', () => {
  const files = components(SRC);

  it('finds the components and their references', () => {
    // Non-vacuity: the rule reads real components and real references.
    expect(files.length).toBeGreaterThan(20);
    const total = files.reduce((n, f) => n + scan(readFileSync(f, 'utf8')).references.length, 0);
    expect(total).toBeGreaterThan(40);
  });

  it('has no reference to an id outside the component', () => {
    const findings = files.flatMap((f) =>
      idrefFindings(readFileSync(f, 'utf8'), relative(SRC, f).replaceAll('\\', '/')),
    );
    expect(findings.map((f) => `${f.file}:${f.line} ${f.message}`)).toEqual([]);
  });
});

describe('no ID reference is set from script (FE-108 criterion 2)', () => {
  // The rule reads component markup. A reference set with `setAttribute` or a reflected property in
  // the shell, the element, the editing core or the painter would escape it, so there may be none.
  // (The PDF viewer's page is a document of its own, in a frame, and is not part of any root.)
  function scripts(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === 'node_modules' || name === 'dist' || name === 'generated') return [];
      if (statSync(full).isDirectory()) return scripts(full);
      return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  }

  it('finds none in the shell, the element, the core or the painter', () => {
    const packages = join(SRC, '..', '..');
    const sources = ['ui/src', 'element/src', 'engine/src', 'painter/src'].flatMap((d) =>
      scripts(join(packages, d)),
    );
    expect(sources.length).toBeGreaterThan(100);
    const attributes = IDREF_ATTRIBUTES.join('|');
    const set = new RegExp(
      `setAttribute\\(\\s*['"\`](?:${attributes})['"\`]|\\.htmlFor\\b|\\.aria(?:LabelledBy|DescribedBy|Controls|Owns|ActiveDescendant|Details|ErrorMessage|FlowTo)Elements?\\b`,
    );
    const hits = sources
      .filter((f) => set.test(readFileSync(f, 'utf8')))
      .map((f) => relative(packages, f).replaceAll('\\', '/'));
    expect(hits).toEqual([]);
  });
});
