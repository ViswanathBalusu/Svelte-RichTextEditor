%% docedit.cls: house class for PDFs exported by the document editor (09 §3.1).
%% Working name; every macro of the class starts with \DE. Version 0.2.1, 2026-11-13.
%%
%% Only bundles written by @docedit/export-latex are compiled with this class (09 §9.3 item 1).
%% main.tex holds no user-authored TeX outside math that passed the math gate. User strings arrive
%% escaped by the text emitter, or hex-encoded by the pdfString, kvValue and url emitters and
%% decoded by docedit.lua into inert characters (09 §4).
%%
%% Tagging first (09 §3.1): the class never loads titlesec, multirow, enumitem, tabto, caption or
%% float. Headings are the kernel's sectioning commands, lists the kernel's list environment with
%% literal labels, tables longtable, tab stops and line heights are set in Lua (docedit.lua), and
%% row spans are the class's own cell macro. Tagging itself is switched by \DocumentMetadata.
%%
%% Licence: Apache-2.0, the project's licence (SPK-007).
\NeedsTeXFormat{LaTeX2e}[2025-06-01]
\ProvidesClass{docedit}[2026-11-14 v0.2.3 DocEdit house class]
\def\DEclassversion{0.2.2}
\ifdefined\directlua\else
  \ClassError{docedit}{This class needs LuaLaTeX}{}%
\fi

% ---------------------------------------------------------------------------------------------
% Options, written by the converter from fixed tables.
\def\DE@opt@renderer{node}
\def\DE@opt@layout{line}
\def\DE@opt@glyphs{strict}
\DeclareKeys[docedit]
  {
    renderer.store = \DE@opt@renderer ,
    layout.store   = \DE@opt@layout ,
    glyphs.store   = \DE@opt@glyphs ,
  }
\ProcessKeyOptions[docedit]
\def\DE@tmp{harf}%
\ifx\DE@opt@renderer\DE@tmp \def\DE@renderer{HarfBuzz}\else \def\DE@renderer{Node}\fi
\chardef\DE@layoutlevel=2
\def\DE@tmp{off}\ifx\DE@opt@layout\DE@tmp \chardef\DE@layoutlevel=0 \fi
\def\DE@tmp{block}\ifx\DE@opt@layout\DE@tmp \chardef\DE@layoutlevel=1 \fi

\LoadClass[10pt]{article}

% ---------------------------------------------------------------------------------------------
% The fixed package list (09 §9.3 item 5). Each one is known to work with tagging. babel is loaded
% only when the document needs languages (\DEbabel), with shorthands off.
\RequirePackage{fontspec}
\RequirePackage{amsmath}
\RequirePackage{unicode-math}
\RequirePackage{xcolor}
\RequirePackage{luacolor} % lua-ul's \highLight needs it (not named in 09 §3.1)
\RequirePackage{geometry}
\RequirePackage{lua-ul}
\RequirePackage{array}
\RequirePackage{longtable}
\RequirePackage{colortbl}
\RequirePackage{multicol}
\RequirePackage{graphicx}
\RequirePackage{hyperref}
\hypersetup{hidelinks, pdfdisplaydoctitle=true, bookmarksnumbered=false}

% ---------------------------------------------------------------------------------------------
% Engine settings
% A character that neither the font nor the fallback chain has is an error in a final export, and
% a log line in a preview (09 §3.2; EXP-026). The converter checks coverage first when it can.
\def\DE@tmp{report}%
\ifx\DE@opt@glyphs\DE@tmp \tracinglostchars=2 \else \tracinglostchars=3 \fi
\setcounter{secnumdepth}{-10} % heading numbers are literal labels from the converter
\setlength\parskip{0pt}
\setlength\parindent{0pt}
\frenchspacing
\hyphenpenalty=10000 % settings.hyphenation false (the default); \DEhyphenation turns it on
\exhyphenpenalty=50  % lines may still break after a typed hyphen, as in Word
\newcommand*\DEhyphenation{\hyphenpenalty=50 }
\emergencystretch=3em
\pagestyle{empty}
\@secpenalty=0 % Word does not prefer a page break before a heading
% Line boxes are stacked edge to edge (docedit.lua): no glue from \topskip, \splittopskip or
% \lineskip, and the last line's depth counts in the page.
\setlength\topskip{0pt}
\setlength\splittopskip{0pt}
\setlength\maxdepth{0pt}
\setlength\lineskip{0pt}
\setlength\lineskiplimit{0pt}

