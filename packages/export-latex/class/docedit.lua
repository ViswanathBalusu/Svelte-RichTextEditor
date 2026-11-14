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
      local lh = has_attribute(n, A.rlh)
      if lh and (id == GLYPH or id == HLIST or id == VLIST or id == RULE) and lh > tallest then
        tallest, descent = lh, has_attribute(n, A.rld) or 0
      end
    end
    n = getnext(n)
  end
  return tallest, descent
end

-- post_linebreak_filter: tab stops, then line boxes.
local function lines(head)
  local h = todirect(head)
  local para = paragraph_of(h)
  if not para then return true end
  local n = h
  while n do
    local id = getid(n)
    if id == HLIST and getsubtype(n) == HLIST_LINE then
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
    elseif id == GLUE then
      local st = getsubtype(n)
      if st == GLUE_BASELINE or st == GLUE_LINESKIP then setglue(n, 0, 0, 0, 0, 0) end
    end
    n = getnext(n)
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

function docedit.init(attrs, lvl)
  A = attrs
  level = lvl
  luatexbase.add_to_callback("post_linebreak_filter", lines, "docedit.lines")
  luatexbase.add_to_callback("pre_linebreak_filter", pre_tabs, "docedit.tabs")
  luatexbase.declare_callback_rule("pre_linebreak_filter", "luaotfload.node_processor", "before", "docedit.tabs")
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
