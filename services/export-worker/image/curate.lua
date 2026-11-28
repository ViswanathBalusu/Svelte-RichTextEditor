-- curate.lua: reduces the TeX Live installation of the image to the packages the house class needs
-- (09 section 9.3 item 5; EXP-073, SEC-053). Run once, as root, while the image is built:
--
--   texlua curate.lua <texlive root> <roots file> <licence directory>
--
-- The roots file (curated-roots.txt) names the packages the class, the compile script and the
-- build steps need. The script adds every package they depend on, following the `depend` lines of
-- the TeX Live package database (tlpkg/texlive.tlpdb); `name.ARCH` becomes the package of the
-- machine. A root that ends in `*` stands for every package whose name starts with the text before
-- it, `@AddHyphen` for every package that registers hyphenation patterns, and `!name` for a
-- package that is never kept. The `depend` lines are not complete, so the files of the packages
-- they reach are read once for the packages they load (`\RequirePackage`, `\usepackage`,
-- `\LoadClass`), and what that adds is followed by `depend` lines but not read again. Then it:
--
--   1. deletes every file that the database lists for a package outside that set, and the
--      documentation and source files of the packages inside it (files the database does not
--      list stay: the formats, the caches, the configuration);
--   2. removes the directories that this leaves empty and the links in bin/ that point nowhere;
--   3. writes the database of what is left over the original (so `tlmgr info --only-installed`
--      and the licence manifest list what the image holds), and to the licence directory the list
--      of kept packages, the reason each is kept, and the list of removed ones.
--
-- The roots are a list to be audited, not a guess: a package that is missing makes a compile in
-- the built image fail, and the compile tests of the export worker run against that image.

local root, rootsFile, licenceDir = arg[1], arg[2], arg[3]
assert(root and rootsFile and licenceDir, "usage: texlua curate.lua <root> <roots file> <licence dir>")
local lfs = require("lfs")
local ARCH = "x86_64-linux"

local dbPath = root .. "/tlpkg/texlive.tlpdb"
local f = assert(io.open(dbPath, "rb"))
local text = f:read("a")
f:close()

