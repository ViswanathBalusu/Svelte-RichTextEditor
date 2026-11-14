/**
 * The sources of the math allow-list (09 §6.3; EXP-049): commands that `amsmath` and the class's
 * math font (STIX Two Math through `unicode-math`) provide, each with a sample of its use. The
 * allow-list in `allow-list.ts` is generated from this file by `scripts/math-allow-list.ts`, which
 * keeps only what KaTeX parses in strict mode: the intersection 09 §6.3 asks for. Every sample is
 * compiled under the class's math setup by `test/math-allow-list.compile.test.ts`.
 *
 * Deliberately absent, so refused: definitions and primitives (`\def`, `\let`, `\csname`,
 * `\catcode`, `\input`, `\include`, `\openin`, `\write`, `\directlua`, `\special`, `\immediate`,
 * `\newcommand`, `\expandafter`, `\hskip`), commands that paint outside their box or hide other
 * content (`\rlap`, `\llap`, `\clap`, `\mathllap`, `\mathrlap`, `\mathclap`, `\smash`, `\raisebox`,
 * `\colorbox`, `\fcolorbox`, `\rule`, `\color`, `\textcolor`), links and pictures (`\href`, `\url`,
 * `\includegraphics`, `\html…`), and numbering (`\tag`, `\label`, `\ref`, `\eqref`, `\notag`),
 * because equation numbers come from the shared numbering algorithm (ADR 0032). Symbols that only `amssymb` defines (for example `\blacklozenge`, `\lhd` and `\leadsto`) are absent too: 09 §6.3 limits the list to what `amsmath` and the math font provide, and the class does not load `amssymb` (ADR 0320).
 */

export type Arity = 'symbol' | 'arg' | 'args2' | 'delimiter' | 'sized' | 'dimen' | 'muskip';

export interface Candidate {
  readonly name: string;
  readonly arity: Arity;
}

const symbols = (names: string): Candidate[] =>
  names
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => ({ name, arity: 'symbol' as const }));
const withArity = (arity: Arity, names: string): Candidate[] =>
  names
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => ({ name, arity }));

export const CANDIDATES: readonly Candidate[] = [
  // Greek letters
  ...symbols(
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega digamma',
  ),
  ...symbols('Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'),
  // Letter-like symbols and constructs
  ...symbols(
    'infty partial nabla forall exists nexists emptyset varnothing neg lnot prime backprime hbar hslash ell wp Re Im aleph beth gimel daleth angle measuredangle sphericalangle triangle bigstar diamondsuit heartsuit clubsuit spadesuit flat natural sharp top bot imath jmath complement surd mho Finv Game eth',
  ),
  // Binary operators
  ...symbols(
    'pm mp times div cdot ast star circ bullet cap cup sqcap sqcup vee wedge setminus smallsetminus oplus ominus otimes oslash odot bigcirc dagger ddagger amalg uplus wr diamond triangleleft triangleright bigtriangleup bigtriangledown boxplus boxminus boxtimes boxdot dotplus divideontimes ltimes rtimes leftthreetimes rightthreetimes curlywedge curlyvee barwedge doublebarwedge intercal land lor',
  ),
  // Relations
  ...symbols(
    'leq le geq ge neq ne equiv approx approxeq sim simeq cong propto ll gg lll ggg prec succ preceq succeq precsim succsim subset supset subseteq supseteq subsetneq supsetneq nsubseteq nsupseteq sqsubset sqsupset sqsubseteq sqsupseteq in ni notin owns mid nmid parallel nparallel perp vdash dashv models smile frown asymp doteq bowtie Join leqq geqq leqslant geqslant lessgtr gtrless lesssim gtrsim nless ngtr nleq ngeq lneq gneq lneqq gneqq lnsim gnsim nprec nsucc nsim ncong vartriangleleft vartriangleright trianglelefteq trianglerighteq ntrianglelefteq ntrianglerighteq therefore because between pitchfork backsim backsimeq eqsim eqcirc circeq triangleq risingdotseq fallingdotseq Vdash vDash Vvdash nvdash nvDash nVdash nVDash',
  ),
  // Arrows
  ...symbols(
    'to gets leftarrow rightarrow Leftarrow Rightarrow leftrightarrow Leftrightarrow longleftarrow longrightarrow Longleftarrow Longrightarrow longleftrightarrow Longleftrightarrow mapsto longmapsto hookleftarrow hookrightarrow uparrow downarrow updownarrow Uparrow Downarrow Updownarrow nearrow searrow swarrow nwarrow leftharpoonup leftharpoondown rightharpoonup rightharpoondown rightleftharpoons leftrightharpoons iff implies impliedby nleftarrow nrightarrow nLeftarrow nRightarrow nleftrightarrow nLeftrightarrow twoheadleftarrow twoheadrightarrow leftleftarrows rightrightarrows leftrightarrows rightleftarrows upuparrows downdownarrows upharpoonleft upharpoonright downharpoonleft downharpoonright curvearrowleft curvearrowright Lsh Rsh looparrowleft looparrowright leftarrowtail rightarrowtail multimap rightsquigarrow leftrightsquigarrow',
  ),
  // Big operators
  ...symbols(
    'sum prod coprod int iint iiint oint bigcup bigcap bigsqcup bigvee bigwedge bigoplus bigotimes bigodot biguplus',
  ),
  // Named operators
  ...symbols(
    'arccos arcsin arctan arg cos cosh cot coth csc deg det dim exp gcd hom inf ker lg lim liminf limsup ln log max min Pr sec sin sinh sup tan tanh',
  ),
  // Dots, spaces and other symbols
  ...symbols('ldots cdots vdots ddots dots dotsb dotsc dotsi dotsm dotso quad qquad colon'),
  ...symbols('thinspace medspace thickspace negthinspace enspace'),
  ...symbols(
    'lbrace rbrace langle rangle lfloor rfloor lceil rceil vert Vert lvert rvert lVert rVert backslash',
  ),
  ...symbols('displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits'),
  ...symbols('bmod'),
  // Delimiters after \left, \right, \middle
  ...withArity('delimiter', 'left right middle'),
  ...withArity(
    'sized',
    'big Big bigg Bigg bigl Bigl biggl Biggl bigr Bigr biggr Biggr bigm Bigm biggm Biggm',
  ),
  // One argument
  ...withArity(
    'arg',
    'sqrt overline underline overbrace underbrace widehat widetilde overrightarrow overleftarrow hat tilde bar vec dot ddot dddot acute grave breve check mathring mathrm mathbf mathit mathsf mathtt mathcal mathbb mathfrak mathscr boldsymbol operatorname text textrm textbf textit textsf texttt textnormal mbox boxed phantom hphantom vphantom pmod pod mod not xrightarrow xleftarrow mathop mathbin mathrel mathord mathopen mathclose mathpunct',
  ),
  // Two arguments
  ...withArity('args2', 'frac dfrac tfrac cfrac binom dbinom tbinom overset underset stackrel'),
  // Bounded spaces (09 §6.3: every dimension argument is bounded)
  ...withArity('dimen', 'hspace kern'),
  ...withArity('muskip', 'mkern mskip'),
];

