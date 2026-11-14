/**
 * The corpus images (FND-006): tiny PNG files drawn by the generator, each with a UUID version 7
 * asset identifier. Documents refer to them by identifier only (03 §4.4: never embedded data) and
 * list the ones they use as attached assets (invariant I4).
 */
import { encodePng, type Raster } from './png.ts';
import { Rng, uuid7From } from './random.ts';
import { CORPUS_LICENCE } from './sources.ts';

/** 2026-11-06T00:00:00Z, the corpus's fixed asset timestamp (not a creation time). */
export const ASSET_EPOCH_MS = Date.UTC(2026, 10, 6);

export interface CorpusImage {
  key: ImageKey;
  id: string;
  width: number;
  height: number;
  description: string;
  bytes: Uint8Array;
}

export type ImageKey =
  'checker' | 'gradient' | 'bars' | 'rings' | 'stripes' | 'dot' | 'noise' | 'logo';

type Rgb = readonly [number, number, number];

function raster(
  width: number,
  height: number,
  channels: 3 | 4,
  paint: (x: number, y: number) => readonly number[],
): Raster {
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = paint(x, y);
      for (let c = 0; c < channels; c++) pixels[(y * width + x) * channels + c] = p[c] ?? 255;
    }
  return { width, height, channels, pixels };
}

const NAVY: Rgb = [31, 56, 100];
const SKY: Rgb = [189, 215, 238];
const WHITE: Rgb = [255, 255, 255];
const AMBER: Rgb = [237, 125, 49];
const GREEN: Rgb = [112, 173, 71];

interface Recipe {
  key: ImageKey;
  description: string;
  draw: (rng: Rng) => Raster;
}

const RECIPES: readonly Recipe[] = [
  {
    key: 'checker',
    description: 'A 16 by 16 checkerboard in navy and light blue.',
    draw: () => raster(16, 16, 3, (x, y) => (((x >> 1) + (y >> 1)) % 2 ? NAVY : SKY)),
  },
  {
    key: 'gradient',
    description: 'A 32 by 16 horizontal gradient from navy to amber.',
    draw: () =>
      raster(32, 16, 3, (x) => {
        const t = x / 31;
        return NAVY.map((c, i) => Math.round(c + (AMBER[i]! - c) * t));
      }),
  },
  {
    key: 'bars',
    description: 'A 48 by 32 bar chart with six bars of seeded heights on white.',
    draw: (rng) => {
      const heights = Array.from({ length: 6 }, () => rng.range(6, 28));
      return raster(48, 32, 3, (x, y) => {
        const bar = Math.floor(x / 8);
        const inBar = x % 8 >= 1 && x % 8 <= 6;
        return inBar && 31 - y < heights[bar]! ? (bar % 2 ? AMBER : NAVY) : WHITE;
      });
    },
  },
  {
    key: 'rings',
    description: 'A 32 by 32 pattern of concentric squares in three colours.',
    draw: () =>
      raster(32, 32, 3, (x, y) => {
        const d = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5));
        return [NAVY, SKY, GREEN][Math.floor(d / 3) % 3]!;
      }),
  },
  {
    key: 'stripes',
    description: 'A 24 by 24 pattern of diagonal stripes.',
    draw: () => raster(24, 24, 3, (x, y) => ((x + y) % 6 < 3 ? GREEN : WHITE)),
  },
  {
    key: 'dot',
    description: 'An 8 by 8 amber dot on a transparent background (RGBA), used inline.',
    draw: () =>
      raster(8, 8, 4, (x, y) => {
        const inside = (x - 3.5) ** 2 + (y - 3.5) ** 2 <= 12.25;
        return inside ? [...AMBER, 255] : [0, 0, 0, 0];
      }),
  },
  {
    key: 'noise',
    description: 'A 40 by 24 field of seeded random colours, which does not compress.',
    draw: (rng) => raster(40, 24, 3, () => [rng.int(256), rng.int(256), rng.int(256)]),
  },
  {
    key: 'logo',
    description: 'A 24 by 12 mark for headers: a navy block with an amber bar.',
    draw: () => raster(24, 12, 3, (x, y) => (y >= 4 && y < 8 && x >= 4 && x < 20 ? AMBER : NAVY)),
  },
];

let cache: readonly CorpusImage[] | undefined;

/** Every corpus image, in a fixed order. Identifiers and bytes are the same on every run. */
export function corpusImages(): readonly CorpusImage[] {
  if (cache) return cache;
  const idRng = new Rng('docedit-corpus/assets/ids');
  cache = RECIPES.map((recipe, i) => {
    const r = recipe.draw(new Rng(`docedit-corpus/assets/${recipe.key}`));
    return {
      key: recipe.key,
      id: uuid7From(idRng, ASSET_EPOCH_MS + i),
      width: r.width,
      height: r.height,
      description: recipe.description,
      bytes: encodePng(r),
    };
  });
  return cache;
}

export function imageByKey(key: ImageKey): CorpusImage {
  const image = corpusImages().find((i) => i.key === key);
  if (!image) throw new RangeError(`no corpus image "${key}"`);
  return image;
}

export const IMAGE_LICENCE = CORPUS_LICENCE.id;
