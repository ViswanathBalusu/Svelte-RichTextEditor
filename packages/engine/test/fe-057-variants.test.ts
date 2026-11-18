/**
 * The header and footer panel's variants (FE-057 criteria 1 and 2): the core lists the variants the
 * page setup uses for the header and the footer, opens the story a variant names, and creates the
 * story of a variant that has none, through the guard, before opening it.
 *
 * Run with `pnpm exec vitest run --project node packages/engine/test/fe-057-variants.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { contractDocument, editorAccess, ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

interface J {
  type: string;
  attrs?: Record<string, unknown>;
  content?: J[];
}

/** The contract document with the page setup's flags set. */
function withFlags(flags: Record<string, boolean>): CdmEnvelope {
  const env = contractDocument();
  const defs = (env.doc as unknown as J).content!.find((n) => n.type === 'defs')!;
  const setup = defs.content!.find((n) => n.type === 'page_setup')!;
  setup.attrs = { ...setup.attrs, ...flags };
  return env;
}

function core(env: CdmEnvelope, access = ownerAccess()): DocumentCore {
  return new DocumentCore({ doc: env, access, schedule: microtask });
}

/** The stories of the document: kind and identifier, in order. */
function stories(c: DocumentCore): Array<{ kind: string; id: string }> {
  const out: Array<{ kind: string; id: string }> = [];
  internals(c).state.doc.forEach((n) => {
    if (n.type.name === 'story')
      out.push({ kind: String(n.attrs['kind']), id: String(n.attrs['id']) });
  });
  return out;
}

const pair = (c: DocumentCore) => c.storyVariants().map((v) => `${v.part}:${v.variant}`);

describe('the variants the panel offers (FE-057 criterion 1)', () => {
  it('offers only the default variant of the header and the footer when no flag is on', () => {
    expect(pair(core(withFlags({})))).toEqual(['header:default', 'footer:default']);
  });

  it('offers the first-page and even-page variants when the page setup uses them', () => {
    const c = core(withFlags({ differentFirstPage: true, differentOddEven: true }));
    expect(pair(c)).toEqual([
      'header:default',
      'header:first',
      'header:even',
      'footer:default',
      'footer:first',
      'footer:even',
    ]);
    expect(c.storyVariants().every((v) => v.story === null && v.editable)).toBe(true);
  });

  it('opens the story a variant names, and says which part and variant the panel shows', () => {
    const c = core(withFlags({ differentFirstPage: true }));
    expect(c.editStory('header', 'first')).toBe(true);
    expect(c.editStory('footer', 'default')).toBe(true);
    const [header, footer] = [
      stories(c).find((s) => s.kind === 'header')!,
      stories(c).find((s) => s.kind === 'footer')!,
    ];
    // Opening the header again, by its variant, gives the same story back.
    expect(c.editStory('header', 'first')).toBe(true);
    expect(c.panel.get()).toEqual({
      kind: 'story',
      id: header.id,
      label: 'Header',
      part: 'header',
      variant: 'first',
    });
    expect(c.editStory('footer', 'default')).toBe(true);
    expect(c.panel.get()).toEqual({
      kind: 'story',
      id: footer.id,
      label: 'Footer',
      part: 'footer',
      variant: 'default',
    });
    // The variants now name their stories.
    const named = c.storyVariants().filter((v) => v.story !== null);
    expect(named.map((v) => `${v.part}:${v.variant}`)).toEqual(['header:first', 'footer:default']);
  });

  it('refuses a variant the page setup does not use', () => {
    const c = core(withFlags({}));
    expect(c.editStory('header', 'first')).toBe(false);
    expect(c.editStory('footer', 'even')).toBe(false);
    expect(stories(c)).toEqual([]);
    expect(c.panel.get()).toBeNull();
  });
});

describe('a variant with no story is created when the user starts to edit it (FE-057 criterion 2)', () => {
  it('creates a footer story, names it in the page setup and opens it', () => {
    const c = core(withFlags({}));
    expect(stories(c)).toEqual([]);
    expect(c.editStory('footer', 'default')).toBe(true);
    const made = stories(c);
    expect(made).toHaveLength(1);
    expect(made[0]!.kind).toBe('footer');
    expect(c.storyVariants().find((v) => v.part === 'footer')!.story).toBe(made[0]!.id);
    expect(c.panel.get()?.id).toBe(made[0]!.id);
    // A second request opens the same story and makes no other.
    expect(c.editStory('footer', 'default')).toBe(true);
    expect(stories(c)).toEqual(made);
  });

  it('creates the story of a first-page header and of an even-page footer, each once', () => {
    const c = core(withFlags({ differentFirstPage: true, differentOddEven: true }));
    expect(c.editStory('header', 'first')).toBe(true);
    expect(c.editStory('footer', 'even')).toBe(true);
    expect(stories(c).map((s) => s.kind)).toEqual(['header', 'footer']);
    expect(
      c
        .storyVariants()
        .filter((v) => v.story !== null)
        .map((v) => `${v.part}:${v.variant}`),
    ).toEqual(['header:first', 'footer:even']);
  });

  it('refuses the creation for a person who may not change the structure, and makes no story', () => {
    const c = core(withFlags({ differentFirstPage: true }), editorAccess());
    expect(c.storyVariants().every((v) => !v.editable)).toBe(true);
    expect(c.editStory('footer', 'default')).toBe(false);
    expect(c.editStory('header', 'first')).toBe(false);
    expect(stories(c)).toEqual([]);
    expect(c.panel.get()).toBeNull();
  });
});
