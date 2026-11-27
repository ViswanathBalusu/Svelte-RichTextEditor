/**
 * Office math (`m:oMath`) for the tree of `math.ts`, in both directions (09 §6.1; EXP-096 writes it,
 * EXP-105 reads it). The writer builds XML only through the escaping of `writer-xml.ts`. The reader
 * takes an element of a parsed part and accepts only the elements below; any other element, or a
 * character the tables of `math.ts` do not know, is "not converted" (`MathConvertError`), never a
 * guess. Both directions are bounded as the LaTeX reader is.
 */
import {
  ACCENT_NAME,
  FROM_DOUBLE_STRUCK,
  LETTER_NAME,
  MATH_LIMITS,
  MathConvertError,
  NARY_OF,
  isOperatorChar,
  parseLatex,
  toLatex,
  type MathNode,
} from './math.ts';
import { el, textElement } from './writer-xml.ts';
import { type XmlElement, attr, elements, nameOf, textContent } from './xml.ts';

export const OMML_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

// ---------------------------------------------------------------------------------------------
// Tree to Office math.

const m = (name: string, attrs: Record<string, string> = {}, ...kids: string[]): string =>
  el(`m:${name}`, attrs, ...kids);
const val = (name: string, v: string): string => m(name, { 'm:val': v });

function run(text: string, props = ''): string {
  return m('r', {}, props ? m('rPr', {}, props) : '', textElement('m:t', text));
}

function content(n: MathNode): string {
  return n.k === 'row' ? n.items.map(content).join('') : write(n);
}

const slot = (name: string, n: MathNode | null): string => m(name, {}, n ? content(n) : '');

function write(n: MathNode): string {
  switch (n.k) {
    case 'row':
      return content(n);
    case 'mi':
      return run(n.text, n.style ? val('sty', n.style) : '');
    case 'mn':
    case 'mo':
      return run(n.text);
    case 'mtext':
      return run(n.text, m('nor'));
    case 'script': {
      const e = slot('e', n.base);
      if (n.sub && n.sup) return m('sSubSup', {}, e, slot('sub', n.sub), slot('sup', n.sup));
      if (n.sub) return m('sSub', {}, e, slot('sub', n.sub));
      return m('sSup', {}, e, slot('sup', n.sup));
    }
    case 'frac':
      return m(
        'f',
        {},
        n.bar ? '' : m('fPr', {}, val('type', 'noBar')),
        slot('num', n.num),
        slot('den', n.den),
      );
    case 'root':
      return m(
        'rad',
        {},
        n.degree ? '' : m('radPr', {}, val('degHide', '1')),
        slot('deg', n.degree),
        slot('e', n.body),
      );
    case 'nary':
      return m(
        'nary',
        {},
        m(
          'naryPr',
          {},
          val('chr', n.op),
          val('limLoc', n.under ? 'undOvr' : 'subSup'),
          n.sub ? '' : val('subHide', '1'),
          n.sup ? '' : val('supHide', '1'),
        ),
        slot('sub', n.sub),
        slot('sup', n.sup),
        slot('e', n.body),
      );
    case 'fence':
      return m(
        'd',
        {},
        m('dPr', {}, val('begChr', n.open), val('endChr', n.close)),
        slot('e', n.body),
      );
    case 'accent':
      return m('acc', {}, m('accPr', {}, val('chr', n.mark)), slot('e', n.base));
    case 'bar':
      return m('bar', {}, m('barPr', {}, val('pos', n.bottom ? 'bot' : 'top')), slot('e', n.base));
    case 'limit': {
      const low = n.under ? m('limLow', {}, slot('e', n.base), slot('lim', n.under)) : null;
      // Both: the upper limit is on the lower one, as Word nests them.
      if (!n.over) return low ?? content(n.base);
      return m('limUpp', {}, low ? m('e', {}, low) : slot('e', n.base), slot('lim', n.over));
    }
    case 'matrix':
      return m('m', {}, ...n.rows.map((r) => m('mr', {}, ...r.map((c) => slot('e', c)))));
  }
}

/**
 * Office math for a LaTeX equation: `m:oMathPara` holding one `m:oMath` for a display equation,
 * `m:oMath` for an inline one. The namespace is declared on the element, so the result can be put
 * into any part. Throws `MathConvertError` when the LaTeX is not of the allow-list.
 */
export function latexToOmml(latex: string, display: boolean): string {
  const body = content(parseLatex(latex));
  const math = el('m:oMath', display ? {} : { 'xmlns:m': OMML_NS }, body);
  return display ? el('m:oMathPara', { 'xmlns:m': OMML_NS }, math) : math;
}

/** As `latexToOmml`, but an `m:oMath` always (a numbered display equation shares its paragraph). */
export function latexToOmmlInline(latex: string): string {
  return latexToOmml(latex, false);
}

// ---------------------------------------------------------------------------------------------
// Office math to tree.

/** Other characters Word and other writers use for the accents of the table (read, never written). */
const ACCENT_ALIASES: Readonly<Record<string, string>> = {
  '̅': '̄',
  '¯': '̄',
  ˆ: '̂',
  '˜': '̃',
  '˙': '̇',
  '¨': '̈',
  '→': '⃗',
};

