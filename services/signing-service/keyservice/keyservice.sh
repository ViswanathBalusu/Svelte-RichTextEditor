#!/bin/sh
# The key service emulator (spike S8). Commands:
#   serve    make a token and a key, then wait (the container's main process)
#   pubkey   write the DER SubjectPublicKeyInfo of the signing key to standard output
#   sign     read a DER DigestInfo from standard input, write the RSA PKCS#1 v1.5 signature
#   info     list the private key's attributes (shows sensitive and never extractable)
#   extract  try to read the private key's value (must fail: the key is not extractable)
set -eu
MODULE=/usr/lib/softhsm/libsofthsm2.so
RUN=/run/keyservice
LABEL=seal
KEYID=01
pin() { cat "$RUN/pin"; }
case "${1:-}" in
serve)
  umask 077
  mkdir -p "$RUN" /var/lib/softhsm/tokens
  # Random PINs for this container only. Only this script's other commands, run inside the
  # container, read them.
  head -c 12 /dev/urandom | od -An -tx1 | tr -d ' ' | tr -d '\n' > "$RUN/pin"
  head -c 12 /dev/urandom | od -An -tx1 | tr -d ' ' | tr -d '\n' > "$RUN/sopin"
  softhsm2-util --init-token --free --label "$LABEL" --pin "$(pin)" --so-pin "$(cat "$RUN/sopin")" >/dev/null
  pkcs11-tool --module "$MODULE" --token-label "$LABEL" --login --pin "$(pin)" \
    --keypairgen --key-type rsa:3072 --id "$KEYID" --label seal-key >/dev/null
  echo ready
  exec tail -f /dev/null
  ;;
pubkey)
  pkcs11-tool --module "$MODULE" --token-label "$LABEL" --read-object --type pubkey --id "$KEYID" 2>/dev/null
  ;;
sign)
  umask 077
  cat > "$RUN/in.$$"
  pkcs11-tool --module "$MODULE" --token-label "$LABEL" --login --pin "$(pin)" \
    --sign --mechanism RSA-PKCS --id "$KEYID" --input-file "$RUN/in.$$" --output-file "$RUN/out.$$" >/dev/null 2>&1
  cat "$RUN/out.$$"
  rm -f "$RUN/in.$$" "$RUN/out.$$"
  ;;
info)
  pkcs11-tool --module "$MODULE" --token-label "$LABEL" --login --pin "$(pin)" --list-objects --type privkey 2>&1
  ;;
extract)
  # A non-extractable private key has no readable value. Any output of LEAKED is a test failure.
  pkcs11-tool --module "$MODULE" --token-label "$LABEL" --login --pin "$(pin)" \
    --read-object --type privkey --id "$KEYID" --output-file "$RUN/leak.$$" 2>&1 || true
  if [ -s "$RUN/leak.$$" ]; then echo "LEAKED"; fi
  rm -f "$RUN/leak.$$"
  ;;
*)
  echo "usage: keyservice.sh serve|pubkey|sign|info|extract" >&2
  exit 2
  ;;
esac