/** Environments allowed inside `equation` (09 §6.3). */
export const ENVIRONMENT_CANDIDATES: readonly string[] = [
  'aligned',
  'gathered',
  'cases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
];

/** A sample use of a candidate, for KaTeX and for the compile test. */
export function sample(c: Candidate): string {
  switch (c.arity) {
    case 'symbol':
      return c.name === 'limits' || c.name === 'nolimits'
        ? `\\sum\\${c.name}_{i}^{n} x`
        : c.name === 'bmod'
          ? `a \\bmod b`
          : `x \\${c.name} y`;
    case 'arg':
      if (c.name === 'not') return `x \\not= y`;
      if (c.name.startsWith('text') || c.name === 'mbox' || c.name === 'operatorname')
        return `\\${c.name}{abc}`;
      if (c.name === 'xrightarrow' || c.name === 'xleftarrow') return `A \\${c.name}{f} B`;
      if (c.name === 'pmod' || c.name === 'pod' || c.name === 'mod') return `a \\${c.name}{n}`;
      return `\\${c.name}{x}`;
    case 'args2':
      return `\\${c.name}{a}{b}`;
    case 'delimiter':
      return c.name === 'middle' ? `\\left( a \\middle| b \\right)` : `\\left( x \\right)`;
    case 'sized':
      return c.name.endsWith('l')
        ? `\\${c.name}( x \\${c.name.slice(0, -1)}r)`
        : c.name.endsWith('r')
          ? `\\${c.name.slice(0, -1)}l( x \\${c.name})`
          : `\\${c.name}( x \\${c.name})`;
    case 'dimen':
      return c.name === 'kern' ? `a \\kern 1em b` : `a \\${c.name}{1em} b`;
    case 'muskip':
      return `a \\${c.name} 3mu b`;
  }
}

/** A sample use of an environment. */
export function environmentSample(env: string): string {
  if (env === 'cases') return `f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}`;
  if (env === 'gathered') return `\\begin{gathered} a = b \\\\ c = d \\end{gathered}`;
  if (env === 'aligned') return `\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}`;
  return `\\begin{${env}} 1 & 0 \\\\ 0 & 1 \\end{${env}}`;
}