const flag = (e: XmlElement | undefined): boolean => {
  if (!e) return false;
  const v = attr(e, OMML_NS, 'val');
  return v === undefined || !(v === '0' || v === 'false' || v === 'off');
};

class Reader {
  private depth = 0;
  private nodes = 0;

  private fail(why: string): never {
    throw new MathConvertError(why);
  }

  private inMath(e: XmlElement): boolean {
    return e.ns === OMML_NS;
  }

  private child(e: XmlElement, local: string): XmlElement | undefined {
    return elements(e).find((c) => this.inMath(c) && c.local === local);
  }

  private pr(e: XmlElement, pr: string, prop: string): string | undefined {
    const p = this.child(e, pr);
    const q = p && this.child(p, prop);
    return q ? (attr(q, OMML_NS, 'val') ?? '') : undefined;
  }

  /** The content of an element that holds math (`m:e`, `m:num`, and so on). */
  private body(e: XmlElement | undefined): MathNode {
    if (!e) return { k: 'row', items: [] };
    if (++this.depth > MATH_LIMITS.depth) this.fail('the equation is nested too deeply');
    const items: MathNode[] = [];
    for (const c of elements(e)) {
      if (!this.inMath(c)) {
        // Word's own run properties may sit beside math; nothing else is read.
        if (nameOf(c) === 'w:rPr') continue;
        this.fail(`the element ${c.qname} is not Office math`);
      }
      if (c.local.endsWith('Pr') || c.local === 'ctrlPr') continue;
      items.push(...this.one(c));
    }
    this.depth--;
    return items.length === 1 ? items[0]! : { k: 'row', items };
  }

  private one(e: XmlElement): MathNode[] {
    if (++this.nodes > MATH_LIMITS.nodes) this.fail('the equation has too many parts');
    switch (e.local) {
      case 'r':
        return this.run(e);
      case 'f': {
        const type = this.pr(e, 'fPr', 'type');
        if (type !== undefined && type !== 'bar' && type !== 'noBar')
          this.fail('a fraction of a kind that is not on the list');
        return [
          {
            k: 'frac',
            num: this.body(this.child(e, 'num')),
            den: this.body(this.child(e, 'den')),
            bar: type !== 'noBar',
          },
        ];
      }
      case 'rad': {
        const hide = this.child(this.child(e, 'radPr') ?? e, 'degHide');
        const degree = flag(hide) ? null : this.body(this.child(e, 'deg'));
        return [{ k: 'root', body: this.body(this.child(e, 'e')), degree }];
      }
      case 'sSub':
      case 'sSup':
      case 'sSubSup': {
        // Word leaves empty placeholders for a script that was never typed: no script then.
        const filled = (n: MathNode): MathNode | null =>
          n.k === 'row' && n.items.length === 0 ? null : n;
        const base = this.body(this.child(e, 'e'));
        const sub = e.local === 'sSup' ? null : filled(this.body(this.child(e, 'sub')));
        const sup = e.local === 'sSub' ? null : filled(this.body(this.child(e, 'sup')));
        if (!sub && !sup) return base.k === 'row' ? base.items : [base];
        return [{ k: 'script', base, sub, sup }];
      }
      case 'nary': {
        const op = this.pr(e, 'naryPr', 'chr') ?? '∫';
        const spec = NARY_OF.get(op);
        if (!spec) this.fail('a big operator that is not on the list');
        const loc = this.pr(e, 'naryPr', 'limLoc');
        const props = this.child(e, 'naryPr');
        const subHide = props && flag(this.child(props, 'subHide'));
        const supHide = props && flag(this.child(props, 'supHide'));
        return [
          {
            k: 'nary',
            op,
            under: loc === undefined ? spec.under : loc === 'undOvr',
            sub: subHide ? null : this.body(this.child(e, 'sub')),
            sup: supHide ? null : this.body(this.child(e, 'sup')),
            body: this.body(this.child(e, 'e')),
          },
        ];
      }
      case 'd': {
        const open = this.pr(e, 'dPr', 'begChr') ?? '(';
        const close = this.pr(e, 'dPr', 'endChr') ?? ')';
        const sep = this.pr(e, 'dPr', 'sepChr') ?? '|';
        const parts = elements(e).filter((c) => this.inMath(c) && c.local === 'e');
        if (!parts.length) this.fail('a delimiter pair with nothing in it');
        const items: MathNode[] = [];
        parts.forEach((p, i) => {
          if (i > 0) items.push({ k: 'mo', text: sep });
          items.push(this.body(p));
        });
        return [
          { k: 'fence', open, close, body: items.length === 1 ? items[0]! : { k: 'row', items } },
        ];
      }
      case 'acc': {
        const raw = this.pr(e, 'accPr', 'chr') ?? '̂';
        const mark = ACCENT_ALIASES[raw] ?? raw;
        if (!(mark in ACCENT_NAME)) this.fail('an accent that is not on the list');
        return [{ k: 'accent', mark, base: this.body(this.child(e, 'e')) }];
      }
      case 'bar': {
        const pos = this.pr(e, 'barPr', 'pos') ?? 'bot';
        return [{ k: 'bar', bottom: pos !== 'top', base: this.body(this.child(e, 'e')) }];
      }
      case 'limLow':
      case 'limUpp': {
        const base = this.body(this.child(e, 'e'));
        const lim = this.body(this.child(e, 'lim'));
        if (base.k === 'limit' && e.local === 'limUpp' && base.over === null)
          return [{ k: 'limit', base: base.base, under: base.under, over: lim }];
        if (base.k !== 'mi' || base.style !== 'p')
          this.fail('a limit under or over something that is not a function name');
        return [
          e.local === 'limLow'
            ? { k: 'limit', base, under: lim, over: null }
            : { k: 'limit', base, under: null, over: lim },
        ];
      }
      case 'func': {
        const name = this.body(this.child(e, 'fName'));
        const arg = this.body(this.child(e, 'e'));
        const named = name.k === 'row' ? name.items : [name];
        return [...named, ...(arg.k === 'row' ? arg.items : [arg])];
      }
      case 'm': {
        const rows = elements(e)
          .filter((c) => this.inMath(c) && c.local === 'mr')
          .map((r) =>
            elements(r)
              .filter((c) => this.inMath(c) && c.local === 'e')
              .map((c) => this.body(c)),
          );
        const width = rows[0]?.length ?? 0;
        if (!rows.length || rows.some((r) => r.length !== width))
          this.fail('a matrix with rows of different widths');
        return [{ k: 'matrix', rows }];
      }
      default:
        return this.fail(`the Office math element m:${e.local} is not on the list`);
    }
  }

