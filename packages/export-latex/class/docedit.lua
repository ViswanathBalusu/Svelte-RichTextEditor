-- docedit.lua: the Lua half of docedit.cls (house class 0.2.1).
--
-- 1. Decodes the hexadecimal strings that the converter's pdfString, kvValue and url emitters
--    write (09 §4). User strings never reach TeX's tokenizer as source: TeX only ever sees the
--    digits 0-9 and A-F, and this file turns them into catcode-12 characters.
-- 2. Sets line heights per line (09 §3.1, Spacing; 03 §7; ADR 0032 §4) in post_linebreak_filter:
--    a line under `multiple` is lineSpacing thousandths of the natural height of its tallest run,
--    `exact` and `atLeast` are lengths. Each line becomes a box of exactly that height, stacked
--    edge to edge with its neighbours; the extra height of a line sits above its text (ADR 0046).
-- 3. Places tab stops (03 §7, Tabs; ADR 0032 §5) and list labels, with the model's rule
--    `nextTabStop` (packages/model/src/spacing/tabs.ts) ported here unchanged.
-- 4. Reports layout (09 §7.1): block, run and offset attributes on the material, a walk of each
--    page at shipout, and main.layout (integers only), which the worker joins with map.json.
--
-- Lengths of the model are integers in twips (1/20 bp); TeX works in scaled points.

local docedit = {}

local direct            = node.direct
local todirect          = direct.todirect
local tonode            = direct.tonode
local getid             = direct.getid
local getnext           = direct.getnext
local getprev           = direct.getprev
local getlist           = direct.getlist
local setlist           = direct.setlist
local getsubtype        = direct.getsubtype
local getchar           = direct.getchar
local getwhd            = direct.getwhd
local getwidth          = direct.getwidth
local setheight         = direct.setheight
local setdepth          = direct.setdepth
local getshift          = direct.getshift
local getkern           = direct.getkern
local getglue           = direct.getglue
local setglue           = direct.setglue
local getfont           = direct.getfont
local has_attribute     = direct.has_attribute
local set_attribute     = direct.set_attribute
local effective_glue    = direct.effective_glue
local hpack             = direct.hpack
local free              = direct.free
local new_node          = direct.new
local insert_before     = direct.insert_before
local setleader         = direct.setleader
local setsubtype        = direct.setsubtype
local setattributelist  = direct.setattributelist
local getattributelist  = direct.getattributelist

local GLYPH   = node.id("glyph")
local GLUE    = node.id("glue")
local KERN    = node.id("kern")
local DISC    = node.id("disc")
local MATH    = node.id("math")
local HLIST   = node.id("hlist")
local VLIST   = node.id("vlist")
local RULE    = node.id("rule")
local PENALTY = node.id("penalty")
local LOCAL_PAR = node.id("local_par")

local function subtype_number(kind, name)
  for number, subtype in pairs(node.subtypes(kind)) do
    if subtype == name then return number end
  end
  return -1
end

local GLUE_SPACESKIP   = subtype_number("glue", "spaceskip")
local GLUE_XSPACESKIP  = subtype_number("glue", "xspaceskip")
local GLUE_BASELINE    = subtype_number("glue", "baselineskip")
local GLUE_LINESKIP    = subtype_number("glue", "lineskip")
local GLUE_RIGHTSKIP   = subtype_number("glue", "rightskip")
local GLUE_PARFILL     = subtype_number("glue", "parfillskip")
local GLUE_LEADERS     = subtype_number("glue", "leaders")
local GLUE_USER        = subtype_number("glue", "userskip")
local DISC_EXPLICIT    = subtype_number("disc", "explicit")
local HLIST_LINE       = subtype_number("hlist", "line")
local HLIST_INDENT     = subtype_number("hlist", "indent")
local MATH_BEGIN       = subtype_number("math", "beginmath")

-- Attribute register numbers, set by init().
local A = {}
local level = 2 -- layout report: 0 off, 1 block, 2 line

-- 1 twip = 1/20 bp = 65781.76 / 20 sp.
local SP_PER_TWIP = 65781.76 / 20
local function sp(twips) return math.floor(twips * SP_PER_TWIP + 0.5) end

-- ---------------------------------------------------------------------------------------------
-- Hexadecimal strings (pdfString, kvValue, url emitters)

local function decode(hex)
  if type(hex) ~= "string" or #hex % 2 ~= 0 or hex:find("[^0-9A-F]") then
    tex.error("docedit: malformed encoded string")
    return ""
  end
  return (hex:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end))
end

-- Characters of catcode 12 (space 10): inert in every context, including \pdfstringdef.
function docedit.str(hex)
  tex.sprint(-2, decode(hex))
end

-- The same text for the contexts that turn a title into a PDF string (bookmarks, link contents,
-- metadata). hyperref reads a catcode-12 backslash there as the start of an escape and garbles the
-- rest of the string, so a backslash is written as \textbackslash, which every such context knows.
function docedit.strexp(hex)
  local s = decode(hex)
  local pos = 1
  while true do
    local i = s:find("\\", pos, true)
    if not i then
      tex.sprint(-2, s:sub(pos))
      return
    end
    tex.sprint(-2, s:sub(pos, i - 1))
    tex.sprint("\\textbackslash ")
    pos = i + 1
  end
end

-- Sets \DE@altlabel globally to the decoded text, as catcode-12 characters: the alternative text
-- of a tagged form field (EXP-033). \directlua is not expandable, so the text is set, not printed.
function docedit.altdef(hex)
  token.set_macro("DE@altlabel", decode(hex), "global")
end

-- \href{<url as catcode-12 characters>}; the TypeScript url emitter has already applied the
-- scheme allow-list (invariant I9) and percent-encoding.
function docedit.href(hex)
  local url = decode(hex)
  if url:find("[%s{}\\]") then
    tex.error("docedit: refused URL")
    url = ""
  end
  tex.sprint("\\href{")
  tex.sprint(-2, url)
  tex.sprint("}")
end

-- The font directory comes from the worker (environment), never from the bundle.
local function font_directory()
  local path = os.getenv("DOCEDIT_FONT_PATH") or ""
  if path == "" or not path:match("^[A-Za-z0-9_./:-]+/$") then
    tex.error("docedit: DOCEDIT_FONT_PATH must be set to a font directory ending in /")
    return nil
  end
  return path
end

function docedit.fontpath()
  local path = font_directory()
  if path then tex.sprint(-2, path) end
end

