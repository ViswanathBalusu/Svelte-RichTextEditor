/**
 * Splitting a table row that is taller than a page (09 §3.2; EXP-039). A pure function, so that
 * the rule can be tested before the converter has a height measure:
 *
 * - the row is cut at block boundaries only, never inside a block (paragraph, picture, equation);
 * - each part of the row takes, from every cell, the next blocks that still fit together with the
 *   blocks already taken for that part (round robin over the cells, so the cells stay in step);
 * - a block that does not fit even alone is put in a part of its own and reported, with its cell
 *   and its index, so that the caller can name the block in a diagnostic (EXP-039 criterion 3);
 * - the text of each cell is the concatenation of its parts, in order, so nothing is lost.
 *
 * The measure is the caller's: `fits` says whether a part (one list of blocks per cell) fits on a
 * page. How the converter measures a row is not specified yet (EXP-039 Notes; ADR 0143, question 2).
 * A part may hold an empty list for a cell; the caller writes an empty paragraph there.
 */

export interface RowSplit<T> {
  /** `parts[p][c]`: the blocks of cell `c` in continuation row `p`. Always at least one part. */
  readonly parts: readonly (readonly (readonly T[])[])[];
  /** Blocks that did not fit alone on a page, in the order they were met. */
  readonly unsplittable: readonly { readonly cell: number; readonly index: number }[];
}

export function splitRow<T>(
  cells: readonly (readonly T[])[],
  fits: (part: readonly (readonly T[])[]) => boolean,
): RowSplit<T> {
  const cursor: number[] = cells.map(() => 0);
  const parts: (readonly T[])[][] = [];
  const unsplittable: { cell: number; index: number }[] = [];
  const remaining = (): boolean => cells.some((c, i) => cursor[i]! < c.length);

  if (!remaining()) return { parts: [cells.map(() => [])], unsplittable };

  while (remaining()) {
    const part: T[][] = cells.map(() => []);
    // Round robin: each pass gives every cell one more block if the part still fits.
    let grew = true;
    while (grew) {
      grew = false;
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c]!;
        const next = cursor[c]!;
        if (next >= cell.length) continue;
        part[c]!.push(cell[next]!);
        if (fits(part)) {
          cursor[c] = next + 1;
          grew = true;
        } else part[c]!.pop();
      }
    }
    if (part.every((p) => p.length === 0)) {
      // No block fits even alone: the first block that is left goes on a page of its own.
      const c = cells.findIndex((cell, i) => cursor[i]! < cell.length);
      const index = cursor[c]!;
      unsplittable.push({ cell: c, index });
      part[c]!.push(cells[c]![index]!);
      cursor[c] = index + 1;
    }
    parts.push(part);
  }
  return { parts, unsplittable };
}