  /** The text of a run, as nodes: letters one by one, digits as numbers, the rest as operators. */
  private run(r: XmlElement): MathNode[] {
    const props = this.child(r, 'rPr');
    const nor = !!props && flag(this.child(props, 'nor'));
    const sty = props ? this.child(props, 'sty') : undefined;
    const style = sty ? (attr(sty, OMML_NS, 'val') ?? 'i') : undefined;
    const text = elements(r)
      .filter((c) => this.inMath(c) && c.local === 't')
      .map((t) => textContent(t))
      .join('');
    if (!text) return [];
    if (nor) return [{ k: 'mtext', text }];
    if (style !== undefined && style !== 'i' && style !== 'p' && style !== 'b')
      this.fail('a letter style that is not on the list');
    const out: MathNode[] = [];
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (/[A-Za-z]/.test(c)) {
        if (style === 'p' || style === 'b') {
          // Upright or bold letters form one name.
          let name = c;
          while (i + 1 < chars.length && /[A-Za-z0-9]/.test(chars[i + 1]!)) name += chars[++i];
          out.push({ k: 'mi', text: name, style });
        } else out.push({ k: 'mi', text: c });
      } else if (/[0-9]/.test(c)) {
        let num = c;
        while (
          i + 1 < chars.length &&
          (/[0-9]/.test(chars[i + 1]!) ||
            (chars[i + 1] === '.' && /[0-9]/.test(chars[i + 2] ?? '')))
        )
          num += chars[++i];
        out.push({ k: 'mn', text: num });
      } else if (c === ' ') out.push({ k: 'mo', text: ' ' });
      else if (c === '-') out.push({ k: 'mo', text: '−' });
      else if (c === '*') out.push({ k: 'mo', text: '∗' });
      else if (LETTER_NAME.has(c) || FROM_DOUBLE_STRUCK.has(c)) out.push({ k: 'mi', text: c });
      else if (isOperatorChar(c)) out.push({ k: 'mo', text: c });
      else this.fail(`the character ${JSON.stringify(c)} is not on the list`);
    }
    return out;
  }

  /** Reads `m:oMath`, or `m:oMathPara` holding one. */
  root(e: XmlElement): MathNode {
    if (!this.inMath(e)) this.fail('not Office math');
    if (e.local === 'oMathPara') {
      const maths = elements(e).filter((c) => this.inMath(c) && c.local === 'oMath');
      const others = elements(e).filter(
        (c) => !(this.inMath(c) && (c.local === 'oMath' || c.local === 'oMathParaPr')),
      );
      if (maths.length !== 1 || others.length)
        this.fail('a math paragraph that is not one equation');
      return this.root(maths[0]!);
    }
    if (e.local !== 'oMath') this.fail('not Office math');
    return this.body(e);
  }
}

/** The tree of an `m:oMath` or `m:oMathPara` element. Throws `MathConvertError` for anything not on the list. */
export function readOmml(e: XmlElement): MathNode {
  return new Reader().root(e);
}

/** The LaTeX of an `m:oMath` or `m:oMathPara` element, or a `MathConvertError`. */
export function ommlToLatex(e: XmlElement): string {
  const latex = toLatex(readOmml(e));
  if (latex.length > MATH_LIMITS.length)
    throw new MathConvertError('the equation is longer than 4,000 characters');
  return latex;
}
