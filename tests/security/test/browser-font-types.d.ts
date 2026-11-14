// The two browser font names that packages/element/src/font-loader.ts uses in type positions. This
// suite type-checks without the DOM lib (Node.js only; 01 §6), and the DOM lib would conflict with
// the Node.js request bodies of the service sources it also compiles. Only the members the loader
// reads are declared; the element package keeps the full DOM typing in its own tsconfig.
export {};

declare global {
  interface FontFace {
    readonly family: string;
  }

  interface FontFaceSet extends Iterable<FontFace> {
    add(face: FontFace): FontFaceSet;
  }

  var FontFace: {
    new (
      family: string,
      source: string,
      descriptors?: { style?: string; weight?: string },
    ): FontFace;
  };
}
