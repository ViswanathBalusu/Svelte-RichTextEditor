/**
 * Presentation of collaborators' carets, selections and name flags (UX-027 criterion 4; 13 §5;
 * 02 §3 forced colours). These are source checks of the stylesheet `shell.css` and of the markup
 * of `Carets.svelte`: they show that the rules say what the criterion says. They are not a rendered
 * forced-colours run; that run is not made here, and is not claimed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';

const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/shell.css', import.meta.url)),
  'utf8',
);
const SVELTE = readFileSync(
  fileURLToPath(new URL('../src/components/Carets.svelte', import.meta.url)),
  'utf8',
);

/** The stylesheet without its comments, so that a comment is never read as part of a selector. */
const BASE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const MEDIA = '@media (forced-colors: active) {';

/** The text of the forced-colours block: from its opening brace to the matching closing brace. */
function forcedBlock(css: string): string {
  const start = css.indexOf(MEDIA);
  if (start < 0) throw new Error('shell.css has no @media (forced-colors: active) block');
  let depth = 0;
  for (let i = start + MEDIA.length - 1; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return css.slice(start + MEDIA.length, i);
    }
  }
  throw new Error('the forced-colours block is not closed');
}

/** The rules of a block as selector and declarations, in source order. */
function rules(block: string): Array<{ selector: string; body: string }> {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    body: m[2]!,
  }));
}

/** The declarations of a rule body as [property, value] pairs. */
function declarations(body: string): Array<[string, string]> {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.includes(':'))
    .map((d) => {
      const at = d.indexOf(':');
      return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim()] as [string, string];
    });
}

/** CSS system colour keywords (CSS Color 4, section 6.2), in lower case. */
const SYSTEM_COLOURS = new Set([
  'canvas',
  'canvastext',
  'highlight',
  'highlighttext',
  'linktext',
  'buttontext',
  'buttonface',
  'graytext',
]);

const block = forcedBlock(CSS);
const all = rules(block);