-- Parse the database: one stanza per package, fields one per line, file lists as indented lines.
local pkgs, order, config = {}, {}, {}
for stanza in (text .. "\n\n"):gmatch("(.-)\n%s*\n") do
  local p = { depends = {}, files = {}, raw = stanza }
  local list = nil
  for line in stanza:gmatch("[^\n]+") do
    if line:sub(1, 1) == " " then
      if list then
        local path = line:match("^%s*(%S+)")
        if path then p.files[#p.files + 1] = { path = path, kind = list } end
      end
    else
      list = nil
      local key, value = line:match("^(%S+)%s*(.*)$")
      if key == "name" then
        p.name = value
      elseif key == "execute" then
        if value:match("^AddHyphen") then p.hyphenation = true end
      elseif key == "depend" then
        p.depends[#p.depends + 1] = value
      elseif key == "runfiles" or key == "binfiles" or key == "docfiles" or key == "srcfiles" then
        list = key
      elseif key == "catalogue-license" then
        p.licence = value
      end
    end
  end
  if p.name then
    if p.name:sub(1, 9) == "00texlive" then
      config[#config + 1] = p
    else
      pkgs[p.name] = p
      order[#order + 1] = p.name
    end
  end
end

local function archName(n)
  return (n:gsub("%.ARCH$", "." .. ARCH))
end

-- The closure of the roots.
local keep, queue = {}, {}
local why = {}
local deny = {}
for line in io.lines(rootsFile) do
  local name = line:gsub("%s*#.*$", ""):match("^!(%S+)")
  if name then deny[name] = true end
end
local function want(n, reason)
  n = archName(n)
  if keep[n] or deny[n] then return end
  if not pkgs[n] then
    -- A dependency that is not a package of the database (for example a setting) is ignored.
    return
  end
  keep[n] = true
  why[n] = reason or "root"
  queue[#queue + 1] = n
end
for line in io.lines(rootsFile) do
  line = line:gsub("%s*#.*$", ""):gsub("^%s+", ""):gsub("%s+$", "")
  if line ~= "" and line:sub(1, 1) ~= "!" then
    local prefix = line:match("^(.-)%*$")
    if line == "@AddHyphen" then
      -- Every package that registers hyphenation patterns (`execute AddHyphen`): the engine reads
      -- the pattern file of the language a document names when it is first used.
      for _, n in ipairs(order) do
        if pkgs[n].hyphenation then want(n, "registers hyphenation patterns") end
      end
    elseif prefix then
      local any = false
      for _, n in ipairs(order) do
        if n:sub(1, #prefix) == prefix then want(n); any = true end
      end
      assert(any, "no package matches the root " .. line)
    else
      assert(pkgs[archName(line)], "the root " .. line .. " is not a package of the database")
      want(line)
    end
  end
end
-- The `depend` lines of the database are not complete: epstopdf-base.sty loads grfext, and the
-- package epstopdf-pkg does not depend on it. So the closure also follows what the files of the
-- kept packages load: `\RequirePackage`, `\usepackage` and `\LoadClass` in their .sty, .cls, .def,
-- .cfg, .ldf and .clo files, resolved through the names of the run files in the database. Comment
-- text is ignored. A name that no run file answers to (a kernel package, a macro argument) adds
-- nothing. The result is a superset of what a compile loads, which is the direction that matters.
local loaders = { sty = true, cls = true, ldf = true }
local index = {}
for _, n in ipairs(order) do
  for _, file in ipairs(pkgs[n].files) do
    if file.kind == "runfiles" then
      local name, ext = file.path:match("([^/]+%.(%a+))$")
      if name and (ext == "sty" or ext == "cls") then
        index[name] = index[name] or {}
        index[name][#index[name] + 1] = n
      end
    end
  end
end
local forms = {
  { "\\(RequirePackage%a*)%s*%b[]%s*{([^}]*)}", ".sty" },
  { "\\(RequirePackage%a*)%s*{([^}]*)}", ".sty" },
  { "\\(usepackage)%s*%b[]%s*{([^}]*)}", ".sty" },
  { "\\(usepackage)%s*{([^}]*)}", ".sty" },
  { "\\(LoadClass%a*)%s*%b[]%s*{([^}]*)}", ".cls" },
  { "\\(LoadClass%a*)%s*{([^}]*)}", ".cls" },
}
-- The owner of a file name: the package that is not a development copy (`latex-base-dev`).
local function owner(file)
  for _, p in ipairs(index[file] or {}) do
    if not p:find("%-dev$") then return p end
  end
  return nil
end
local function scan(n)
  for _, file in ipairs(pkgs[n].files) do
    local base, ext = file.path:match("([^/]+)%.(%a+)$")
    -- Files that document or test a package (`l3doc.cls`, `hypdoc.sty`) load what only a manual needs.
    if file.kind == "runfiles" and ext and loaders[ext] and not base:find("doc") then
      local h = io.open(root .. "/" .. file.path, "rb")
      if h then
        local body = h:read("a")
        h:close()
        body = body:gsub("\\%%", ""):gsub("%%[^\n]*", "")
        for _, form in ipairs(forms) do
          for _, names in body:gmatch(form[1]) do
            for name in names:gmatch("[^,%s]+") do
              if not name:find("[#\\{]") then
                local p = owner(name .. form[2])
                if p then want(p, "loaded by " .. n .. " (" .. name .. form[2] .. ")") end
              end
            end
          end
        end
      end
    end
  end
end

-- The closure follows the `depend` lines first. The files of those packages are then read once
-- for what they load, and what that adds is followed by `depend` lines again but not read: a
-- second round would pull in the optional parts of packages that only a manual or a rare option
-- needs (a PGF back end through a hook package, PSTricks through the examples of fancyvrb).
local function drain(from)
  local i = from
  while i <= #queue do
    for _, d in ipairs(pkgs[queue[i]].depends) do want(d, "needed by " .. queue[i]) end
    i = i + 1
  end
end
drain(1)
local first = #queue
for i = 1, first do scan(queue[i]) end
drain(first + 1)

-- Files to keep: run files and binaries of the kept packages. Files to delete: everything else
-- the database lists.
local kept = {}
for n in pairs(keep) do
  for _, file in ipairs(pkgs[n].files) do
    if file.kind == "runfiles" or file.kind == "binfiles" then kept[file.path] = true end
  end
end
local doomed, count = {}, 0
for _, n in ipairs(order) do
  for _, file in ipairs(pkgs[n].files) do
    if not kept[file.path] then
      doomed[file.path] = true
      count = count + 1
    end
  end
end

local function parent(path) return path:match("^(.*)/[^/]*$") end
local removedFiles, removedDirs = 0, 0
local dirs = {}
for path in pairs(doomed) do
  local full = root .. "/" .. path
  local attr = lfs.symlinkattributes(full)
  if attr and attr.mode ~= "directory" then
    assert(os.remove(full))
    removedFiles = removedFiles + 1
    local d = parent(path)
    while d and d ~= "" and not dirs[d] do
      dirs[d] = true
      d = parent(d)
    end
  end
end
-- Deepest directories first, so a parent is empty when its turn comes.
local dirList = {}
for d in pairs(dirs) do dirList[#dirList + 1] = d end
table.sort(dirList, function(a, b)
  if #a ~= #b then return #a > #b end
  return a < b
end)
for _, d in ipairs(dirList) do
  if lfs.rmdir(root .. "/" .. d) then removedDirs = removedDirs + 1 end
end

-- Links in bin/ whose target is gone.
local dangling = 0
local binDir = root .. "/bin/" .. ARCH
for name in lfs.dir(binDir) do
  if name ~= "." and name ~= ".." then
    local p = binDir .. "/" .. name
    local link = lfs.symlinkattributes(p)
    if link and link.mode == "link" and not lfs.attributes(p) then
      os.remove(p)
      dangling = dangling + 1
    end
  end
end

-- The database of what is left, and the lists.
local out = {}
for _, p in ipairs(config) do out[#out + 1] = p.raw end
local names = {}
for _, n in ipairs(order) do
  if keep[n] then
    out[#out + 1] = pkgs[n].raw
    names[#names + 1] = n
  end
end
local w = assert(io.open(dbPath, "wb"))
w:write(table.concat(out, "\n\n"), "\n")
w:close()

lfs.mkdir(licenceDir)
local function lines(file, list)
  local h = assert(io.open(licenceDir .. "/" .. file, "wb"))
  for _, n in ipairs(list) do h:write(n, "\n") end
  h:close()
end
lines("tex-packages-kept.txt", names)
local reasons = {}
for _, n in ipairs(names) do reasons[#reasons + 1] = n .. "	" .. why[n] end
lines("tex-packages-why.txt", reasons)
local gone = {}
for _, n in ipairs(order) do if not keep[n] then gone[#gone + 1] = n end end
lines("tex-packages-removed.txt", gone)
io.write(string.format(
  "curate: %d of %d packages kept; %d files and %d directories removed; %d dangling links removed\n",
  #names, #order, removedFiles, removedDirs, dangling))
