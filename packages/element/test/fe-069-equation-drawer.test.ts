// FE-069: the drawer the web view draws equations with loads KaTeX with the first equation, loads
// the KaTeX fonts first when the host gave a directory, never draws an older source over a newer
// one, and never throws. Node.js, with a fake module and fake containers.
import { describe, expect, it } from 'vitest';
import { equationDrawer } from '../src/equation-drawer.ts';

type Display = Awaited<
  ReturnType<NonNullable<Parameters<typeof equationDrawer>[0]>['load'] & (() => never)>
>;

const container = (): HTMLElement => ({}) as unknown as HTMLElement;

function fake() {
  const drawn: Array<{ latex: string; display: boolean }> = [];
  const order: string[] = [];
  const module = {
    drawEquation: (_c: HTMLElement, latex: string, display: boolean) => {
      drawn.push({ latex, display });
      order.push(`draw:${latex}`);
      return { status: 'drawn' } as const;
    },
  } as unknown as Display;
  return { drawn, order, module };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('equationDrawer (FE-069)', () => {
  it('loads the module on the first draw and draws, then draws at once', async () => {
    const f = fake();
    let loads = 0;
    const draw = equationDrawer({
      load: async () => {
        loads += 1;
        return f.module;
      },
    });
    draw(container(), 'a', true);
    expect(f.drawn).toEqual([]);
    await tick();
    expect(f.drawn).toEqual([{ latex: 'a', display: true }]);
    draw(container(), 'b', false);
    expect(f.drawn.at(-1)).toEqual({ latex: 'b', display: false });
    expect(loads).toBe(1);
  });

  it('loads the fonts from the host directory before the first draw', async () => {
    const f = fake();
    const draw = equationDrawer({
      fontsUrl: 'https://host.example/katex/',
      load: async () => f.module,
      loadFonts: async (url) => {
        f.order.push(`fonts:${url}`);
      },
    });
    draw(container(), 'a', true);
    await tick();
    expect(f.order).toEqual(['fonts:https://host.example/katex/', 'draw:a']);
  });

  it('loads no fonts when the host gave no directory', async () => {
    const f = fake();
    let fonts = 0;
    const draw = equationDrawer({
      fontsUrl: null,
      load: async () => f.module,
      loadFonts: async () => {
        fonts += 1;
      },
    });
    draw(container(), 'a', true);
    await tick();
    expect(fonts).toBe(0);
    expect(f.drawn.length).toBe(1);
  });

  it('draws an equation after a font failure, and draws nothing after a module failure', async () => {
    const f = fake();
    const draw = equationDrawer({
      fontsUrl: 'https://host.example/katex/',
      load: async () => f.module,
      loadFonts: async () => {
        throw new Error('404');
      },
    });
    draw(container(), 'a', true);
    await tick();
    expect(f.drawn.length).toBe(1);

    const broken = equationDrawer({
      load: async () => {
        throw new Error('chunk failed');
      },
    });
    expect(() => broken(container(), 'a', true)).not.toThrow();
    await tick();
  });

  it('does not draw an older source over a newer one in the same container', async () => {
    const f = fake();
    const draw = equationDrawer({ load: async () => f.module });
    const c = container();
    draw(c, 'old', true);
    draw(c, 'new', true);
    await tick();
    expect(f.drawn).toEqual([{ latex: 'new', display: true }]);
  });
});