describe('collaborator carets in forced colours (UX-027 criterion 4)', () => {
  it('has a forced-colours rule for the caret and the flag, and one for the selection', () => {
    const caretFlag = all.find(
      (r) => r.selector.includes('.de-peer-caret') && r.selector.includes('.de-peer-flag'),
    );
    const selection = all.find((r) => r.selector === '.de-peer-selection');
    expect(caretFlag, 'caret and flag rule in the forced-colours block').toBeDefined();
    expect(selection, 'selection rule in the forced-colours block').toBeDefined();
  });

  it('paints the caret, the flag and the selection in system colours only, with no hard-coded colour', () => {
    const caretFlag = all.find(
      (r) => r.selector.includes('.de-peer-caret') && r.selector.includes('.de-peer-flag'),
    )!;
    const selection = all.find((r) => r.selector === '.de-peer-selection')!;
    for (const { selector, body } of [caretFlag, selection]) {
      expect(body, `${selector} hard-codes no colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(body, `${selector} hard-codes no colour`).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/i);
      const colourDecls = declarations(body).filter(([p]) =>
        ['background', 'background-color', 'color'].includes(p),
      );
      expect(colourDecls.length, `${selector} sets a colour`).toBeGreaterThan(0);
      for (const [property, value] of colourDecls) {
        const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
        expect(
          words.some((w) => SYSTEM_COLOURS.has(w)),
          `${selector} sets ${property}: ${value}`,
        ).toBe(true);
      }
    }
  });

  it('keeps the system colours from being overridden by the page under forced colours', () => {
    const caretFlag = all.find(
      (r) => r.selector.includes('.de-peer-caret') && r.selector.includes('.de-peer-flag'),
    )!;
    const selection = all.find((r) => r.selector === '.de-peer-selection')!;
    expect(declarations(caretFlag.body)).toContainEqual(['forced-color-adjust', 'none']);
    expect(declarations(selection.body)).toContainEqual(['forced-color-adjust', 'none']);
  });
});

/*
 * The cascade under forced colours, worked out for each element the caret layer draws. A rule in
 * the forced-colours block only helps if it wins: a base rule of higher specificity (such as the
 * idle caret's `.de-peer-caret[data-status='idle']`) would otherwise keep its own colours. This
 * models the cascade for the selectors shell.css uses (classes, attributes, types, pseudo-classes;
 * importance, specificity, source order). A selector it cannot model, and that could reach these
 * elements, fails the test so that the model is extended rather than silently wrong.
 */

type Painted = 'background-color' | 'background-image' | 'color' | 'forced-color-adjust';

interface Drawn {
  readonly name: string;
  readonly tag: string;
  readonly classes: readonly string[];
  readonly attrs: Readonly<Record<string, string>>;
  /** Properties that must be set by a winning forced-colours rule. */
  readonly needs: readonly Painted[];
}

/** The elements of Carets.svelte, for every colour slot (1 to 8) and both statuses. */
function drawnElements(): Drawn[] {
  const out: Drawn[] = [];
  for (let slot = 1; slot <= 8; slot++) {
    const person = `de-person-${slot}`;
    for (const status of ['active', 'idle']) {
      out.push({
        name: `caret (${status}, slot ${slot})`,
        tag: 'div',
        classes: ['de-peer-caret', person],
        attrs: { class: '', 'data-session': 's', 'data-status': status, style: '' },
        needs: ['background-color', 'color', 'forced-color-adjust'],
      });
    }
    out.push({
      name: `flag (slot ${slot})`,
      tag: 'span',
      classes: ['de-peer-flag', person],
      attrs: { class: '', 'data-content': '', dir: 'auto' },
      needs: ['background-color', 'color', 'forced-color-adjust'],
    });
    out.push({
      name: `selection (slot ${slot})`,
      tag: 'div',
      classes: ['de-peer-selection', person],
      attrs: { class: '', 'data-session': 's', style: '' },
      needs: ['background-color', 'forced-color-adjust'],
    });
  }
  return out;
}

/** Splits at a separator that is outside brackets, parentheses and quotes. */
function splitTop(text: string, isSeparator: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && isSeparator(ch)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Specificity of a complex selector as [ids, classes, types]; whether its subject matches `el`. */
function matchSelector(
  selector: string,
  el: Drawn,
): { matches: boolean; specificity: [number, number, number] } {
  const compounds = splitTop(selector, (ch) => /[\s>+~]/.test(ch));
  const specificity: [number, number, number] = [0, 0, 0];
  let subjectMatches = true;
  const unmodelled: string[] = [];
  compounds.forEach((compound, index) => {
    const isSubject = index === compounds.length - 1;
    const tokens =
      compound.match(/^(\*|[a-zA-Z][\w-]*)|\.[\w-]+|#[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g) ??
      [];
    if (tokens.join('') !== compound) throw new Error(`cannot model the selector "${selector}"`);
    for (const token of tokens) {
      if (token === '*') continue;
      if (/^[a-zA-Z]/.test(token)) {
        specificity[2]++;
        if (isSubject && token.toLowerCase() !== el.tag) subjectMatches = false;
      } else if (token.startsWith('.')) {
        specificity[1]++;
        if (isSubject && !el.classes.includes(token.slice(1))) subjectMatches = false;
      } else if (token.startsWith('#')) {
        specificity[0]++;
        if (isSubject) subjectMatches = false;
      } else if (token.startsWith('[')) {
        specificity[1]++;
        if (!isSubject) continue;
        const attr = /^\[\s*([\w-]+)\s*(?:=\s*(?:'([^']*)'|"([^"]*)"|([\w-]+))\s*)?\]$/.exec(token);
        if (!attr) {
          unmodelled.push(token);
          continue;
        }
        const name = attr[1]!;
        const wanted = attr[2] ?? attr[3] ?? attr[4];
        const actual = el.attrs[name];
        if (actual === undefined || (wanted !== undefined && actual !== wanted))
          subjectMatches = false;
      } else if (/^::|^:(before|after|first-line|first-letter)$/.test(token)) {
        specificity[2]++;
        // A pseudo-element is another box, not the element itself.
        if (isSubject) subjectMatches = false;
      } else {
        const logical = /^:(is|where|not)\(([\s\S]*)\)$/.exec(token);
        if (logical && !logical[2]!.includes('(')) {
          // :is() and :not() take their most specific argument; :where() counts nothing.
          const args = splitTop(logical[2]!, (ch) => ch === ',').map((arg) =>
            matchSelector(arg, el),
          );
          const best = args.reduce<[number, number, number]>(
            (top, a) =>
              outranks({ ...NONE, specificity: a.specificity }, { ...NONE, specificity: top })
                ? a.specificity
                : top,
            [0, 0, 0],
          );
          if (logical[1] !== 'where')
            best.forEach((n, i) => (specificity[i] = specificity[i]! + n));
          if (!isSubject) continue;
          const any = args.some((a) => a.matches);
          if (logical[1] === 'not' ? any : !any) subjectMatches = false;
          continue;
        }
        specificity[1]++;
        if (!isSubject) continue;
        if (/^:(root|host)\b/.test(token)) subjectMatches = false;
        else if (token.includes('(')) unmodelled.push(token);
        // Any other pseudo-class (hover, focus-visible) is assumed to hold: the stricter reading.
      }
    }
  });
  if (subjectMatches && unmodelled.length > 0) {
    throw new Error(
      `cannot model ${unmodelled.join(' ')} in "${selector}", which could reach ${el.name}`,
    );
  }
  return { matches: subjectMatches, specificity };
}

interface Candidate {
  readonly value: string;
  readonly important: boolean;
  readonly specificity: [number, number, number];
  readonly order: number;
  readonly forced: boolean;
  readonly selector: string;
}

const NONE: Candidate = {
  value: '',
  important: false,
  specificity: [0, 0, 0],
  order: 0,
  forced: false,
  selector: '',
};

function outranks(a: Candidate, b: Candidate): boolean {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i++)
    if (a.specificity[i] !== b.specificity[i]) return a.specificity[i]! > b.specificity[i]!;
  return a.order > b.order;
}

/** The words a colour value may use under forced colours: system colours and gradient syntax. */
const ALLOWED_WORDS = new Set([
  ...SYSTEM_COLOURS,
  'transparent',
  'currentcolor',
  'none',
  'linear-gradient',
  'repeating-linear-gradient',
  'to',
  'top',
  'bottom',
  'px',
  'em',
]);

/** What is wrong with the painting of `el` with forced colours active; empty when nothing is. */
function forcedPaintProblems(css: string, el: Drawn): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = text.indexOf(MEDIA);
  if (start < 0) return ['no forced-colours block'];
  const end = start + MEDIA.length + forcedBlock(text).length;
  const won = new Map<Painted, Candidate>();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const order = m.index;
    const forced = order > start && order < end;
    for (const selector of splitTop(m[1]!.trim(), (ch) => ch === ',')) {
      const { matches, specificity } = matchSelector(selector, el);
      if (!matches) continue;
      for (const [property, raw] of declarations(m[2]!)) {
        const important = /!\s*important\s*$/i.test(raw);
        const value = raw.replace(/!\s*important\s*$/i, '').trim();
        const targets: Painted[] =
          property === 'background'
            ? ['background-color', 'background-image']
            : property === 'background-color' ||
                property === 'background-image' ||
                property === 'color' ||
                property === 'forced-color-adjust'
              ? [property]
              : [];
        for (const target of targets) {
          const candidate: Candidate = { value, important, specificity, order, forced, selector };
          const current = won.get(target);
          if (!current || outranks(candidate, current)) won.set(target, candidate);
        }
      }
    }
  }
  const problems: string[] = [];
  for (const property of el.needs) {
    if (!won.has(property)) problems.push(`${el.name}: no rule sets ${property}`);
  }
  for (const [property, winner] of won) {
    const at = `${el.name}: ${property} comes from "${winner.selector}" (${winner.value})`;
    if (!winner.forced) {
      problems.push(`${at}, a rule outside the forced-colours block`);
      continue;
    }
    if (property === 'forced-color-adjust') {
      if (winner.value !== 'none') problems.push(`${at}, not none`);
      continue;
    }
    const value = winner.value.toLowerCase();
    if (/var\(|#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(value)) {
      problems.push(`${at}, which is not a system colour`);
      continue;
    }
    const words = value.match(/[a-z][a-z-]*/g) ?? [];
    const unknown = words.filter((w) => !ALLOWED_WORDS.has(w));
    if (unknown.length > 0) problems.push(`${at}, which uses ${unknown.join(', ')}`);
    else if (!words.some((w) => SYSTEM_COLOURS.has(w)))
      problems.push(`${at}, which names no system colour`);
  }
  return problems;
}

describe('collaborator carets: the forced-colours rules win the cascade (UX-027 criterion 4)', () => {
  it('draws the elements this model assumes, with no inline colour', () => {
    expect(SVELTE).toContain('class="de-peer-caret de-person-{peer.slot}"');
    expect(SVELTE).toContain('data-status={peer.status}');
    expect(SVELTE).toContain('class="de-peer-flag de-person-{peer.slot}" data-content dir="auto"');
    expect(SVELTE).toContain('class="de-peer-selection de-person-{peer.slot}"');
    expect(SVELTE).not.toMatch(/style:(background|color|border)/i);
    expect(SVELTE).not.toMatch(/\sstyle="/i);
  });

  it('paints every caret (active and idle), flag and selection in system colours only', () => {
    const problems = drawnElements().flatMap((el) => forcedPaintProblems(CSS, el));
    expect(problems).toEqual([]);
  });

  it('keeps the idle caret dashed in a system colour, from the forced-colours block', () => {
    const idle = all.find((r) => r.selector === ".de-peer-caret[data-status='idle']");
    expect(idle, 'an idle caret rule in the forced-colours block').toBeDefined();
    const background = declarations(idle!.body).find(([p]) => p === 'background');
    expect(background?.[1]).toMatch(/^repeating-linear-gradient\(/);
    expect(background?.[1]).toMatch(/CanvasText/);
  });

  it('catches the base idle rule winning when the forced-colours idle rule is missing', () => {
    // The defect a review found: without its own forced rule, the idle caret keeps the page's colour.
    const forcedIdle = /\n\s*\.de-peer-caret\[data-status='idle'\]\s*\{[^{}]*\}/g;
    const matches = [...BASE.matchAll(forcedIdle)];
    expect(matches.length, 'one base and one forced idle rule').toBe(2);
    const last = matches[1]!;
    const without = BASE.slice(0, last.index) + BASE.slice(last.index + last[0].length);
    const idle = drawnElements().find((el) => el.name === 'caret (idle, slot 1)')!;
    const problems = forcedPaintProblems(without, idle);
    expect(
      problems.some((p) =>
        p.includes('background-color comes from ".de-peer-caret[data-status=\'idle\']"'),
      ),
    ).toBe(true);
    expect(problems.some((p) => p.includes('outside the forced-colours block'))).toBe(true);
  });
});

describe('collaborator carets: no pointer events and no focus (UX-027 criterion 5, static guard)', () => {
  it('gives the caret layer pointer-events none, which the caret, flag and selection inherit', () => {
    const layer = [...BASE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
      (m) => m[1]!.trim() === '.de-carets',
    );
    expect(layer, 'the caret layer has a rule').toBeDefined();
    expect(declarations(layer![2]!)).toContainEqual(['pointer-events', 'none']);
  });

  it('never sets pointer-events on a caret, flag or selection to anything but none', () => {
    const peerRules = [...BASE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
      /\.de-peer-/.test(m[1]!),
    );
    expect(peerRules.length).toBeGreaterThan(0);
    for (const m of peerRules) {
      for (const [property, value] of declarations(m[2]!)) {
        if (property === 'pointer-events') expect(value, m[1]!.trim()).toBe('none');
      }
    }
  });

  it('gives the layer no focusable element and hides it from assistive technology', () => {
    expect(SVELTE).toMatch(/class="de-carets"[^>]*aria-hidden="true"/);
    expect(SVELTE).not.toMatch(/tabindex/i);
    expect(SVELTE).not.toMatch(/<(button|a|input|select|textarea)\b/i);
    expect(SVELTE).not.toMatch(/contenteditable/i);
  });
});

describe('the name flag names the person in text (UX-027 criterion 4)', () => {
  it("builds the flag text from the person's name, not from colour", () => {
    expect(SVELTE).toContain("tr.t('presence.person.idle', { name: peer.label })");
    expect(SVELTE).toContain("tr.t('presence.person.active', { name: peer.label })");
    expect(SVELTE).toMatch(/data-content[^>]*>/);
    expect(EN_GB['presence.person.active']).toBe('{name}');
    expect(EN_GB['presence.person.idle']).toContain('{name}');
    expect(EN_GB['people.fallback']).toBeTruthy();
  });
});
