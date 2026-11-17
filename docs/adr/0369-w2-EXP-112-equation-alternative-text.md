# ADR 0369: The text alternative of a tagged equation (lane w2, EXP-112)

Status: proposed. The owner has not decided this. EXP-112 criterion 5 is ticked on the default below.

## Context

EXP-112 criterion 5 asks that an equation in a tagged PDF is tagged and has a text alternative. The
story's Notes say the content of that alternative, and whether PDF/UA-2's mathematics support is
used, are not specified (09 Open questions).

`latex-lab-math` of the worker image (TeX Live 2026) tags every math formula as a `Formula`
element. It writes an alternative text only when `math/alt/use` is on, and then it takes the
source wrapped in "LaTeX formula starts ... LaTeX formula ends". For a display equation the source
it reads includes the class's own `\DE@clipmath` macro.

## Decision proposed

- The alternative text of an equation is its LaTeX source, as the converter wrote it (the
  `latex` attribute of the equation node, after the math gate).
- The class does this with its own plug for the `math/content` socket of `latex-lab-math`
  (`class/docedit.cls`, class 0.2.9). The plug reads two private variables of that module
  (`\l__math_content_alt_tl` and its siblings). The class checks that they exist and falls back to
  the module's default when they do not. A new TeX Live image therefore needs the test to be run
  again (`packages/export-latex/src/exp-112-structure.compile.test.ts`).
- The TeX source stays attached as an associated file, as `latex-lab-math` does by default. No
  MathML is written: `math/mathml` needs `luamml` and was not tried.
- Spoken-form alternatives ("x squared") are not generated. Reading LaTeX aloud is poor for a
  listener, and it is what many authoring tools do first. A spoken form needs a converter from
  LaTeX to words, which is a decision about a new component.

## What the owner decides

1. Accept the LaTeX source as the alternative text, or ask for a spoken form (a new converter), or
   ask for MathML through `luamml` and PDF/UA-2's mathematics support.
2. Whether the author may write an alternative text on the equation node (the model has no such
   attribute today; the figure has `alt`).