-- The directory of a family's files. A tenant's own font (EXP-048) comes with the job, in the job's
-- tenant-fonts/ directory, under its hash name like every other font; the worker puts it there for
-- that tenant's jobs only. A file that is not there is read from the image's font directory.
function docedit.fontpath_of(file)
  local path = font_directory()
  if not path then return end
  if type(file) == "string" and file:match("^[0-9a-f]+%.[ot]t[fc]$") then
    local f = io.open("tenant-fonts/" .. file, "rb")
    if f then
      f:close()
      tex.sprint(-2, "tenant-fonts/")
      return
    end
  end
  tex.sprint(-2, path)
end

-- The fallback chain (09 §3.2; EXP-026, EXP-047): faces from the font directory, named by their
-- SHA-256 like every other font, in the order of the font manifest. luaotfload takes a glyph from
-- the first face of the chain that has it.
local fallbacks = {}
function docedit.fallback(file, renderer)
  local path = font_directory()
  if not path then return end
  if type(file) ~= "string" or not file:match("^[0-9a-f]+%.[ot]t[fc]$") then
    tex.error("docedit: a fallback font is not a font file of the font directory")
    return
  end
  local mode = renderer == "HarfBuzz" and "harf" or "node"
  fallbacks[#fallbacks + 1] = "[" .. path .. file .. "]:mode=" .. mode .. ";-tlig"
  luaotfload.add_fallback("docedit", fallbacks)
end

-- ---------------------------------------------------------------------------------------------
-- Number formats: the model's formatNumber (packages/model/src/numbering/format.ts) for page
-- numbers, so the page number format follows the same rules as labels.

local ROMAN = { {900, "cm"}, {500, "d"}, {400, "cd"}, {100, "c"}, {90, "xc"}, {50, "l"},
                {40, "xl"}, {10, "x"}, {9, "ix"}, {5, "v"}, {4, "iv"}, {1, "i"} }

local function roman(v)
  local out = string.rep("m", v // 1000)
  local rest = v % 1000
  for _, p in ipairs(ROMAN) do
    while rest >= p[1] do out = out .. p[2]; rest = rest - p[1] end
  end
  return out
end

local function letters(v)
  local letter = string.char(97 + (v - 1) % 26)
  return string.rep(letter, (v - 1) // 26 + 1)
end

-- format: 0 decimal, 1 lowerRoman, 2 upperRoman, 3 lowerLetter, 4 upperLetter
function docedit.format_number(format, value)
  local n = math.max(0, math.floor(value))
  if format == 1 then return n < 1 and tostring(n) or roman(n) end
  if format == 2 then return n < 1 and tostring(n) or roman(n):upper() end
  if format == 3 then return n < 1 and tostring(n) or letters(n) end
  if format == 4 then return n < 1 and tostring(n) or letters(n):upper() end
  return tostring(n)
end

function docedit.pagenumber(format, value)
  tex.sprint(-2, docedit.format_number(format, value))
end

-- ---------------------------------------------------------------------------------------------
-- The model's line height (packages/model/src/spacing/lines.ts), in twips.
-- rule: 0 multiple (value in thousandths), 1 exact, 2 atLeast (value a length).

function docedit.line_height(rule, value, tallest)
  if rule == 1 then return value end
  if rule == 2 then return math.max(value, tallest) end
  return (value * tallest + 500) // 1000
end

-- ---------------------------------------------------------------------------------------------
-- Tab stops. Lists are defined once in styles.tex (\DEdeftabs) and named by number.

local tablists = { [0] = {} }
local default_tab = 720

function docedit.deftabs(k, spec)
  local list = {}
  for pos, align, leader in spec:gmatch("(%d+):([lcrd]):([ndhumt])") do
    list[#list + 1] = { position = tonumber(pos), align = align, leader = leader }
  end
  table.sort(list, function(x, y) return x.position < y.position end)
  tablists[k] = list
end

function docedit.defaulttab(t)
  default_tab = math.max(1, t)
end

-- The model's nextTabStop, unit-agnostic: every argument in the same unit.
function docedit.next_tab_stop(tabs, indent_left, indent_first, step, x)
  local best = nil
  for _, t in ipairs(tabs) do
    if t.position > x then
      best = { position = t.position, align = t.align, leader = t.leader, source = "stop" }
      break
    end
  end
  if indent_first < 0 and indent_left > x and (best == nil or indent_left < best.position) then
    best = { position = indent_left, align = "l", leader = "n", source = "hanging" }
  end
  local last = (#tabs > 0) and tabs[#tabs].position or x
  local position = (math.floor(math.max(x, last) / step) + 1) * step
  if best and best.position <= position then return best end
  return { position = position, align = "l", leader = "n", source = "default" }
end

-- The model's placeTab: where the segment after a tab starts.
function docedit.place_tab(tabs, indent_left, indent_first, step, x, width, before_decimal)
  local tab = docedit.next_tab_stop(tabs, indent_left, indent_first, step, x)
  local start
  if tab.align == "r" then start = tab.position - width
  elseif tab.align == "c" then start = tab.position - math.floor(width / 2)
  elseif tab.align == "d" then start = tab.position - (before_decimal or width)
  else start = tab.position end
  tab.start = math.max(x, start)
  return tab
end

local function sp_tabs(k)
  local list = tablists[k] or tablists[0]
  local out = {}
  for i, t in ipairs(list) do
    out[i] = { position = sp(t.position), align = t.align, leader = t.leader }
  end
  return out
end

-- The width of an unbroken discretionary: its replacement text (an explicit hyphen, a ligature).
local natural
local function disc_width(n)
  local _, _, replace = direct.getdisc(n)
  local w = 0
  while replace do
    w = w + natural(replace)
    replace = getnext(replace)
  end
  return w
end

-- A tab is user glue with the tab attribute. Glue the line breaker makes at a break (the right
-- skip) takes the attributes of the glue it replaces, so the subtype is checked too.
local function is_tab(n)
  return getid(n) == GLUE and getsubtype(n) == GLUE_USER and has_attribute(n, A.tab) ~= nil
end

-- The width of material up to the next tab, line break or the end of the line, and for a
-- decimal stop the width up to its first full stop.
local function segment(n)
  local w, wdec = 0, nil
  while n do
    local id = getid(n)
    if id == GLUE then
      local st = getsubtype(n)
      if st == GLUE_RIGHTSKIP or st == GLUE_PARFILL or is_tab(n) then break end
      w = w + (getglue(n))
    elseif id == PENALTY then
      -- a forced break ends the segment
      if direct.getpenalty(n) <= -10000 then break end
    elseif id == GLYPH then
      if wdec == nil and getchar(n) == 0x2E then wdec = w end
      w = w + getwidth(n)
    elseif id == KERN then
      w = w + getkern(n)
    elseif id == HLIST or id == VLIST or id == RULE then
      w = w + getwidth(n)
    elseif id == DISC then
      w = w + disc_width(n)
    end
    n = getnext(n)
  end
  return w, wdec
end

natural = function(n)
  local id = getid(n)
  if id == GLUE then return (getglue(n)) end
  if id == DISC then return disc_width(n) end
  if id == KERN then return getkern(n) end
  if id == GLYPH or id == HLIST or id == VLIST or id == RULE then return getwidth(n) end
  return 0
end

-- A leader for the span of a tab (EXP-032): dots, hyphens, middle dots, or a rule.
local function make_leader(n, leader, font)
  local box
  if leader == "u" or leader == "t" then
    local r = new_node("rule")
    -- a line just below the baseline: 0.4 pt thick, 0.9 pt for the heavy leader. A horizontal leader
    -- takes its width from its box, and a bare rule node in an hlist is drawn as a bar of the line's
    -- height, so the rule sits in a 1 pt box whose repeats join into one line.
    direct.setwhd(r, tex.sp("1pt"), -tex.sp("1pt"), leader == "t" and tex.sp("1.9pt") or tex.sp("1.4pt"))
    box = hpack(r)
  else
    local char = leader == "h" and 0x2D or leader == "m" and 0xB7 or 0x2E
    local g = new_node("glyph")
    direct.setfont(g, font)
    direct.setchar(g, char)
    setattributelist(g, getattributelist(n))
    box = hpack(g)
    direct.setwidth(box, getwidth(box) + tex.sp("1pt"))
  end
  setattributelist(box, getattributelist(n))
  setleader(n, box)
  setsubtype(n, GLUE_LEADERS)
end

-- Resolves every tab of a horizontal list. `x0` is the position of the list's start from the
-- left margin; returns whether a tab was found.
local function resolve_tabs(head, x0, para, tolerance)
  local found = false
  local x = x0
  local n = head
  local font = nil
  local tabs = nil
  while n do
    if getid(n) == GLYPH and not font then font = getfont(n) end
    if is_tab(n) then
      tabs = tabs or sp_tabs(para.tabs)
      local w, wdec = segment(getnext(n))
      local t = docedit.place_tab(tabs, para.indl, para.indf, sp(default_tab), x, w, wdec)
      local width = t.start - x
      -- Before line breaking a tab may shrink a little, so that a stop at the right margin fits
      -- despite rounding between twips and scaled points; after breaking it is rigid.
      setglue(n, width, 0, math.min(width, tolerance or 0), 0, 0)
      if t.leader ~= "n" and width > 0 then
        local f = font
        local m = getnext(n)
        while not f and m do
          if getid(m) == GLYPH then f = getfont(m) end
          m = getnext(m)
        end
        if f then make_leader(n, t.leader, f) end
      end
      x = t.start
      found = true
    else
      x = x + natural(n)
    end
    n = getnext(n)
  end
  return found
end

-- The paragraph's attributes: from the local_par node, else from the first node that has them
-- (a footnote's text starts before the class's settings apply).
local function paragraph_of(head)
  local n = head
  local depth = 0
  local function look(m)
    while m do
      local r = has_attribute(m, A.lsr)
      if r then
        return {
          rule = r,
          value = has_attribute(m, A.lsv) or 1000,
          plh = has_attribute(m, A.plh) or 0,
          pld = has_attribute(m, A.pld) or 0,
          tabs = has_attribute(m, A.tabs) or 0,
          indl = has_attribute(m, A.indl) or 0,
          indf = has_attribute(m, A.indf) or 0,
          indr = (A.indr and has_attribute(m, A.indr)) or 0,
          shade = (A.shade and has_attribute(m, A.shade)) or 0,
          bord = (A.bord and has_attribute(m, A.bord)) or 0,
        }
      end
      local id = getid(m)
      if (id == HLIST or id == VLIST) and depth < 3 then
        depth = depth + 1
        local p = look(getlist(m))
        depth = depth - 1
        if p then return p end
      end
      m = getnext(m)
    end
    return nil
  end
  return look(n)
end

-- The natural height of a line's tallest run and its descent part, in twips (ADR 0032 §4).
local function tallest_run(head)
  local tallest, descent = 0, 0
  local inmath, mh, md = false, 0, 0
  local n = head
  while n do
    local id = getid(n)
    if id == MATH then
      if getsubtype(n) == MATH_BEGIN then
        inmath, mh, md = true, 0, 0
      else
        inmath = false
        local h = math.floor((mh + md) / SP_PER_TWIP + 0.5)
        local d = math.floor(md / SP_PER_TWIP + 0.5)
        if h > tallest then tallest, descent = h, d end
      end
    elseif inmath then
      if id == GLYPH or id == HLIST or id == VLIST or id == RULE then
        local _, h, d = getwhd(n)
        if h > mh then mh = h end
        if d > md then md = d end
      end
    else
      -- The paragraph indent box carries the paragraph's own font attributes. It is not a run, so it
      -- must not lift the first line (ADR 0032 §4; EXP-021): an empty line falls back to the paragraph.
      local lh = not (id == HLIST and getsubtype(n) == HLIST_INDENT) and has_attribute(n, A.rlh)
      if lh and (id == GLYPH or id == HLIST or id == VLIST or id == RULE) and lh > tallest then
        tallest, descent = lh, has_attribute(n, A.rld) or 0
      end
    end
    n = getnext(n)
  end
  return tallest, descent
end

-- Paragraph shading and borders (03 §4.5; EXP-020). A paragraph's lines stack without glue between
-- them, so the fill is drawn line by line: each line box starts with a PDF literal that fills the
-- box from the left indent to the right indent, and strokes the left and right borders. The first
-- line grows by the top border and its space and draws it; the last line does the same below. A
-- paragraph that breaks across pages keeps its side borders and fill on both pages. The drawing is
-- marked as an artifact, so tagged output does not read it.
local SP_PER_BP = 65781.76
local borderlists = {}
local BORDER_SIDE = { t = "top", b = "bottom", l = "left", r = "right" }

-- spec: "side:style:width:space:RRGGBB;..." with side t, b, l or r, style s (single), d (double),
-- o (dotted), a (dashed) or k (thick), and width and space in twips.
function docedit.defborders(k, spec)
  local list = {}
  for side, style, width, space, colour in
    spec:gmatch("([tblr]):([sdoak]):(%d+):(%d+):(%x%x%x%x%x%x)")
  do
    local w = sp(tonumber(width))
    list[BORDER_SIDE[side]] = {
      style = style,
      width = w,
      total = style == "d" and 3 * w or w,
      space = sp(tonumber(space)),
      colour = tonumber(colour, 16),
    }
  end
  borderlists[k] = list
end

-- The attribute value of a shading colour: the colour plus one, so that zero is no shading.
function docedit.shade_value(hex)
  local v = tonumber(hex, 16)
  return v and v + 1 or 0
end
function docedit.shade(hex) tex.sprint(tostring(docedit.shade_value(hex))) end

local function bp(v) return string.format("%.3f", v / SP_PER_BP) end
local function rgb(c, op)
  return string.format("%.3f %.3f %.3f %s",
    (c // 65536) / 255, (c // 256 % 256) / 255, (c % 256) / 255, op)
end

-- One border as PDF operators: a line from (x1, y1) to (x2, y2), in scaled points from the start
-- of the line box on its baseline. (nx, ny) is the unit normal a double border is doubled along.
local function stroke(out, b, x1, y1, x2, y2, nx, ny)
  out[#out + 1] = rgb(b.colour, "RG") .. " " .. bp(b.width) .. " w"
  if b.style == "o" then
    out[#out + 1] = "[" .. bp(b.width) .. " " .. bp(b.width) .. "] 0 d"
  elseif b.style == "a" then
    out[#out + 1] = "[" .. bp(3 * b.width) .. " " .. bp(2 * b.width) .. "] 0 d"
  else
    out[#out + 1] = "[] 0 d"
  end
  local offsets = b.style == "d" and { -b.width, b.width } or { 0 }
  for _, o in ipairs(offsets) do
    out[#out + 1] = bp(x1 + o * nx) .. " " .. bp(y1 + o * ny) .. " m "
      .. bp(x2 + o * nx) .. " " .. bp(y2 + o * ny) .. " l S"
  end
end

-- The PDF operators that draw the shading and borders of one line box of width w, height h and
-- depth d (scaled points), and the box's new height and depth. Exposed for the texlua tests.
function docedit.decoration(para, w, h, d, first, last)
  local borders = borderlists[para.bord] or {}
  local shade = para.shade > 0 and para.shade - 1 or nil
  if not shade and not next(borders) then return nil, h, d end
  local top, bottom, left, right = borders.top, borders.bottom, borders.left, borders.right
  if first and top then h = h + top.space + top.total end
  if last and bottom then d = d + bottom.space + bottom.total end
  -- the text edges, then the outer edges of the side borders
  local x0 = math.min(para.indl, para.indl + para.indf)
  local x1 = w - para.indr
  if left then x0 = x0 - left.space - left.total end
  if right then x1 = x1 + right.space + right.total end
  local out = { "/Artifact BMC q" }
  if shade then
    out[#out + 1] = rgb(shade, "rg") .. " " .. bp(x0) .. " " .. bp(-d) .. " " .. bp(x1 - x0)
      .. " " .. bp(h + d) .. " re f"
  end
  if left then stroke(out, left, x0 + left.total / 2, -d, x0 + left.total / 2, h, 1, 0) end
  if right then stroke(out, right, x1 - right.total / 2, -d, x1 - right.total / 2, h, 1, 0) end
  if first and top then stroke(out, top, x0, h - top.total / 2, x1, h - top.total / 2, 0, 1) end
  if last and bottom then
    stroke(out, bottom, x0, -d + bottom.total / 2, x1, -d + bottom.total / 2, 0, 1)
  end
  out[#out + 1] = "Q EMC"
  return table.concat(out, " "), h, d
end

local PDF_LITERAL
local function decorate(line, para, first, last)
  local w, h, d = getwhd(line)
  local data, nh, nd = docedit.decoration(para, w, h, d, first, last)
  if not data then return end
  setheight(line, nh)
  setdepth(line, nd)
  PDF_LITERAL = PDF_LITERAL or node.subtype("pdf_literal")
  local lit = new_node(node.id("whatsit"), PDF_LITERAL)
  direct.setfield(lit, "mode", 0)
  direct.setfield(lit, "data", data)
  local list = getlist(line)
  if list then setlist(line, insert_before(list, list, lit)) else setlist(line, lit) end
end

-- Inline equations are clipped to their box (EXP-052 criterion 5). \DEmath sets DE@attr@mclip on
-- the math nodes of an equation. In each line, the material from the start of an equation to its
-- end (or from the start of the line, or to its end, where the line breaker broke inside it) is
-- measured with the line's glue, and a PDF clip path of that box is put round it: `q ... W n`
-- before it and `Q` after it. The box is cut to the height and depth of the line. Nothing here changes the line breaks or the offsets of EXP-055,
-- since the clip is made after the breaking and only adds whatsits.
local function clip_literal(mode, data)
  PDF_LITERAL = PDF_LITERAL or node.subtype("pdf_literal")
  local lit = new_node(node.id("whatsit"), PDF_LITERAL)
  direct.setfield(lit, "mode", mode)
  direct.setfield(lit, "data", data)
  return lit
end

local function clip_math(line, open)
  local list = getlist(line)
  if not list then return open end
  local gset, gorder, gsign = getglue(line)
  local segments = {}
  local from = open and list or nil -- first node of the segment; the opening math node for a new one
  local opening = nil
  local n = list
  while n do
    if getid(n) == MATH and has_attribute(n, A.mclip) then
      if getsubtype(n) == MATH_BEGIN then
        from, opening = getnext(n), n
        open = true
      elseif open then
        segments[#segments + 1] = { first = from, stop = n, opening = opening, closing = n }
        from, opening, open = nil, nil, false
      end
    end
    n = getnext(n)
  end
  if open then segments[#segments + 1] = { first = from, stop = nil, opening = opening } end
  for _, seg in ipairs(segments) do
    if seg.first then
      local w, h, d = direct.dimensions(gset, gsign, gorder, seg.first, seg.stop)
      -- The equation is also kept inside its line (SEC-034 criterion 5): where the line is shorter
      -- than the equation (an exact line height, or a multiple below one), what lies above or below
      -- the line is cut off and cannot be painted over the text of the lines around it.
      local _, line_h, line_d = getwhd(line)
      if h > line_h then h = line_h end
      if d > line_d then d = line_d end
      local head = getlist(line)
      -- `q` is written where the stream's origin is the page's (mode 2, direct: no translation), so
      -- that the matching `Q` restores the origin that the backend believes in. The rectangle is
      -- written at the box's own origin (mode 0, origin).
      local anchor = seg.opening or head
      head = insert_before(head, anchor, clip_literal(2, "q"))
      head = insert_before(head, anchor,
        clip_literal(0, "0 " .. bp(-d) .. " " .. bp(w) .. " " .. bp(h + d) .. " re W n"))
      head = direct.insert_after(head, seg.closing or direct.tail(head), clip_literal(2, "Q"))
      setlist(line, head)
    end
  end
  return open
end

-- post_linebreak_filter: tab stops, then line boxes, then shading and borders.
local function lines(head)
  local h = todirect(head)
  local para = paragraph_of(h)
  if not para then return true end
  local first_line, last_line
  local clipping = false
  local n = h
  while n do
    local id = getid(n)
    if id == HLIST and getsubtype(n) == HLIST_LINE then
      first_line = first_line or n
      last_line = n
      local list = getlist(n)
      if resolve_tabs(list, getshift(n), para) then
        local w = getwidth(n)
        local box = hpack(list, w, "exactly")
        -- for boxes, getglue and setglue read and write glue_set, glue_order and glue_sign
        local gset, gorder, gsign = getglue(box)
        setglue(n, gset, gorder, gsign)
        setlist(box, nil)
        free(box)
      end
      local tallest, descent = tallest_run(list)
      if tallest == 0 then tallest, descent = para.plh, para.pld end
      local lh = docedit.line_height(para.rule, para.value, tallest)
      if descent > lh then descent = lh end
      setheight(n, sp(lh - descent))
      setdepth(n, sp(descent))
      clipping = clip_math(n, clipping)
    elseif id == GLUE then
      local st = getsubtype(n)
      if st == GLUE_BASELINE or st == GLUE_LINESKIP then setglue(n, 0, 0, 0, 0, 0) end
    end
    n = getnext(n)
  end
  if first_line and (para.shade > 0 or para.bord > 0) then
    n = h
    while n do
      if getid(n) == HLIST and getsubtype(n) == HLIST_LINE then
        decorate(n, para, n == first_line, n == last_line)
      end
      n = getnext(n)
    end
  end
  return true
end

-- Missing glyphs (09 §3.2; EXP-026, EXP-065): after shaping and the fallback chain, a glyph whose
-- character its font does not have is lost. One log line per character and block, which the
-- worker's log parser maps to the block: "docedit: missing U+XXXX in block N". With
-- \tracinglostchars=3 (final exports) TeX then stops the job; in previews it goes on.
local missing_seen = {}
local function report_missing(head)
  local n = head
  while n do
    local id = getid(n)
    if id == GLYPH then
      local f = getfont(n)
      local chars = fonts and fonts.hashes and fonts.hashes.characters and fonts.hashes.characters[f]
      local c = getchar(n)
      if chars and not chars[c] and c > 0x20 then
        local b = has_attribute(n, A.block) or 0
        local key = c .. ":" .. b
        if not missing_seen[key] then
          missing_seen[key] = true
          texio.write_nl("log", string.format("docedit: missing U+%04X in block %d", c, b))
        end
      end
    elseif id == HLIST or id == VLIST then
      report_missing(getlist(n))
    elseif id == DISC then
      report_missing(direct.getfield(n, "replace"))
    end
    n = getnext(n)
  end
end

local function hpack_missing(head)
  report_missing(todirect(head))
  return true
end
-- Vertical alignment of table cells (EXP-038). A cell is a \vtop that hangs from its first
-- baseline, and the height of its row is not known while the cell is set. So a centred or
-- bottom-aligned cell ends with a mark (\DEva), and when the page is shipped out the cell's box is
-- moved down inside its row: by the room under it for bottom (2), by half the room for centre (1).
-- The row is the horizontal box around the cell's own horizontal box (an \halign row and its cell).
local WHATSIT      = node.id("whatsit")
local USER_DEFINED = node.subtype("user_defined")
local VA_ID        = luatexbase.new_whatsit("docedit.va")
local getfield     = direct.getfield
local setfield     = direct.setfield
local va_used      = false

function docedit.va_mark(k)
  local n = node.new(WHATSIT, USER_DEFINED)
  n.user_id = VA_ID
  n.type = 100
  n.value = k
  node.write(n)
  va_used = true
end

local function va_of(box)
  local n = getlist(box)
  while n do
    if getid(n) == WHATSIT and getsubtype(n) == USER_DEFINED and getfield(n, "user_id") == VA_ID then
      return getfield(n, "value")
    end
    n = getnext(n)
  end
  return nil
end

-- The shading of a cell that spans rows (EXP-041 criterion 3). colortbl paints a cell's colour in
-- its own row, and the content of a row span hangs from the first row, so painting the covered
-- rows with \cellcolor would hide it. \DErowfill{rows}{RRGGBB} marks the cell; when the page is
-- shipped out, a filled rectangle is put at the start of the cell's box in the first row. It runs
-- from the bottom of that row down to the bottom of the last row the span covers, which is the sum
-- of what lies between (rows, rules and glue), so the content is drawn after it. A row of the
-- table holds a p-column box; the rows that \cline makes do not.
local SPAN_ID  = luatexbase.new_whatsit("docedit.span")
local spans    = {}
local BP       = 65781.76
-- The rectangle reaches 1 bp up into the first row, which has the same colour, so that a viewer
-- that anti-aliases the two edges draws no hairline between them.
local OVERLAP  = 65782

function docedit.rowfill(rows, hex)
  spans[#spans + 1] = { rows = rows, hex = hex }
  local n = node.new(WHATSIT, USER_DEFINED)
  n.user_id = SPAN_ID
  n.type = 100
  n.value = #spans
  node.write(n)
  va_used = true
end

local function span_of(box)
  local n = getlist(box)
  while n do
    if getid(n) == WHATSIT and getsubtype(n) == USER_DEFINED and getfield(n, "user_id") == SPAN_ID then
      return spans[getfield(n, "value")]
    end
    n = getnext(n)
  end
  return nil
end

local function is_table_row(row)
  local c = getlist(row)
  while c do
    if getid(c) == HLIST then
      local d = getlist(c)
      while d do
        if getid(d) == VLIST then return true end
        d = getnext(d)
      end
    end
    c = getnext(c)
  end
  return false
end

local function paint_span(cell, row, span)
  local _, _, rd = getwhd(row)
  local below, left = 0, span.rows - 1
  local m = getnext(row)
  while m and left > 0 do
    local id = getid(m)
    if id == HLIST then
      local _, h, d = getwhd(m)
      below = below + h + d
      if is_table_row(m) then left = left - 1 end
    elseif id == GLUE then
      below = below + (getglue(m) or 0)
    elseif id == KERN then
      below = below + getkern(m)
    elseif id == RULE then
      local _, h, d = getwhd(m)
      if h > -1000000000 and d > -1000000000 then below = below + h + d end
    end
    m = getnext(m)
  end
  if below <= 0 then return end
  local w = getwhd(cell)
  local r = tonumber(span.hex:sub(1, 2), 16) / 255
  local g = tonumber(span.hex:sub(3, 4), 16) / 255
  local b = tonumber(span.hex:sub(5, 6), 16) / 255
  local lit = new_node("whatsit", "pdf_literal")
  direct.setfield(lit, "mode", 0)
  direct.setfield(lit, "data", string.format(
    "/Artifact BMC q %.4f %.4f %.4f rg 0 %.4f %.4f %.4f re f Q EMC",
    r, g, b, -(rd + below) / BP, w / BP, (below + OVERLAP) / BP))
  direct.setlink(lit, getlist(cell))
  setlist(cell, lit)
end

local function va_walk(head, cell, row)
  local n = head
  while n do
    local id = getid(n)
    if id == HLIST then
      va_walk(getlist(n), n, cell)
    elseif id == VLIST then
      local sp = cell and row and span_of(n)
      if sp then paint_span(cell, row, sp) end
      local k = cell and row and va_of(n)
      if k then
        local _, rh, rd = getwhd(row)
        local _, vh, vd = getwhd(n)
        local room
        if k == 2 then room = rd - vd
        else room = math.floor(((rh + rd) - (vh + vd)) / 2) - (rh - vh) end
        if room > getshift(n) then setfield(n, "shift", room) end
      end
      va_walk(getlist(n), nil, nil)
    end
    n = getnext(n)
  end
end

function docedit.valign(box)
  if not va_used then return end
  local b = tex.box[box]
  if b then va_walk(getlist(todirect(b)), nil, nil) end
end

-- pre_linebreak_filter, after shaping: tabs on the first line are set before the line breaker
-- runs, so it measures them (the lines are measured again after breaking).
local function pre_tabs(head)
  local h = todirect(head)
  report_missing(h)
  local para = paragraph_of(h)
  if not para then return true end
  local x0 = (tex.getglue("leftskip")) or 0
  resolve_tabs(h, x0, para, tex.sp("0.5pt"))
  return true
end

-- The text start after a list or heading label (ADR 0032 §5: a label is followed by a tab):
-- `label_end` is where the label ends, from the left margin, in scaled points.
function docedit.labeltab(label_end, indent_left, indent_first, k)
  local t = docedit.next_tab_stop(sp_tabs(k), indent_left, indent_first, sp(default_tab), label_end)
  tex.setdimen("DE@labelT", t.position)
end

-- ---------------------------------------------------------------------------------------------
-- Header and footer growth (03 §7; ADR 0032 §6): the model's bodyFrame, headerFor and footerFor
-- (packages/model/src/spacing/page.ts), unit-agnostic.

function docedit.body_frame(height, margin_top, margin_bottom, header_distance, footer_distance,
                            header_height, footer_height)
  local header_bottom = header_distance + header_height
  local footer_top = height - footer_distance - footer_height
  local top = math.max(margin_top, header_bottom)
  local bottom = math.min(height - margin_bottom, footer_top)
  return { top = top, bottom = bottom, height = math.max(0, bottom - top),
           headerPushes = header_bottom > margin_top, footerPushes = footer_top < height - margin_bottom }
end

function docedit.frame(height, mt, mb, hd, fd, hh, fh)
  local f = docedit.body_frame(height, mt, mb, hd, fd, hh, fh)
  tex.setdimen("global", "DE@frametop", f.top)
  tex.setdimen("global", "DE@framebottom", math.max(f.top, f.bottom))
end

-- The story a page shows: first page of its section, then even pages, then the default. A slot
-- of 0 (none) means no story; it does not fall back to another slot.
function docedit.slot(different_first, different_odd_even, first, even, s_first, s_even, s_default)
  if first == 1 and different_first == 1 then return s_first end
  if even == 1 and different_odd_even == 1 then return s_even end
  return s_default
end
-- ---------------------------------------------------------------------------------------------
-- Offsets inside runs (layout report)

-- Runs carry DE@attr@run = the UTF-16 offset of their first character. Walking the unshaped list
-- in order, every glyph advances by its UTF-16 length, interword glue (one source space each) and
-- an explicit discretionary (\- from a soft hyphen) by one. Atoms (inline equations, footnote marks,
-- breaks, tabs, fields) carry DE@attr@atom and keep the run's offset. Material without a run
-- attribute (list labels, class text) is not counted, because it is not in the block's text.
local spent = { offsets = 0, walk = 0 }

local function assign_offsets(head)
  if level < 2 or head == nil then return true end
  local n = todirect(head)
  -- A list that was already numbered (a line repacked after line breaking) is left alone.
  local probe = n
  while probe do
    if has_attribute(probe, A.run) then
      if has_attribute(probe, A.pos) then return true end
      break
    end
    probe = getnext(probe)
  end
  local run, pos = nil, 0
  local inmath = false
  while n do
    local id = getid(n)
    local r = has_attribute(n, A.run)
    if r then
      if r ~= run then run, pos = r, r end
      if id == MATH then
        inmath = getsubtype(n) == MATH_BEGIN
        set_attribute(n, A.pos, pos)
      elseif inmath or has_attribute(n, A.atom) then
        set_attribute(n, A.pos, pos)
      elseif id == GLYPH then
        set_attribute(n, A.pos, pos)
        pos = pos + (getchar(n) >= 0x10000 and 2 or 1)
      elseif id == GLUE then
        local st = getsubtype(n)
        if st == GLUE_SPACESKIP or st == GLUE_XSPACESKIP then
          set_attribute(n, A.pos, pos)
          pos = pos + 1
        end
      elseif id == DISC then
        if getsubtype(n) == DISC_EXPLICIT then pos = pos + 1 end
      elseif id == HLIST or id == VLIST then
        set_attribute(n, A.pos, pos)
      end
    end
    n = getnext(n)
  end
  return true
end

-- ---------------------------------------------------------------------------------------------
-- Page walk at shipout

local pages = {}         -- [n] = { start = {b, o, y}, first = {b, area}, w, h, s }
local blocks = {}        -- [b] = { p, y, o }  first occurrence in the document
local lines_out = {}     -- { b, o, p, y } per line, in document order
local page_no = 0
local cur                -- state of the page being walked
local setup = 0          -- the page setup in force, set by the class at each section start

function docedit.setup(k) setup = k end

-- Areas: 1 body, 2 footnote, 3 repeated table head, 4 float, 5 table frame (rules, row glue).
local function note(n, y)
  local b = has_attribute(n, A.block)
  if not b then return end
  local area = has_attribute(n, A.area) or 1
  if area ~= 5 and not cur.first then cur.first = { b = b, area = area } end
  if area == 1 and not cur.start then
    cur.start = { b = b, o = has_attribute(n, A.pos) or 0, y = y }
  elseif area == 2 and not cur.fnstart then
    cur.fnstart = { b = b, o = has_attribute(n, A.pos) or 0, y = y }
  end
  if area ~= 3 and not blocks[b] then
    blocks[b] = { p = page_no, y = y, o = has_attribute(n, A.pos) or 0 }
  end
end

local walk_v, walk_h

-- The first positioned node of a line, searched depth-first.
local function first_pos(head)
  local n = head
  while n do
    local p = has_attribute(n, A.pos)
    if p and has_attribute(n, A.block) and (has_attribute(n, A.area) or 1) ~= 3 then
      return has_attribute(n, A.block), p
    end
    local id = getid(n)
    if id == HLIST or id == VLIST then
      local b, q = first_pos(getlist(n))
      if b then return b, q end
    end
    n = getnext(n)
  end
  return nil
end

-- Form fields (EXP-058): the first box of each numbered field, with its page and rectangle, in
-- scaled points from the top-left corner of the page (x0, y0 top-left; x1, y1 bottom-right).
local field_out = {}   -- [k] = { page, x0, y0, x1, y1 }

local function note_field(k, x0, y0, x1, y1)
  if field_out[k] == nil then field_out[k] = { page_no, x0, y0, x1, y1 } end
end

-- The horizontal advance of a node on a line (x is the left edge of the line's next node).
local function advance_x(n, parent)
  local id = getid(n)
  if id == RULE then
    return (getwhd(n))
  elseif id == GLYPH or id == MATH then
    return getwidth(n)
  elseif id == KERN then
    return getkern(n)
  elseif id == GLUE then
    return effective_glue(n, parent)
  end
  return 0
end

-- Horizontal walk (x: the left edge of `head`). A numbered field box is recorded and not entered.
walk_h = function(head, parent, base, x)
  local n = head
  while n do
    local id = getid(n)
    if id == HLIST then
      local w, h, d = getwhd(n)
      local b = base + getshift(n)
      note(n, base)
      local k = has_attribute(n, A.field)
      if k then
        note_field(k, x, b - h, x + w, b + d)
      else
        walk_h(getlist(n), n, b, x)
      end
      x = x + w
    elseif id == VLIST then
      note(n, base)
      local w, h = getwhd(n)
      walk_v(getlist(n), n, base + getshift(n) - h, x)
      x = x + w
    elseif id == GLYPH or id == RULE or id == GLUE or id == KERN or id == MATH then
      note(n, base)
      x = x + advance_x(n, parent)
    end
    n = getnext(n)
  end
end

walk_v = function(head, parent, top, left)
  local y = top
  local n = head
  while n do
    local id = getid(n)
    if id == HLIST then
      local _, h, d = getwhd(n)
      local base = y + h
      if level >= 2 and getsubtype(n) == HLIST_LINE then
        local b, o = first_pos(getlist(n))
        if b then lines_out[#lines_out + 1] = { b, o, page_no, base } end
      end
      walk_h(getlist(n), n, base, left + getshift(n))
      y = base + d
    elseif id == VLIST then
      local _, h, d = getwhd(n)
      walk_v(getlist(n), n, y, left + getshift(n))
      y = y + h + d
    elseif id == RULE then
      local _, h, d = getwhd(n)
      y = y + h + d
      note(n, y)
    elseif id == GLUE then
      y = y + effective_glue(n, parent)
    elseif id == KERN then
      y = y + getkern(n)
    end
    n = getnext(n)
  end
end

-- The page limit of 09 §9.3 item 4 for converter output. A hostile bundle can bypass the class,
-- so the hard bounds are the sandbox's time and output limits; this gives a clear diagnostic.
local max_pages = tonumber(os.getenv("DOCEDIT_MAX_PAGES") or "") or 2000

function docedit.page(boxnumber)
  page_no = page_no + 1
  if page_no > max_pages then
    tex.error("docedit: page limit exceeded (" .. max_pages .. " pages)")
    os.exit(3)
  end
  if level < 1 then return end
  local started = os.clock()
  local box = tex.getbox(boxnumber)
  cur = { s = setup }
  if box then
    local d = todirect(box)
    local _, h = getwhd(d)
    -- The box's top edge sits at the vertical origin (1in) plus \voffset below the page's top edge.
    local vorigin, horigin = 4736287, 4736287
    if pdf.getorigin then horigin, vorigin = pdf.getorigin() end
    local top = vorigin + tex.voffset
    local left = horigin + tex.hoffset
    cur.w, cur.h = tex.pagewidth, tex.pageheight
    if getid(d) == VLIST then walk_v(getlist(d), d, top, left) else walk_h(getlist(d), d, top + h, left) end
  end
  -- A page with no body text at all starts with the footnote text that continues on it.
  if not cur.start then cur.start = cur.fnstart end
  pages[page_no] = cur
  spent.walk = spent.walk + os.clock() - started
end

-- ---------------------------------------------------------------------------------------------
-- Output: main.layout, integers only. Lengths are scaled points from the top edge of the page.

-- Glue arithmetic can give floats; the report holds integers only.
local function int(v)
  return string.format("%d", math.floor(v + 0.5))
end

local function json_page(i, p)
  local parts = { '{"n":', int(i) }
  if p.w then parts[#parts + 1] = ',"w":' .. int(p.w) .. ',"h":' .. int(p.h) end
  if p.s then parts[#parts + 1] = ',"s":' .. int(p.s) end
  if p.start then
    parts[#parts + 1] = ',"start":[' .. int(p.start.b) .. ',' .. int(p.start.o) .. ','
      .. int(p.start.y) .. ']'
  end
  if p.first then
    parts[#parts + 1] = ',"first":[' .. int(p.first.b) .. ',' .. int(p.first.area) .. ']'
  end
  parts[#parts + 1] = '}'
  return table.concat(parts)
end

function docedit.finish()
  local out = {}
  out[#out + 1] = '{"v":1,"level":' .. level .. ',"pages":['
  for i = 1, page_no do
    out[#out + 1] = (i > 1 and ',' or '') .. json_page(i, pages[i] or {})
  end
  out[#out + 1] = '],"blocks":{'
  local keys = {}
  for b in pairs(blocks) do keys[#keys + 1] = b end
  table.sort(keys)
  for i, b in ipairs(keys) do
    local e = blocks[b]
    out[#out + 1] = (i > 1 and ',' or '') .. '"' .. int(b) .. '":[' .. int(e.p) .. ','
      .. int(e.y) .. ',' .. int(e.o) .. ']'
  end
  out[#out + 1] = '},"lines":['
  for i, l in ipairs(lines_out) do
    out[#out + 1] = (i > 1 and ',' or '') .. '[' .. int(l[1]) .. ',' .. int(l[2]) .. ','
      .. int(l[3]) .. ',' .. int(l[4]) .. ']'
  end
  out[#out + 1] = '],"fields":{'
  local fkeys = {}
  for k in pairs(field_out) do fkeys[#fkeys + 1] = k end
  table.sort(fkeys)
  for i, k in ipairs(fkeys) do
    local r = field_out[k]
    out[#out + 1] = (i > 1 and ',' or '') .. '"' .. int(k) .. '":[' .. int(r[1]) .. ',' .. int(r[2]) .. ','
      .. int(r[3]) .. ',' .. int(r[4]) .. ',' .. int(r[5]) .. ']'
  end
  out[#out + 1] = '}}'
  local f = io.open(tex.jobname .. ".layout", "w")
  if f then
    f:write(table.concat(out))
    f:close()
  end
  texio.write_nl("log", string.format("docedit: layout report CPU %d ms (offsets %d ms, page walk %d ms), %d pages, %d lines",
    math.floor((spent.offsets + spent.walk) * 1000 + 0.5), math.floor(spent.offsets * 1000 + 0.5),
    math.floor(spent.walk * 1000 + 0.5), page_no, #lines_out))
end

-- ---------------------------------------------------------------------------------------------

-- East Asian line breaking (09 §3.2; EXP-025 criterion 3). TeX breaks a line only at glue, a
-- penalty or a discretionary. Ideographs and kana have none between them, so a paragraph of
-- Chinese or Japanese is one box that runs past the right margin, and the text beyond the page
-- is lost from the PDF. Between two glyphs that follow each other, one of them an ideograph, a
-- kana or a CJK or full-width punctuation mark, this puts a glue of no width that can stretch
-- (so that justified lines can be filled), which is a break opportunity (UAX #14, class ID).
-- The rules of kinsoku shori keep a closing mark, a small kana or the prolonged sound mark off
-- the start of a line, and an opening mark off the end of one: there the glue follows a penalty
-- of 10000, which is not a break opportunity. Hangul is set as in Korean text, with breaks at its
-- spaces. This runs before shaping, on the characters as typed.
local EA_STRETCH = 0.1 -- of the font size
local ea_no_before = {}
local ea_no_after = {}
for _, c in ipairs({
  0x3001, 0x3002, 0xFF0C, 0xFF0E, 0xFF1A, 0xFF1B, 0xFF01, 0xFF1F, 0xFF09, 0xFF3D, 0xFF5D,
  0x3015, 0x3009, 0x300B, 0x300D, 0x300F, 0x3011, 0x3017, 0x3019, 0x301B, 0x309B, 0x309C,
  0x309D, 0x309E, 0x3005, 0x30FC, 0x30FB, 0x30FD, 0x30FE, 0x2025, 0x2026, 0xFF65,
  0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087, 0x308E, 0x3095, 0x3096,
  0x30A1, 0x30A3, 0x30A5, 0x30A7, 0x30A9, 0x30C3, 0x30E3, 0x30E5, 0x30E7, 0x30EE, 0x30F5, 0x30F6,
}) do ea_no_before[c] = true end
for _, c in ipairs({
  0xFF08, 0xFF3B, 0xFF5B, 0x3014, 0x3008, 0x300A, 0x300C, 0x300E, 0x3010, 0x3016, 0x3018, 0x301A,
}) do ea_no_after[c] = true end

local function ea_wide(c)
  return (c >= 0x2E80 and c <= 0x30FF) or (c >= 0x3100 and c <= 0x312F)
      or (c >= 0x31C0 and c <= 0x31FF) or (c >= 0x3400 and c <= 0x4DBF)
      or (c >= 0x4E00 and c <= 0x9FFF) or (c >= 0xF900 and c <= 0xFAFF)
      or (c >= 0xFE30 and c <= 0xFE4F) or (c >= 0xFF00 and c <= 0xFF60)
      or (c >= 0xFF61 and c <= 0xFF9F) or (c >= 0x20000 and c <= 0x3FFFF)
end

local ea_size = {}
local function ea_stretch(f)
  local s = ea_size[f]
  if not s then
    local data = font.getfont(f)
    s = math.floor(((data and data.size) or 655360) * EA_STRETCH)
    ea_size[f] = s
  end
  return s
end

local function ea_breaks(head)
  local h = todirect(head)
  local n = h
  while n do
    if getid(n) == GLYPH then
      local nx = getnext(n)
      if nx and getid(nx) == GLYPH then
        local a, b = getchar(n), getchar(nx)
        if ea_wide(a) or ea_wide(b) then
          local g = new_node(GLUE)
          setglue(g, 0, ea_stretch(getfont(n)), 0)
          setattributelist(g, getattributelist(n))
          if ea_no_before[b] or ea_no_after[a] then
            local p = new_node(PENALTY)
            direct.setfield(p, "penalty", 10000)
            setattributelist(p, getattributelist(n))
            direct.insert_after(h, n, p)
            direct.insert_after(h, p, g)
          else
            direct.insert_after(h, n, g)
          end
        end
      end
    end
    n = getnext(n)
  end
  return true
end
function docedit.init(attrs, lvl)
  A = attrs
  level = lvl
  luatexbase.add_to_callback("post_linebreak_filter", lines, "docedit.lines")
  luatexbase.add_to_callback("pre_linebreak_filter", pre_tabs, "docedit.tabs")
  luatexbase.declare_callback_rule("pre_linebreak_filter", "luaotfload.node_processor", "before", "docedit.tabs")
  luatexbase.add_to_callback("pre_linebreak_filter", ea_breaks, "docedit.eabreaks")
  luatexbase.declare_callback_rule("pre_linebreak_filter", "docedit.eabreaks", "before", "luaotfload.node_processor")
  luatexbase.add_to_callback("hpack_filter", hpack_missing, "docedit.missing")
  luatexbase.declare_callback_rule("hpack_filter", "luaotfload.node_processor", "before", "docedit.missing")
  if level >= 2 then
    local function timed(head)
      local t = os.clock()
      local r = assign_offsets(head)
      spent.offsets = spent.offsets + os.clock() - t
      return r
    end
    for _, cb in ipairs({ "pre_linebreak_filter", "hpack_filter" }) do
      luatexbase.add_to_callback(cb, timed, "docedit.offsets")
      luatexbase.declare_callback_rule(cb, "docedit.offsets", "before", "luaotfload.node_processor")
    end
  end
end

-- For tests that run this file with texlua, without TeX.
docedit._test = { sp = sp }

return docedit
