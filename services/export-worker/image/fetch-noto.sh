#!/bin/sh
# Fetches the Noto faces named in noto-fonts.tsv (EXP-037, EXP-025), checks every file against the
# SHA-256 pinned there, and writes them to <out>, with their licence texts in <out>/licences and the
# order of the fallback chain in <out>/fallback.txt (name, file, licence; tab separated), which
# fonts.lua reads. Used by the Containerfile; needs curl, unzip and sha256sum. A download or a hash
# that is not the pinned one stops the build. Usage: fetch-noto.sh <noto-fonts.tsv> <out>
set -eu

list=$1
out=$2
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tab=$(printf '\t')
mkdir -p "$out/licences"
: > "$out/fallback.txt"

get() {
  curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"
}

check() {
  printf '%s  %s\n' "$1" "$2" | sha256sum -c - > /dev/null || {
    echo "fetch-noto.sh: $2 is not the pinned file" >&2
    exit 1
  }
}

while IFS="$tab" read -r name version url dsha member face fsha licence lsrc lsha; do
  case "$name" in '' | '#'*) continue ;; esac
  get "$url" "$tmp/download"
  check "$dsha" "$tmp/download"
  if [ "$member" = "-" ]; then
    cp "$tmp/download" "$out/$face"
  else
    unzip -p "$tmp/download" "$member" > "$out/$face"
  fi
  check "$fsha" "$out/$face"
  case "$lsrc" in
    https://*) get "$lsrc" "$out/licences/$face.OFL.txt" ;;
    *) unzip -p "$tmp/download" "$lsrc" > "$out/licences/$face.OFL.txt" ;;
  esac
  check "$lsha" "$out/licences/$face.OFL.txt"
  printf '%s\t%s\t%s\n' "$name" "$face" "$licence" >> "$out/fallback.txt"
  echo "fetch-noto.sh: $name $version" >&2
done < "$list"