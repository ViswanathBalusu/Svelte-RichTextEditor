-- warmup.lua: helpers for warmup.tex (spike S4). Kept out of the .tex file so that TeX never
-- tokenizes the Lua code.
local dir = "/opt/docedit/fonts"
local warmup = {}

function warmup.mathfont()
  local f = assert(io.open(dir .. "/fonts.json"))
  local manifest = f:read("*a")
  f:close()
  local file = manifest:match('"math":{[^}]-"file":"([0-9a-f]+%.otf)"')
  tex.sprint("\\setmathfont{" .. file .. "}[Path=" .. dir .. "/]")
end

function warmup.fonts()
  local n = 0
  for name in lfs.dir(dir) do
    if name:match("%.ttf$") or name:match("%.otf$") then
      n = n + 1
      for _, mode in ipairs({ "node", "harf" }) do
        tex.sprint("\\font\\DEwarm={[" .. dir .. "/" .. name .. "]:mode=" .. mode .. ";}\\DEwarm Aa ")
      end
    end
  end
  texio.write_nl("warm-up: " .. n .. " font files")
end

return warmup