% ---------------------------------------------------------------------------------------------
% Lua side
\newattribute\DE@attr@block
\newattribute\DE@attr@run
\newattribute\DE@attr@pos
\newattribute\DE@attr@area
\newattribute\DE@attr@atom
\newattribute\DE@attr@lsr  % line rule: 0 multiple, 1 exact, 2 at least
\newattribute\DE@attr@lsv  % its value: thousandths, or twips
\newattribute\DE@attr@plh  % natural height of the paragraph mark, twips
\newattribute\DE@attr@pld  % its descent part, twips
\newattribute\DE@attr@rlh  % natural height of a run, twips
\newattribute\DE@attr@rld  % its descent part, twips
\newattribute\DE@attr@tabs % the paragraph's tab list (\DEdeftabs)
\newattribute\DE@attr@indl % left indent, scaled points
\newattribute\DE@attr@indf % first-line indent, scaled points
\newattribute\DE@attr@tab  % a tab
\newattribute\DE@attr@field % a flattened form field: its number in map.json (EXP-058)
\newdimen\DE@labelT
\directlua{
  docedit = require("docedit")
  docedit.init({
    block = luatexbase.registernumber("DE@attr@block"),
    run = luatexbase.registernumber("DE@attr@run"),
    pos = luatexbase.registernumber("DE@attr@pos"),
    area = luatexbase.registernumber("DE@attr@area"),
    atom = luatexbase.registernumber("DE@attr@atom"),
    lsr = luatexbase.registernumber("DE@attr@lsr"),
    lsv = luatexbase.registernumber("DE@attr@lsv"),
    plh = luatexbase.registernumber("DE@attr@plh"),
    pld = luatexbase.registernumber("DE@attr@pld"),
    rlh = luatexbase.registernumber("DE@attr@rlh"),
    rld = luatexbase.registernumber("DE@attr@rld"),
    tabs = luatexbase.registernumber("DE@attr@tabs"),
    indl = luatexbase.registernumber("DE@attr@indl"),
    indf = luatexbase.registernumber("DE@attr@indf"),
    tab = luatexbase.registernumber("DE@attr@tab"),
    field = luatexbase.registernumber("DE@attr@field"),
  }, \the\DE@layoutlevel)
}
\def\DE@unset{-"7FFFFFFF }
\protected\def\DE@noattrs{%
  \DE@attr@block=\DE@unset \DE@attr@run=\DE@unset \DE@attr@area=\DE@unset \DE@attr@atom=\DE@unset
  \DE@attr@lsr=\DE@unset \DE@attr@rlh=\DE@unset \DE@attr@rld=\DE@unset}
% Material made by the output routine (headers, footers, the page box) never carries block marks.
\AddToHook{build/page/reset}{\DE@noattrs}
\AddToHook{build/column/before}{\DE@noattrs}
\ifnum\DE@layoutlevel>0
  \AddToHook{shipout/before}{\directlua{docedit.page(\the\ShipoutBox)}}
\else
  \AddToHook{shipout/before}{\directlua{docedit.page(-1)}}
\fi
\AddToHook{enddocument/afterlastpage}{\directlua{docedit.finish()}}

% Hex-encoded strings: inert characters when typeset, written to auxiliary files as hex.
\protected\def\DEstr#1{\directlua{docedit.str("#1")}}
\def\DE@strexp#1{\directlua{docedit.str("#1")}}
\pdfstringdefDisableCommands{\let\DEstr\DE@strexp}
\ExplSyntaxOn
\text_declare_purify_equivalent:Nn \DEstr { \DE@strexp }
\ExplSyntaxOff

% Links: the url emitter has applied the scheme allow-list; docedit.href passes catcode-12 text.
% #2 is a link title as a PDF hex string, or empty: it becomes the annotation's /Contents.
\ExplSyntaxOn
\tl_new:N \l__docedit_contents_tl
\cs_new_protected:Npn \DE@linkcontents #1 { \tl_set:Nn \l__docedit_contents_tl {#1} }
\cs_new_protected:Npn \__docedit_link_plug:
  {
    \cs_if_exist:NT \socket_new_plug:nnn
      {
        \cs_if_exist:NT \l__hyp_link_Contents_tl
          {
            \socket_new_plug:nnn { hyp/link/URI/Contents } { docedit }
              {
                \tl_if_empty:NTF \l__docedit_contents_tl
                  {
                    \__hyp_text_pdfstring:eoN { ##1 } { \l__hyp_text_enc_info_print_tl }
                      \l__hyp_link_Contents_tl
                    \pdfannot_dict_put:nne { link/URI } { Contents } { \l__hyp_link_Contents_tl }
                  }
                  { \pdfannot_dict_put:nne { link/URI } { Contents } { \l__docedit_contents_tl } }
              }
            \socket_assign_plug:nn { hyp/link/URI/Contents } { docedit }
          }
      }
  }
\AtBeginDocument { \__docedit_link_plug: }
\ExplSyntaxOff
\protected\def\DEhref#1#2{\DE@linkcontents{#2}\directlua{docedit.href("#1")}}
% In-document links and anchors use generated identifiers only.
\protected\def\DElink#1#2#3{\hyperlink{DEa#1}{#3}}
\protected\def\DEanchor#1{\phantomsection\label{DEa#1}\hypertarget{DEa#1}{}}
\newcommand*\DEpref[1]{\pageref{DEa#1}}

% ---------------------------------------------------------------------------------------------
% Fonts by file path and hash (09 §5). The directory comes from the worker's environment.
\edef\DE@fontpath{\directlua{docedit.fontpath()}}
% The fallback chain (09 §3.2, EXP-026, EXP-047): \DEfallback{file} once per face, in order, before
% the families. Every family then falls back to the chain for characters it lacks, with TeX
% ligatures off like the families themselves (09 §3.2, Text ligature conventions).
\def\DE@fallbackopt{}
\newcommand*\DEfallback[1]{%
  \directlua{docedit.fallback("#1", "\DE@renderer")}%
  \def\DE@fallbackopt{, RawFeature={fallback=docedit}}}
% \DEdeffamily{n}{line height x1000}{regular}{bold}{italic}{bold italic}
\newcommand*\DEdeffamily[6]{%
  \edef\DE@tmp{%
    \noexpand\newfontfamily\expandafter\noexpand\csname DE@fam@#1\endcsname{#3}[%
      Path=\DE@fontpath, BoldFont=#4, ItalicFont=#5, BoldItalicFont=#6,
      Ligatures=TeXOff, Renderer=\DE@renderer\DE@fallbackopt]}%
  \DE@tmp
  \expandafter\chardef\csname DE@lh@#1\endcsname=#2\relax}
% \DEmainfamily{regular}{bold}{italic}{bold italic}: the font of class text (footnote marks)
\newcommand*\DEmainfamily[4]{%
  \edef\DE@tmp{%
    \noexpand\setmainfont{#1}[%
      Path=\DE@fontpath, BoldFont=#2, ItalicFont=#3, BoldItalicFont=#4,
      Ligatures=TeXOff, Renderer=\DE@renderer\DE@fallbackopt]}%
  \DE@tmp}
\newcommand*\DEmathfont[1]{%
  \edef\DE@tmp{\noexpand\setmathfont{#1}[Path=\DE@fontpath]}\DE@tmp}
\def\DE@deffam{1}
\newcommand*\DEdefaultfamily[1]{\def\DE@deffam{#1}}
% Tab stops (EXP-032): \DEdefaulttab{twips}; \DEdeftabs{k}{position:align:leader;...}
\newcommand*\DEdefaulttab[1]{\directlua{docedit.defaulttab(#1)}}
\newcommand*\DEdeftabs[2]{\directlua{docedit.deftabs(#1, "#2")}}

% ---------------------------------------------------------------------------------------------
% Languages (09 §3.1; EXP-027): babel through its ini files only, shorthands off.
\newcommand*\DEbabel[2]{%
  \RequirePackage[shorthands=off]{babel}%
  \babelprovide[import=#2, main]{#1}}
% \DEdeflang{k}{babel name}{ini}{BCP 47 tag}
\newcommand*\DEdeflang[4]{%
  \babelprovide[import=#3]{#2}%
  \@namedef{DE@lang@#1}{#2}\@namedef{DE@langtag@#1}{#4}}
% \DElang{k}{content}: a passage in another language, tagged as a span with its language.
\ExplSyntaxOn
\cs_new_protected:Npn \DE@tagspan #1 #2
  {
    \bool_lazy_and:nnTF { \cs_if_exist_p:N \tag_if_active_p: } { \tag_if_active_p: }
      {
        \tag_mc_end_push:
        \tag_struct_begin:n { tag=Span, #1 }
        \tag_mc_begin:n { }
        #2
        \tag_mc_end:
        \tag_struct_end:
        \tag_mc_begin_pop:n { }
      }
      { #2 }
  }
\cs_new_protected:Npn \DElang #1 #2
  {
    \cs_if_exist:cTF { DE@lang@#1 }
      {
        \exp_args:Ne \DE@tagspan { lang = \use:c { DE@langtag@#1 } }
          { \foreignlanguage { \use:c { DE@lang@#1 } } {#2} }
      }
      {#2}
  }
\cs_new_protected:Npn \DElangx #1 #2
  { \cs_if_exist:cTF { DE@lang@#1 } { \foreignlanguage { \use:c { DE@lang@#1 } } {#2} } {#2} }
\ExplSyntaxOff

% ---------------------------------------------------------------------------------------------
% Paragraph properties. Styles (styles.tex) and direct formatting only set these registers;
% \DE@apply turns them into TeX parameters and Lua attributes when the paragraph starts. The
% converter writes the model's resolved values (03 §6; ADR 0032), so the order of the setters is
% the cascade's.
\newcount\DE@fam    \newdimen\DE@size   \newcount\DE@bf  \newcount\DE@it  \newcount\DE@sc
\newcount\DE@lsrule \newcount\DE@lsval
\newcount\DE@align  \newdimen\DE@indL   \newdimen\DE@indR   \newdimen\DE@indF
\newcount\DE@widows \newcount\DE@keeplines
\newcount\DE@plh    \newcount\DE@pld    \newcount\DE@tabs
\def\DE@color{}
\newcommand*\DE@defaults{%
  \DE@fam=\DE@deffam\relax \DE@size=11bp \DE@bf=0 \DE@it=0 \DE@sc=0 \def\DE@color{}%
  \DE@lsrule=0 \DE@lsval=1000 \DE@align=1 \DE@plh=300 \DE@pld=47 \DE@tabs=0
  \DE@indL=0pt \DE@indR=0pt \DE@indF=0pt \DE@widows=1 \DE@keeplines=0 }
\newcommand*\DEfam[1]{\DE@fam=#1\relax}
\newcommand*\DEsz[1]{\DE@size=#1\relax}
\newcommand*\DElh[2]{\DE@plh=#1\relax \DE@pld=#2\relax}
\newcommand*\DEbf[1]{\DE@bf=#1\relax}
\newcommand*\DEit[1]{\DE@it=#1\relax}
\newcommand*\DEsc[1]{\DE@sc=#1\relax}
\newcommand*\DEcol[1]{\def\DE@color{#1}}
\newcommand*\DEnocol{\def\DE@color{}}
% Line spacing: multiple in thousandths; exact and at least in twips (03 §2)
\newcommand*\DElsm[1]{\DE@lsrule=0 \DE@lsval=#1\relax}
\newcommand*\DElse[1]{\DE@lsrule=1 \DE@lsval=#1\relax}
\newcommand*\DElsa[1]{\DE@lsrule=2 \DE@lsval=#1\relax}
% Alignment: 0 justify, 1 start, 2 centre, 3 end
\newcommand*\DEal[1]{\DE@align=#1\relax}
\newcommand*\DEil[1]{\DE@indL=#1\relax}
\newcommand*\DEir[1]{\DE@indR=#1\relax}
\newcommand*\DEif[1]{\DE@indF=#1\relax}
\newcommand*\DEwc[1]{\DE@widows=#1\relax}
\newcommand*\DEkl[1]{\DE@keeplines=#1\relax}
\newcommand*\DEtabs[1]{\DE@tabs=#1\relax}
% Paragraph shading is not drawn yet (EXP-020); the converter reports it.
\newcommand*\DEshade[1]{}
\newcommand*\DEnoshade{}

\newcommand*\DE@selectfont{%
  \csname DE@fam@\the\DE@fam\endcsname
  \fontsize{\DE@size}{\baselineskip}%
  \fontseries{\ifnum\DE@bf=1 b\else m\fi}%
  \fontshape{\ifnum\DE@sc=1 \ifnum\DE@it=1 scit\else sc\fi\else\ifnum\DE@it=1 it\else n\fi\fi}%
  \selectfont
  \ifx\DE@color\@empty\else\color[HTML]{\DE@color}\fi}
\newcommand*\DE@apply{%
  \DE@selectfont
  % \baselineskip is the natural single line height: struts of tables and arrays use it. The
  % lines themselves get their height in docedit.lua.
  \baselineskip=\numexpr\DE@plh*3289\relax sp\relax
  \ifcase\DE@align
    \leftskip=\DE@indL \rightskip=\DE@indR \parfillskip=0pt plus 1fil
  \or
    \leftskip=\DE@indL \rightskip=\DE@indR plus 1fil \parfillskip=0pt plus 1fil
  \or
    \leftskip=\DE@indL plus 1fil \rightskip=\DE@indR plus 1fil \parfillskip=0pt
  \else
    \leftskip=\DE@indL plus 1fil \rightskip=\DE@indR \parfillskip=0pt
  \fi
  \parindent=\DE@indF
  \ifnum\DE@widows=1 \clubpenalty=10000 \widowpenalty=10000
  \else \clubpenalty=0 \widowpenalty=0 \fi
  \ifnum\DE@keeplines=1 \interlinepenalty=10000 \else \interlinepenalty=0 \fi
  \DE@attr@lsr=\DE@lsrule \DE@attr@lsv=\DE@lsval \DE@attr@plh=\DE@plh \DE@attr@pld=\DE@pld
  \DE@attr@rlh=\DE@plh \DE@attr@rld=\DE@pld \DE@attr@tabs=\DE@tabs
  \DE@attr@indl=\DE@indL \DE@attr@indf=\DE@indF\relax}

% A text run: \DEr{offset}{escaped text}. The offset is the UTF-16 position in the block (09 §7.1).
\protected\def\DEr#1#2{{\DE@attr@run=#1\relax #2}}
% An inline atom (footnote mark, equation, break, tab, field) counts as one position.
\protected\def\DEa#1#2{{\DE@attr@run=#1\relax \DE@attr@atom=1\relax #2}}

% Run formatting. \DEfont{family}{size}{series}{shape}{natural height}{descent} (twips)
\newcommand*\DEfont[6]{\csname DE@fam@#1\endcsname\fontsize{#2}{\baselineskip}%
  \fontseries{#3}\fontshape{#4}\selectfont \DE@attr@rlh=#5\relax \DE@attr@rld=#6\relax}
\newcommand\DEc[2]{{\color[HTML]{#1}#2}}
\newcommand\DEital[1]{{\fontshape{it}\selectfont #1}}
\newcommand\DEuc[1]{\MakeUppercase{#1}}
\newcommand\DEul[1]{\underLine{#1}}
\newunderlinetype\DE@uldouble{\leaders\vbox{\hrule height -1.1pt depth 1.5pt\kern .6pt\hrule height -2.1pt depth 2.5pt}}
\newunderlinetype\DE@uldotted{\cleaders\hbox to 1.6pt{\hss\vrule height -1.1pt depth 1.6pt width .5pt\hss}}
\newcommand\DEuld[1]{{\DE@uldouble #1}}
\newcommand\DEulo[1]{{\DE@uldotted #1}}
\newcommand\DEst[1]{\strikeThrough{#1}}
\newcommand\DEhl[2]{\highLight[#1]{#2}}
% The highlight colours of 03 §5, under fixed names (selected by enumLookup).
\definecolor{DEhlyellow}{HTML}{FFFF00}    \definecolor{DEhlgreen}{HTML}{00FF00}
\definecolor{DEhlcyan}{HTML}{00FFFF}      \definecolor{DEhlmagenta}{HTML}{FF00FF}
\definecolor{DEhlblue}{HTML}{0000FF}      \definecolor{DEhlred}{HTML}{FF0000}
\definecolor{DEhldarkBlue}{HTML}{000080}  \definecolor{DEhldarkCyan}{HTML}{008080}
\definecolor{DEhldarkGreen}{HTML}{008000} \definecolor{DEhldarkMagenta}{HTML}{800080}
\definecolor{DEhldarkRed}{HTML}{800000}   \definecolor{DEhldarkYellow}{HTML}{808000}
\definecolor{DEhldarkGray}{HTML}{808080}  \definecolor{DEhllightGray}{HTML}{C0C0C0}
\definecolor{DEhlblack}{HTML}{000000}     \definecolor{DEhlwhite}{HTML}{FFFFFF}
\newcommand\DEsup[1]{\textsuperscript{#1}}
\newcommand\DEsub[1]{\textsubscript{#1}}
% A visible placeholder inside a line (atoms the converter cannot set).
\newcommand\DEph[1]{\fbox{#1}}

% ---------------------------------------------------------------------------------------------
% Blocks. #1 is always the block number from the converter (map.json maps it to the block id).
% Every paragraph starts with \prevdepth at -1000pt: its first line box follows the previous
% material directly, and the gap between them is the converter's \DEgap (03 §7).
\newcommand\DE@par[3]{%
  \par\begingroup
    #1\DE@defaults #2\DE@apply
    \prevdepth=-1000pt
    \indent #3\par
  \endgroup}
% \DEp{n}{properties}{content}: a body paragraph; \DEcp in a table cell; \DEsp in a story.
\newcommand\DEp[3]{\DE@par{\DE@attr@block=#1\relax\DE@attr@area=1\relax}{#2}{#3}}
\newcommand\DEcp[3]{\DE@par{\DE@attr@block=#1\relax\DE@attr@area=\DE@cellarea\relax}{#2}{#3}}
\newcommand\DEsp[3]{\DE@par{\DE@noattrs}{#2}{#3}}
\newcommand\DEbibentry[3]{\DE@par{\DE@attr@block=#1\relax\DE@attr@area=1\relax}{#2}{#3}}
% Vertical gaps between blocks, computed by the converter (larger-of rule, 03 §7). \DEgap is
% dropped at a page break, \DEgapkeep (the top of a page) is not.
\newcommand*\DEgap[1]{\vskip #1\relax}
\newcommand*\DEgapkeep[1]{\par\vspace*{#1}}
% \penalty rather than \nopagebreak, which longtable redefines for use between rows.
\newcommand*\DEkeep{\penalty\@M}
\newcommand*\DEpb{\par\newpage}
\protected\def\DEbr{\hfil\penalty-10000\relax}
\protected\def\DEbrpage{\vadjust{\penalty-10000}\hfil\penalty-10000\relax}
\protected\def\DEbrcol{\par\columnbreak\noindent}
\protected\def\DEtab{{\DE@attr@tab=1 \hskip 0pt\relax}}

% Labels (EXP-024; ADR 0032 §5): a label is placed at the number position (left indent plus
% first-line indent) and aligned there; the text follows at the next tab stop after the label,
% which is the left indent when the label fits in the hanging indent.
\newbox\DE@lbox
\newdimen\DE@lstart
% \DE@labellayout{label}{align: 0 start, 1 centre, 2 end}: sets \DE@lstart and \DE@labelT.
\newcommand\DE@labellayout[2]{%
  \setbox\DE@lbox\hbox{#1}%
  \DE@lstart=\dimexpr\DE@indL+\DE@indF\relax
  \ifcase#2\relax\or \advance\DE@lstart-.5\wd\DE@lbox \or \advance\DE@lstart-\wd\DE@lbox \fi
  \directlua{docedit.labeltab(\number\dimexpr\DE@lstart+\wd\DE@lbox\relax,
    \number\DE@indL, \number\DE@indF, \the\DE@tabs)}}

% Headings: kernel sectioning with class formatting, so bookmarks and tagging work natively.
% \DEh{n}{level}{properties}{plain text for bookmark and TOC (pdfString)}{label}{align}{content}
\def\DE@hprops{}
\def\DE@hblock{\DE@unset}
\newcommand\DE@hfmt{\DE@defaults\DE@hprops\DE@apply
  \DE@attr@block=\DE@hblock\relax\DE@attr@area=1\relax}
\renewcommand\section{\@startsection{section}{1}{\z@}{-1sp}{1sp}{\DE@hfmt}}
\renewcommand\subsection{\@startsection{subsection}{2}{\z@}{-1sp}{1sp}{\DE@hfmt}}
\renewcommand\subsubsection{\@startsection{subsubsection}{3}{\z@}{-1sp}{1sp}{\DE@hfmt}}
\renewcommand\paragraph{\@startsection{paragraph}{4}{\z@}{-1sp}{1sp}{\DE@hfmt}}
\renewcommand\subparagraph{\@startsection{subparagraph}{5}{\z@}{-1sp}{1sp}{\DE@hfmt}}
\def\DE@defsec#1#2{%
  \newcounter{#1}%
  \expandafter\def\csname toclevel@#1\endcsname{#2}%
  \expandafter\def\csname #1\endcsname{\@startsection{#1}{#2}{\z@}{-1sp}{1sp}{\DE@hfmt}}}
\DE@defsec{DEsecvi}{6}
\DE@defsec{DEsecvii}{7}
\DE@defsec{DEsecviii}{8}
\DE@defsec{DEsecix}{9}
% The tagging code names sectioning levels -1 to 5 only; levels 6 to 9 take the roles of level 5
% (subparagraph, H6 in the PDF), so they nest without gaps but do not get deeper heading tags.
\ifdefined\NewStructureName
  \def\DE@secnames#1{%
    \NewStructureName{sec/#1}\AssignStructureRole{sec/#1}{subparagraph}%
    \NewStructureName{sec/#1/title}\AssignStructureRole{sec/#1/title}{subparagraph-heading}%
    \NewStructureName{sec/#1/fragment}\AssignStructureRole{sec/#1/fragment}{heading-fragment}%
    \NewStructureName{sec/#1/number}\AssignStructureRole{sec/#1/number}{heading-number}}
  \DE@secnames{6}\DE@secnames{7}\DE@secnames{8}\DE@secnames{9}
\fi
\def\DE@seccmd#1{\ifcase#1\or section\or subsection\or subsubsection\or paragraph\or
  subparagraph\or DEsecvi\or DEsecvii\or DEsecviii\or DEsecix\fi}
% The heading label: a box from the number position to the text start (first line only).
\newcommand\DE@hlabel[2]{%
  \setbox\DE@lbox\hbox{#1}%
  \ifdim\wd\DE@lbox>\z@
    \DE@labellayout{\unhcopy\DE@lbox}{#2}%
    \hskip\dimexpr\DE@lstart-\DE@indL\relax
    \hbox to\dimexpr\DE@labelT-\DE@lstart\relax{\box\DE@lbox\hss}%
  \fi}
\newcommand\DEh[7]{%
  \par
  \def\DE@hprops{#3}\def\DE@hblock{#1}%
  \prevdepth=-1000pt
  \csname\DE@seccmd{#2}\endcsname[#4]{\DE@hlabel{#5}{#6}#7}%
  \def\DE@hprops{}\def\DE@hblock{\DE@unset}}

% Lists: the kernel's list environment, so that tagging gives L, LI, Lbl and LBody. Labels are
% literal text from the numbering algorithm; no LaTeX counter numbers a list (09 §3.1).
% \begin{DElist}{left margin} ... \end{DElist}; \DEli{n}{properties}{label}{align}{content}
\newenvironment{DElist}[1]{%
  \list{}{\leftmargin=#1\relax \labelwidth=0pt \labelsep=0pt \itemindent=0pt
    \topsep=0pt \partopsep=0pt \parsep=0pt \itemsep=0pt \listparindent=0pt \rightmargin=0pt
    \def\makelabel##1{##1}}}
  {\endlist}
\newcommand\DEli[5]{%
  \begingroup
    \DE@defaults #2\DE@apply
    \DE@attr@block=#1\relax \DE@attr@area=1\relax
    \DE@labellayout{#3}{#4}%
    \leftskip=\dimexpr\DE@indL-\@totalleftmargin\relax
    \itemindent=\dimexpr\DE@labelT-\DE@indL\relax
    \labelwidth=\dimexpr\DE@labelT-\DE@lstart\relax
    \parindent=\z@
    \prevdepth=-1000pt
    \item[\hbox to\labelwidth{\box\DE@lbox\hss}]#5\par
  \endgroup}

% Footnotes (EXP-029): the mark is an atom of the paragraph and prints the literal mark of the
% numbering algorithm; the text, in area 2, belongs to the footnote's paragraph block.
% \DEfnmark{offset}{n}{mark}; \DEfntext{n}{mark}{properties}{content}
\def\thefootnote{\csname DE@fnmark@\the\c@footnote\endcsname}
\newcommand\DEfnmark[3]{%
  \expandafter\gdef\csname DE@fnmark@\the\numexpr\c@footnote+1\endcsname{#3}%
  \DEa{#1}{\footnotemark}%
  \expandafter\xdef\csname DE@fnnum@#2\endcsname{\the\c@footnote}}
\newcommand\DEfntext[4]{%
  {\DE@noattrs\DE@attr@block=#1\relax\DE@attr@area=2\relax
   \footnotetext[\csname DE@fnnum@#1\endcsname]{\DE@defaults #3\DE@apply #4}}}

% Tables: longtable in the body flow (09 §3.2).
% \DEtbl{n}{header rows}{align: 0 start, 1 centre, 2 end}{cell margin}{rule width}{rule colour}
\newcount\DE@cellarea \DE@cellarea=1
% Rules and glue of the table itself are area 5 (frame): they mark where the table starts, but a
% page that continues a table starts with its first cell, not with a rule.
\newcommand*\DE@tblsetup[6]{%
  \DE@attr@block=#1\relax\DE@attr@area=5\relax\global\DE@cellarea=1
  \ifdefined\tagpdfsetup
    \ifnum#2>0 \tagpdfsetup{table/header-rows={\DE@rows{#2}}}%
    \else \tagpdfsetup{table/header-rows={}}\fi
  \fi
  \tabcolsep=#4\relax \arrayrulewidth=#5\relax \arrayrulecolor[HTML]{#6}%
  \global\DE@tblrule=#5\relax \global\let\DE@tblarc\CT@arc@
  \def\arraystretch{1}}
% Cell borders (EXP-038). \DEvrule{width}{colour} is a vertical rule for a !{} column separator.
% \DEcline{from-to}{width}{colour} is a \cline in that width and colour; \DEclinegap{width} moves
% down to the second line of a double border; \DEclineend gives back the table's own rule width
% and colour, which \DE@tblsetup keeps in \DE@tblrule and \DE@tblarc.
\newdimen\DE@tblrule
\let\DE@tblarc\relax
\protected\def\DEvrule#1#2{{\color[HTML]{#2}\vrule width#1\relax}}
\newcommand*\DEcline[3]{\noalign{\global\arrayrulewidth=#2\relax\gdef\CT@arc@{\color[HTML]{#3}}}\cline{#1}}
\newcommand*\DEclinegap[1]{\noalign{\vskip\dimexpr\doublerulesep+#1\relax}}
\newcommand*\DEclineend{\noalign{\global\arrayrulewidth=\DE@tblrule\relax\global\let\CT@arc@\DE@tblarc}}
\newcommand*\DEtbl[6]{\par\DE@tblsetup{#1}{#2}{#3}{#4}{#5}{#6}%
  \ifcase#3 \LTleft=0pt \LTright=\fill \or \LTleft=\fill \LTright=\fill
  \else \LTleft=\fill \LTright=0pt \fi}
\def\DE@rows#1{1\ifnum#1>1 ,2\fi\ifnum#1>2 ,3\fi\ifnum#1>3 ,4\fi\ifnum#1>4 ,5\fi}
\newcommand*\DEtblend{\par\DE@noattrs\global\DE@cellarea=1 }
% Rows of the head that longtable repeats on later pages are area 3 (tableHead in layout.json).
\newcommand*\DErephead{\noalign{\global\DE@cellarea=3\relax}}
\newcommand*\DEbodyrows{\noalign{\global\DE@cellarea=1\relax}}
\setlength\LTpre{0pt}
\setlength\LTpost{0pt}
% A boxed table (multi-column sections, headers, footers): \DEboxtbl{n}{0}{align}{margin}{rule
% width}{rule colour}{column spec} ... \DEboxtblend. It cannot span pages (09 §3.2).
\newcommand\DEboxtbl[7]{\par\begingroup\DE@tblsetup{#1}{#2}{#3}{#4}{#5}{#6}\noindent
  \ifcase#3\or\hfill\or\hfill\fi\begin{tabular}{#7}}
\newcommand*\DEboxtblend{\end{tabular}\par\endgroup}
% Space inside a cell (cell margins top and bottom).
\newcommand*\DEcellpad[1]{\par\vskip#1\relax}
% A cell that spans rows: \DErowspan{rows}{content}. Its content hangs from the first row over the
% rows below (no multirow). With tagging, the cell carries /RowSpan rows in the structure tree
% (EXP-041 criterion 4; the key is tagpdf's table/multirow from latex-lab's table test phase).
\newcommand\DErowspan[2]{\par\ifdefined\tagpdfsetup\tagpdfsetup{table/multirow=#1}\fi\vbox to\z@{#2\vss}}
% A cell that spans columns: \DEcolspan{columns}{column spec}{content}. It is the class's own
% cell macro around \multicolumn, so the converter never writes \multicolumn for a span itself.
\newcommand\DEcolspan[3]{\multicolumn{#1}{#2}{#3}}

% Equations: math that passed the gate. \DEeq{n}{anchor}{number or empty}{math}. Numbers are the
% literal labels of the numbering algorithm, printed with \tag (ADR 0032).
\newcommand\DEeq[4]{%
  \par\begingroup\DE@attr@block=#1\relax\DE@attr@area=1\relax\DE@defaults\DE@apply
  \abovedisplayskip=\z@ \belowdisplayskip=\z@ \abovedisplayshortskip=\z@ \belowdisplayshortskip=\z@
  \prevdepth=-1000pt
  \noindent#2%
  \if\relax\detokenize{#3}\relax \begin{equation*}\DE@clipmath{#4}\end{equation*}%
  \else \begin{equation*}\DE@clipmath{#4}\tag{#3}\end{equation*}\fi
  \par\endgroup}
% Display equations are clipped to their box (EXP-052 criterion 5): the math is measured in a box, and
% the box's outline (the origin, the width, the height plus the depth) is a clip path around it.
% The clip path is written in scaled points (\number of a dimension, no unit) under a PDF matrix
% that turns one scaled point into big points (72/72.27/65536 = 0.00001520178239); the matrix is
% undone straight after `W n`, so the clip stays in big points and the box's content is not scaled.
\newbox\DE@cbox
\newcommand*\DE@clipout{%
  \edef\DE@clipstr{0.00001520178239 0 0 0.00001520178239 0 0 cm
    0 \number\dimexpr-\dp\DE@cbox\relax\space \number\wd\DE@cbox\space
    \number\dimexpr\ht\DE@cbox+\dp\DE@cbox\relax\space re W n 65781.76 0 0 65781.76 0 0 cm}%
  \pdfextension save\pdfextension literal direct{\DE@clipstr}\box\DE@cbox\pdfextension restore}
\newcommand\DE@clipmath[1]{\setbox\DE@cbox=\hbox{$\displaystyle#1$}\DE@clipout}
% Inline equations are not clipped yet (EXP-052 criterion 5, Notes): a box around them stops the
% line breaker from breaking inside an equation, and it moves the line-start offsets of EXP-055.
\newcommand\DEmath[1]{$#1$}

% Pictures (EXP-028): \DEimg{file}{width}{height}{height in twips}{alt}. The height counts as a
% run of its own in the line height (ADR 0032 §4).
\newcommand\DEimg[5]{{\DE@attr@rlh=#4\relax\DE@attr@rld=0\relax
  \includegraphics[width=#2,height=#3,alt=#5]{#1}}}
% \DEfig{n}{float}{align: 0 start, 1 centre, 2 end}{picture}{caption}: picture and caption kept
% together; a floating figure may move to the top or bottom of a page.
\newcommand\DE@figbody[3]{%
  \par\begingroup\DE@defaults\DE@apply\prevdepth=-1000pt\noindent
  \ifcase#1\or\hfill\or\hfill\fi #2\ifcase#1\hfill\or\hfill\or\fi\par\endgroup
  \penalty\@M #3}
\newcommand\DEfig[5]{\par\begingroup\DE@attr@block=#1\relax\DE@attr@area=1\relax
  \ifnum#2=1 \begin{figure}[tbp]\DE@figbody{#3}{#4}{#5}\end{figure}%
  \else \DE@figbody{#3}{#4}{#5}\fi\par\endgroup}
\newcommand\DEcap[2]{\DE@par{}{#1}{#2}}

% A block or inline construct that the converter does not typeset: a visible placeholder.
\newcommand\DEplaceholder[2]{\par\begingroup\DE@defaults\DE@apply
  \DE@attr@block=#1\relax\DE@attr@area=1\relax
  \prevdepth=-1000pt\noindent\fbox{#2}\par\endgroup}
% A region hidden from the requester (ADR 0019): a neutral notice in place of its content.
\newcommand\DEhidden[2]{\par\begingroup\DE@defaults\DE@apply
  \DE@attr@block=#1\relax\DE@attr@area=1\relax
  \prevdepth=-1000pt\noindent{\itshape #2}\par\endgroup}

% Fields (EXP-019)
\newcommand*\DEpage{\thepage}
\newcommand*\DEpages{\PreviousTotalPages}
% styleRef: marks set at the paragraphs of a style, read in headers and footers.
\newcommand*\DEdefmark[1]{\NewMarkClass{DEsr#1}}
\newcommand\DEmark[2]{\InsertMark{DEsr#1}{#2}}
\newcommand*\DEsref[1]{\FirstMark{DEsr#1}}

% Form fields (EXP-033; 12 §12): \DEff{tagged}{width}{label}{value}. The value is flattened into
% the text at the field's width and tagged as a span whose alternative text is the label; an
% empty or redacted value prints as blank space of that width. No live form field is made.
% The label is the alternative text of the span. Its value is \DEstr-coded, and \directlua is not
% expandable, so tagpdf would store the macro itself. docedit.altdef sets \DE@altlabel to the
% decoded characters (globally) first, and the span takes that (U-EXP-033-048).
\newcommand\DE@altsetup[1]{\directlua{docedit.altdef("#1")}}
\ExplSyntaxOn
\cs_new_protected:Npn \DE@tagalt #1 #2
  {
    \begingroup
      \let\DEstr\DE@altsetup
      #1
    \endgroup
    \exp_args:Ne \DE@tagspan { alt = { \DE@altlabel } } {#2}
  }
\ExplSyntaxOff
\newbox\DE@ffbox
% \DEfieldno{k}: the field box that follows is reported in layout.json under number k (EXP-058).
% Used inside a group, so the attribute ends with the field.
\newcommand\DEfieldno[1]{\DE@attr@field=#1\relax}
\newcommand\DEff[4]{%
  \setbox\DE@ffbox\hbox{#4}%
  \ifdim#2>\z@
    \ifdim\wd\DE@ffbox>#2\relax
      \typeout{docedit-warning: field_too_wide block \the\DE@attr@block}%
    \fi
  \fi
  \ifnum#1=1 \DE@tagalt{#3}{\DE@ffshow{#2}}\else\DE@ffshow{#2}\fi}
\newcommand\DE@ffshow[1]{\ifdim#1>\z@\hbox to#1{\unhbox\DE@ffbox\hss}\else\box\DE@ffbox\fi}

% Table of contents and lists of captions (EXP-023): \DEtoc{n}{min level}{max level};
% \DElistof{n}{list}; \DEcaption{list}{n}{plain text} at a caption. Entries take the TOC1 to
% TOC9 styles (\DEtocstyle) and link to their target.
\def\DE@tocmin{1}\def\DE@tocmax{9}
\newcommand*\DEtocstyle[2]{\@namedef{DE@tocstyle@#1}{#2}}
% With \DocumentMetadata, the kernel's \contentsline no longer wraps the entry in a link: it keeps
% the destination in \@contentsline@destination, and \@dottedtocline calls the contentsline/text
% and contentsline/page hooks, in which hyperref starts and ends the link and tagpdf opens the
% entry's structure (latex-lab-toc). This line is the class's own, so it calls the same hooks and
% marks the leaders as an artifact as the kernel does. Without \DocumentMetadata, hyperref's own
% \contentsline puts the link into #2 and #3, and the hooks are skipped.
\def\DE@tochook#1#2#3#4{\ifdefined\@contentsline@destination
  \UseHookWithArguments{contentsline/#1}{4}{#2}{#3}{#4}{\@contentsline@destination}\fi}
\def\DE@tocleaders{\ifdefined\@contentsline@destination
    \UseTaggingSocket{toc/leaders/before}\SuspendTagging{toc/leaders}%
    \leaders\hbox to .5em{\hss.\hss}\hfill
    \ResumeTagging{toc/leaders}\UseTaggingSocket{toc/leaders/after}%
  \else \leaders\hbox to .5em{\hss.\hss}\hfill \fi}
\newcommand\DE@tocline[3]{%
  \ifnum#1<\DE@tocmin\relax\else\ifnum#1>\DE@tocmax\relax\else
    \par\begingroup\DE@defaults
      \ifcsname DE@tocstyle@#1\endcsname\csname DE@tocstyle@#1\endcsname
      \else \DEil{\dimexpr 11bp*(#1-1)\relax}\fi
      \DE@apply\prevdepth=-1000pt
      \noindent
      \DE@tochook{text/before}{#1}{#2}{#3}#2\DE@tochook{text/after}{#1}{#2}{#3}%
      \nobreak\DE@tocleaders\nobreak
      \hbox{\DE@tochook{page/before}{#1}{#2}{#3}#3\DE@tochook{page/after}{#1}{#2}{#3}}\par
    \endgroup
  \fi\fi}
\renewcommand*\l@section{\DE@tocline{1}}
\renewcommand*\l@subsection{\DE@tocline{2}}
\renewcommand*\l@subsubsection{\DE@tocline{3}}
\renewcommand*\l@paragraph{\DE@tocline{4}}
\renewcommand*\l@subparagraph{\DE@tocline{5}}
\newcommand*\l@DEsecvi{\DE@tocline{6}}
\newcommand*\l@DEsecvii{\DE@tocline{7}}
\newcommand*\l@DEsecviii{\DE@tocline{8}}
\newcommand*\l@DEsecix{\DE@tocline{9}}
\newcommand*\l@DEcap{\DE@tocline{1}}
\newcommand*\DEtoc[3]{\par\begingroup\DE@attr@block=#1\relax\DE@attr@area=1\relax
  \def\DE@tocmin{#2}\def\DE@tocmax{#3}\setcounter{tocdepth}{#3}%
  \@starttoc{toc}\par\endgroup}
\newcommand*\DEdeflist[1]{}
\newcommand*\DElistof[2]{\par\begingroup\DE@attr@block=#1\relax\DE@attr@area=1\relax
  \def\DE@tocmin{1}\def\DE@tocmax{9}\@starttoc{lq#2}\par\endgroup}
\newcommand\DEcaption[3]{\phantomsection\addcontentsline{lq#1}{DEcap}{#3}}

% ---------------------------------------------------------------------------------------------
% Page setups and page sections (EXP-017, EXP-018; 03 §7, header growth; ADR 0032 §6).
% \DEdefsetup{k}{width}{height}{top}{right}{bottom}{left}{gutter}{header distance}
% \DEdefsetupb{k}{footer distance}{columns}{column gap}{first page}{odd and even}{page number
%   start or -1}{page number format}
% \DEdefsetupc{k}{header}{first header}{even header}{footer}{first footer}{even footer}
% Stories are numbers (\DEdefstory), 0 for none.
\newcommand*\DEdefsetup[9]{%
  \@namedef{DE@ps@#1@w}{#2}\@namedef{DE@ps@#1@h}{#3}\@namedef{DE@ps@#1@mt}{#4}%
  \@namedef{DE@ps@#1@mr}{#5}\@namedef{DE@ps@#1@mb}{#6}\@namedef{DE@ps@#1@ml}{#7}%
  \@namedef{DE@ps@#1@g}{#8}\@namedef{DE@ps@#1@hd}{#9}}
\newcommand*\DEdefsetupb[8]{%
  \@namedef{DE@ps@#1@fd}{#2}\@namedef{DE@ps@#1@cols}{#3}\@namedef{DE@ps@#1@gap}{#4}%
  \@namedef{DE@ps@#1@dfp}{#5}\@namedef{DE@ps@#1@doe}{#6}\@namedef{DE@ps@#1@pn}{#7}%
  \@namedef{DE@ps@#1@pnf}{#8}}
\newcommand*\DEdefsetupc[7]{%
  \@namedef{DE@ps@#1@hdef}{#2}\@namedef{DE@ps@#1@hfirst}{#3}\@namedef{DE@ps@#1@heven}{#4}%
  \@namedef{DE@ps@#1@fdef}{#5}\@namedef{DE@ps@#1@ffirst}{#6}\@namedef{DE@ps@#1@feven}{#7}%
  \@namedef{ps@DEps@#1}{\DE@pagestyle{#1}{0}}%
  \@namedef{ps@DEps@#1@first}{\DE@pagestyle{#1}{1}}}
\newcommand\DEdefstory[2]{\@namedef{DE@story@#1}{#2}}
% The watermark of a page setup (03 §4.1; EXP-036 criterion 2): \DEdefwatermark{k}{text}, the text
% already written through the text emitter (empty for none). \DE@wm{k} sets it in the header box of
% every page that uses the setup, across the text block and out of the tagged reading order.
\newcommand\DEdefwatermark[2]{\@namedef{DE@ps@#1@wm}{#2}}
\def\DE@wm#1{\rlap{\lower\dimexpr\headheight+\headsep+.5\textheight\relax
  \hbox to\textwidth{\hss\SuspendTagging{docedit}{\color{black!25}\Huge\bfseries\csname DE@ps@#1@wm\endcsname}\ResumeTagging{docedit}\hss}}}
\def\DE@ps#1#2{\csname DE@ps@#1@#2\endcsname}
\def\DE@story#1{\ifnum#1>0 \csname DE@story@#1\endcsname\fi}
% The story a page shows (ADR 0032 §6): the first page of a section shows the first-page story
% when the setup has one; otherwise an even page shows the even story when odd and even differ.
\def\DE@pick#1#2#3{% setup, h or f, first page of the section: the model's headerFor and footerFor
  \directlua{tex.sprint(docedit.slot(\DE@ps{#1}{dfp}, \DE@ps{#1}{doe}, #3, \ifodd\c@page 0\else 1\fi,
    \DE@ps{#1}{#2first}, \DE@ps{#1}{#2even}, \DE@ps{#1}{#2def}))}}
\newdimen\DE@hh \newdimen\DE@fh \newdimen\DE@tmpd \newbox\DE@mbox
\newdimen\DE@frametop \newdimen\DE@framebottom
\def\DE@pagestyle#1#2{%
  \def\@oddhead{\DE@noattrs\DE@wm{#1}\vbox to\headheight{\hsize\textwidth\DE@story{\DE@pick{#1}{h}{#2}}\vss}\hss}%
  \def\@oddfoot{\DE@noattrs\vbox to\DE@fh{\hsize\textwidth\DE@story{\DE@pick{#1}{f}{#2}}\vss}\hss}%
  \let\@evenhead\@oddhead \let\@evenfoot\@oddfoot}
% The height of a story at the text width (header and footer growth).
\def\DE@measure#1{%
  \setbox\DE@mbox\vbox{\hsize\textwidth\DE@noattrs\SuspendTagging{docedit}%
    \DE@story{#1}\ResumeTagging{docedit}}%
  \ifdim\dimexpr\ht\DE@mbox+\dp\DE@mbox\relax>\DE@tmpd \DE@tmpd=\dimexpr\ht\DE@mbox+\dp\DE@mbox\relax\fi}
% The first page setup, for geometry (09 §3.1).
\newcommand*\DEgeometry[1]{%
  \DE@tmpd=\dimexpr\DE@ps{#1}{ml}+\DE@ps{#1}{g}\relax
  \geometry{paperwidth=\DE@ps{#1}{w}, paperheight=\DE@ps{#1}{h}, top=\DE@ps{#1}{mt},
    bottom=\DE@ps{#1}{mb}, left=\the\DE@tmpd, right=\DE@ps{#1}{mr}, headheight=0pt, headsep=0pt,
    footskip=0pt}}
% Sets the page from setup #1: at the start of the document and of each page section, on a new
% page. Dimensions are set directly; \newgeometry is not used (09 §3.1).
\newcount\DE@cursetup
\def\DE@applysetup#1{%
  \global\DE@cursetup=#1\relax
  \directlua{docedit.setup(#1)}%
  \global\paperwidth=\DE@ps{#1}{w}\relax \global\paperheight=\DE@ps{#1}{h}\relax
  \global\pagewidth=\paperwidth \global\pageheight=\paperheight
  \global\textwidth=\dimexpr\paperwidth-\DE@ps{#1}{ml}-\DE@ps{#1}{mr}-\DE@ps{#1}{g}\relax
  \global\linewidth=\textwidth \global\columnwidth=\textwidth \global\hsize=\textwidth
  \global\oddsidemargin=\dimexpr\DE@ps{#1}{ml}+\DE@ps{#1}{g}-1in\relax
  \global\evensidemargin=\oddsidemargin
  \DE@tmpd=\z@ \DE@measure{\DE@ps{#1}{hdef}}\DE@measure{\DE@ps{#1}{hfirst}}\DE@measure{\DE@ps{#1}{heven}}%
  \global\DE@hh=\DE@tmpd
  \DE@tmpd=\z@ \DE@measure{\DE@ps{#1}{fdef}}\DE@measure{\DE@ps{#1}{ffirst}}\DE@measure{\DE@ps{#1}{feven}}%
  \global\DE@fh=\DE@tmpd
  % The body starts at the larger of the top margin and the header's bottom, and ends at the
  % smaller of the bottom margin and the footer's top: the model's bodyFrame, in docedit.lua
  % (03 §7; ADR 0032 §6).
  \directlua{docedit.frame(\number\paperheight, \number\dimexpr\DE@ps{#1}{mt}\relax,
    \number\dimexpr\DE@ps{#1}{mb}\relax, \number\dimexpr\DE@ps{#1}{hd}\relax,
    \number\dimexpr\DE@ps{#1}{fd}\relax, \number\DE@hh, \number\DE@fh)}%
  \global\topmargin=\dimexpr\DE@ps{#1}{hd}-1in\relax
  \global\headheight=\DE@hh
  \global\headsep=\dimexpr\DE@frametop-\DE@ps{#1}{hd}-\DE@hh\relax
  \global\textheight=\dimexpr\DE@framebottom-\DE@frametop\relax
  \global\footskip=\dimexpr\paperheight-\DE@ps{#1}{fd}-\DE@framebottom\relax
  \global\vsize=\textheight \global\@colht=\textheight \global\@colroom=\textheight
  \ifnum\DE@ps{#1}{pn}>-1 \global\c@page=\DE@ps{#1}{pn}\relax\fi
  \xdef\DE@pnf{\DE@ps{#1}{pnf}}%
  \pagestyle{DEps@#1}%
  \ifnum\DE@ps{#1}{dfp}=1 \thispagestyle{DEps@#1@first}\fi}
\def\DE@pnf{0}
\renewcommand*\thepage{\directlua{docedit.pagenumber(\DE@pnf, \the\c@page)}}
\newif\ifDE@cols
\def\DE@begincols{%
  \ifnum\DE@ps{\the\DE@cursetup}{cols}>1
    \columnsep=\DE@ps{\the\DE@cursetup}{gap}\relax
    \begin{multicols}{\DE@ps{\the\DE@cursetup}{cols}}\DE@colstrue
  \fi}
\def\DE@endcols{\ifDE@cols\end{multicols}\fi}
\newcommand*\DEstartsetup[1]{\DE@applysetup{#1}\DE@begincols}
% \DEsection{k}{start: 0 next page, 1 even page, 2 odd page, 3 continuous}
\newcommand*\DEsection[2]{%
  \par\DE@endcols
  \ifcase#2\relax
    \clearpage\DE@applysetup{#1}%
  \or \clearpage\ifodd\c@page\null\clearpage\fi\DE@applysetup{#1}%
  \or \clearpage\ifodd\c@page\else\null\clearpage\fi\DE@applysetup{#1}%
  \or % continuous: columns change here; page size and margins cannot (09 §3.1)
    \global\DE@cursetup=#1\relax \directlua{docedit.setup(#1)}\pagestyle{DEps@#1}%
  \fi
  \DE@begincols}
\newcommand*\DEendsections{\par\DE@endcols}

% ---------------------------------------------------------------------------------------------
% No package or class can be loaded after the class (09 §9.3 item 5; EXP-015).
\AtBeginDocument{%
  \def\usepackage{\ClassError{docedit}{Packages cannot be loaded by a bundle}{}\@gobble}%
  \def\RequirePackage{\ClassError{docedit}{Packages cannot be loaded by a bundle}{}\@gobble}%
  \def\documentclass{\ClassError{docedit}{A bundle cannot load a class}{}\@gobble}}
\endinput
