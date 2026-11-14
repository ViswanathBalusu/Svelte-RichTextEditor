/**
 * Lengths (01 §8; 03 §2; FND-003). Every length in the CDM, font sizes included, is an integer in
 * twentieths of a point (1/1440 inch, "twips"). One point is 1/72 inch: CSS `pt` and TeX `bp`.
 */

export type Twips = number & { readonly __brand: 'Twips' };

export const TWIPS_PER_POINT = 20;
export const TWIPS_PER_INCH = 1440;

export function isTwips(value: unknown): value is Twips {
  return Number.isSafeInteger(value);
}

/** Points as a number (for display and CSS). May be fractional. */
export function twipsToPoints(twips: number): number {
  assertInteger(twips);
  return twips / TWIPS_PER_POINT;
}

/** The nearest whole number of twips for a length in points. */
export function pointsToTwips(points: number): Twips {
  if (!Number.isFinite(points)) throw new RangeError(`pointsToTwips: not finite: ${points}`);
  return Math.round(points * TWIPS_PER_POINT) as Twips;
}

/**
 * The exact decimal text of a length in TeX big points, for the LaTeX writer (09). A twentieth of a
 * point has at most two decimal places, so the result is exact: 230 → "11.5bp", 221 → "11.05bp".
 */
export function twipsToBp(twips: number): string {
  assertInteger(twips);
  const sign = twips < 0 ? '-' : '';
  const abs = Math.abs(twips);
  const whole = Math.floor(abs / 20);
  const hundredths = (abs % 20) * 5;
  if (hundredths === 0) return `${sign}${whole}bp`;
  const frac = String(hundredths).padStart(2, '0').replace(/0$/, '');
  return `${sign}${whole}.${frac}bp`;
}

/** CSS text for a length, in points. */
export function twipsToCss(twips: number): string {
  return `${twipsToBp(twips).slice(0, -2)}pt`;
}

function assertInteger(value: number): void {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`expected an integer number of twips, got ${value}`);
}
