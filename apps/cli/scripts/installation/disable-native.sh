#!/bin/sh
# Last-resort exit when no Node runtime can run. No JSON or migration dependency.
set -eu
DRY=false
JSON=false
SLOT=''
GLOBAL=false
REPO=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      printf '%s\n' 'gt-cli disable [--repo PATH | --global] [--dry-run] [--json]' 'Return to native Graphite. Without Node, restore native routing globally and retain all recovery data.'
      exit 0 ;;
    --dry-run) DRY=true ;;
    --json) JSON=true ;;
    --global) GLOBAL=true ;;
    --repo|--cwd|--gt-path)
      KEY=$1; shift
      if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '%s\n' "Missing value for $KEY." >&2; exit 1; fi
      case "$1" in --*) printf '%s\n' "Missing value for $KEY." >&2; exit 1;; esac
      if [ "$KEY" = --gt-path ]; then SLOT=$1; else REPO=$1; fi ;;
    --repo=*|--cwd=*) REPO=${1#*=} ;;
    --gt-path=*) SLOT=${1#*=} ;;
    --no-interactive) : ;;
    *) printf '%s\n' "Unsupported switch argument $1 without a working Node runtime." >&2; exit 1 ;;
  esac
  shift
done
if [ "$GLOBAL" = true ] && [ -n "$REPO" ]; then
  printf '%s\n' 'Do not combine --global with --repo or --cwd.' >&2; exit 1
fi
SELECTED=''
OLD_IFS=$IFS
IFS=:
set -f
for DIRECTORY in $PATH; do
  if [ -x "${DIRECTORY:-.}/gt" ] || [ -L "${DIRECTORY:-.}/gt" ]; then
    SELECTED="$(CDPATH= cd -P -- "${DIRECTORY:-.}" && pwd)/gt"
    break
  fi
done
set +f
IFS=$OLD_IFS
if [ -z "$SELECTED" ]; then printf '%s\n' 'No gt on PATH. Install native Graphite, then retry disable.' >&2; exit 1; fi
if [ -n "$SLOT" ] && [ "$SLOT" != "$SELECTED" ]; then
  printf '%s\n' '--gt-path must name the gt entry currently selected by PATH.' >&2; exit 1
fi
SLOT=$SELECTED
if [ "$(ls -nd "$SLOT" | awk '{print $3}')" != "$(/usr/bin/id -u)" ]; then
  printf '%s\n' 'Refusing to replace a gt entry owned by another OS user. Use a user-owned native Graphite installation.' >&2; exit 1
fi
replace_entry() {
  # Unlike plain mv, never follow a destination symlink to a directory.
  if [ "$(uname -s)" = Darwin ]; then /bin/mv -fh "$1" "$2"; else /bin/mv -fT "$1" "$2"; fi
}
ROUTER=$(readlink "$SLOT" || true)
case "$ROUTER" in
  "$(dirname "$SLOT")"/.gt-gh-router-*) : ;;
  *)
    if GT_GH_PROBING_NATIVE=1 "$SLOT" --version 2>/dev/null | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; then
      if [ "$JSON" = true ]; then
        printf '%s\n' '{"mode":"graphite","already":true,"handoff":"incomplete","warnings":["No Node runtime available to verify metadata handoff. Inspect native stacks before changing them; recovery data was retained."]}'
      else
        printf '%s\n' 'gt already uses native Graphite.'
        printf '%s\n' 'WARNING: No Node runtime available to verify metadata handoff. Inspect native stacks before changing them; recovery data was retained.' >&2
      fi
      exit 0
    fi
    printf '%s\n' 'No usable native gt found. Install native Graphite and retry disable.' >&2
    exit 1 ;;
esac
NATIVE=$(readlink "$ROUTER.native" || true)
if [ -z "$NATIVE" ] || [ ! -x "$NATIVE" ] || ! GT_GH_PROBING_NATIVE=1 "$NATIVE" --version 2>/dev/null | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; then
  printf '%s\n' 'Native recovery executable unavailable. Install native Graphite or restore Node and retry disable. Existing recovery data was kept.' >&2
  exit 1
fi
if [ "$DRY" = false ]; then
  # The guard also protects against an older in-flight command reinstalling this
  # dispatcher. Never edit repository state or blindly replay a pending export.
  TMP=$(mktemp "$ROUTER.disabled.XXXXXX")
  printf '%s\n' 'Native escape: Node runtime unavailable. Metadata handoff incomplete.' > "$TMP"
  if ! replace_entry "$TMP" "$ROUTER.disabled"; then
    rm -f "$TMP"
    printf '%s\n' 'WARNING: Could not save native-only guard. Stop other gt-cli management commands before using native Graphite.' >&2
  fi
  TMP=$(mktemp "$SLOT.native.XXXXXX")
  trap 'rm -f "$TMP"' EXIT HUP INT TERM
  rm -f "$TMP"
  ln -s "$NATIVE" "$TMP"
  if [ "$(readlink "$SLOT")" != "$ROUTER" ]; then
    printf '%s\n' 'gt changed concurrently. Retry disable; no newer executable was overwritten.' >&2; exit 1
  fi
  replace_entry "$TMP" "$SLOT"
  trap - EXIT HUP INT TERM
fi
if [ "$JSON" = true ]; then
  printf '{"mode":"graphite","scope":"global","handoff":"incomplete","dryRun":%s,"warnings":["Node runtime unavailable; native routing restored globally without metadata migration. Keep recovery data and inspect stacks before mutating them."]}\n' "$DRY"
else
  if [ "$DRY" = true ]; then printf '%s\n' 'Preview: would restore native Graphite globally.'; else printf '%s\n' 'gt now uses native Graphite globally.'; fi
  printf '%s\n' 'WARNING: Node runtime unavailable. Metadata was not migrated; recovery data was retained. Stop running gt-cli commands, keep old installations/journals, and inspect native stacks with gt log before restack or submit.' >&2
fi
