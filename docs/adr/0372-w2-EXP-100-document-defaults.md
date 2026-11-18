# 0372. Document defaults of a Word file become values of the default paragraph style

Status: proposed (lane w2, 2026-11-17). Not an owner decision.

## Context

EXP-100 criterion 5 says the document defaults of a Word file become `settings` and the default paragraph style. In Word, `w:docDefaults` of `styles.xml` holds paragraph and run values (`w:pPrDefault`, `w:rPrDefault`) that sit below every style. The model has no such layer: the cascade (03 §6, ADR 0032) goes from the base values (layer 0) through the style chain. The earlier import read only the language, into `settings.lang`.

## Decision (proposed)

1. The language stays in `settings.lang`.
2. The other values of `w:docDefaults` are read with the same lenses as the pPr and rPr of a style, and merged into the style that `settings.defaultParagraphStyle` names, for every property that style leaves unset. A value the style sets itself wins, as it does in Word.
3. A default style that has a `basedOn` is left alone, because merging would override its parent's value.
4. A file without a default paragraph style gets the synthetic `Normal` that the importer already adds, and it takes the defaults.

## Consequences

- The editor shows the text as Word does when the default style is in the chain, which is the usual case. A style that is not based on the default style does not receive the defaults. This differs from Word for such a style.
- The merged values are part of the imported `style_def`. An edit to that style makes the writer state them in the style's own `w:pPr` and `w:rPr`. Word reads the same result, but the bytes of that style differ from the source. An unedited style keeps its source bytes.
- `w:docDefaults` itself stays in the source part and is kept by the patch writer (ADR 0017).
- The alternative is a new layer between the base values and the style chain in 03 §6. That is a change to the cascade and the resolver, so it is the owner's decision.
