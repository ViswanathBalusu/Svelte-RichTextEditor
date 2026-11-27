-- fonts.lua: builds the worker's font directory (09 §5; spike S4, SPK-017).
--
-- Usage: texlua fonts.lua <output directory> [<directory of the Noto faces>]
--
-- Copies the fonts the house class uses out of the TeX Live tree into <output directory>, each
-- named by its SHA-256, and writes fonts.json: the font manifest the converter reads. Every font
-- here is under the SIL Open Font License 1.1, so it may be bundled and used on a server.
-- The image runs it at build time; the worker runs the same script for local compiles, so both
-- paths load fonts by path and hash and never by a system lookup.

kpse.set_program_name("luatex")

local out = arg[1]
if not out or out == "" then
  io.stderr:write("usage: texlua fonts.lua <output directory>\n")
  os.exit(2)
end
out = out:gsub("\\", "/"):gsub("/$", "")
do -- mkdir -p
  local path = ""
  for part in out:gmatch("[^/]+") do
    path = (path == "" and (out:sub(1, 1) == "/" and "/" or "") or path .. "/") .. part
    if not lfs.isdir(path) then lfs.mkdir(path) end
  end
end

local function hex(s)
  return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

local function read(name)
  local kind = name:match("%.otf$") and "opentype fonts" or "truetype fonts"
  local path = kpse.find_file(name, kind)
  if not path then error("font not found in the TeX tree: " .. name) end
  local f = assert(io.open(path, "rb"))
  local data = f:read("*a")
  f:close()
  return data
end

-- Word's single line height: (usWinAscent + usWinDescent) / unitsPerEm, in thousandths.
local function line_height(data)
  local tables = {}
  local num = string.unpack(">I2", data, 5)
  for i = 0, num - 1 do
    local tag, _, offset = string.unpack(">c4I4I4", data, 13 + 16 * i)
    tables[tag] = offset
  end
  local upem = string.unpack(">I2", data, tables["head"] + 18 + 1)
  local ascent, descent = string.unpack(">I2I2", data, tables["OS/2"] + 74 + 1)
  return math.floor((ascent + descent) * 1000 / upem + 0.5)
end

local faces = {}
local function face(name)
  if faces[name] then return faces[name] end
  local data = read(name)
  local sha = hex(sha2.digest256(data))
  local file = sha .. (name:match("%.otf$") and ".otf" or ".ttf")
  local f = assert(io.open(out .. "/" .. file, "wb"))
  f:write(data)
  f:close()
  faces[name] = { file = file, sha256 = sha, source = name, lineHeight = line_height(data) }
  return faces[name]
end

local families = {
  { "Noto Serif", "NotoSerif-Regular.ttf", "NotoSerif-Bold.ttf", "NotoSerif-Italic.ttf", "NotoSerif-BoldItalic.ttf" },
  { "Noto Sans", "NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "NotoSans-Italic.ttf", "NotoSans-BoldItalic.ttf" },
  -- Noto Sans Mono has no italic faces in TeX Live; the upright faces stand in.
  { "Noto Sans Mono", "NotoSansMono-Regular.ttf", "NotoSansMono-Bold.ttf", "NotoSansMono-Regular.ttf", "NotoSansMono-Bold.ttf" },
}

local function face_json(f)
  return string.format('{"file":"%s","sha256":"%s"}', f.file, f.sha256)
end

local parts = {}
for i, fam in ipairs(families) do
  local r, b, it, bi = face(fam[2]), face(fam[3]), face(fam[4]), face(fam[5])
  parts[#parts + 1] = string.format(
    '%s{"name":"%s","lineHeight":%d,"regular":%s,"bold":%s,"italic":%s,"boldItalic":%s,"licence":"OFL-1.1"}',
    i > 1 and "," or "", fam[1], r.lineHeight, face_json(r), face_json(b), face_json(it), face_json(bi))
end
local math_face = face("STIXTwoMath-Regular.otf")

-- The fallback chain (09 §3.2; EXP-026, EXP-047): the math face first, then the faces of the
-- optional directory given as the second argument, in the order of its fallback.txt (lines of
-- name, file name and licence, separated by tabs; scripts/fetch-noto-fonts.ts writes it). Those
-- files are not in the TeX tree: they are read from that directory, not found by kpathsea.
local math_name = '{"name":"STIX Two Math","file":"%s","sha256":"%s","licence":"OFL-1.1"}'
local chain = { string.format(math_name, math_face.file, math_face.sha256) }
local extra = arg[2]
if extra and extra ~= "" then
  extra = extra:gsub("\\", "/"):gsub("/$", "")
  local list = assert(io.open(extra .. "/fallback.txt", "r"))
  for line in list:lines() do
    local name, file, licence = line:match("^([^\t]+)\t([^\t]+)\t([^\t]+)$")
    if name then
      local f = assert(io.open(extra .. "/" .. file, "rb"))
      local data = f:read("*a")
      f:close()
      local sha = hex(sha2.digest256(data))
      local stored = sha .. (file:match("%.otf$") and ".otf" or ".ttf")
      local o = assert(io.open(out .. "/" .. stored, "wb"))
      o:write(data)
      o:close()
      chain[#chain + 1] = string.format(
        '{"name":"%s","file":"%s","sha256":"%s","licence":"%s"}', name, stored, sha, licence)
    end
  end
  list:close()
end

local manifest = string.format(
  '{"version":1,"families":[%s],"math":{"name":"STIX Two Math","file":"%s","sha256":"%s","licence":"OFL-1.1"},"fallback":[%s],"defaultFamily":"Noto Serif"}\n',
  table.concat(parts), math_face.file, math_face.sha256, table.concat(chain, ","))
local f = assert(io.open(out .. "/fonts.json", "w"))
f:write(manifest)
f:close()
io.write(manifest)
