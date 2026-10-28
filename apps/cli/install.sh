#!/bin/sh
# Bootstrap requires no Node/npm. Runtime is private; project PATH stays unchanged.
set -eu
umask 077
# Standalone downloaded bootstraps can run before the packaged helpers exist.
gt_cli_print() { shift 2; printf '%s\n' "$@"; }
LOCAL_ROOT=''
if [ -f "$0" ]; then
  HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$HERE/scripts/installation/install.cjs" ]; then LOCAL_ROOT=$HERE; fi
  if [ -f "$HERE/scripts/installation/output.sh" ]; then . "$HERE/scripts/installation/output.sh"; fi
fi
NON_INTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1;;
    -h|--help)
    gt_cli_print 1 cyan 'install.sh [--package FILE.tgz] [--source PATH] [--non-interactive] [--skip-auth]'
    printf '%s\n' 'Installs private Node/SQLite, CLI dependencies, and the gt-cli management command.'
    gt_cli_print 1 cyan 'Then: gt-cli enable [--repo PATH | --global]' \
      '      gt-cli disable [--repo PATH | --global]'
    printf '%s\n' 'Requires Git and macOS/Linux; npm/GitHub authentication may prompt.'
    exit 0;;
  esac
done
HOME_DIR=${GT_CLI_HOME:-"$HOME/.local/share/gt-cli"}
case "$HOME_DIR" in /*) ;; *) gt_cli_print 2 red 'GT_CLI_HOME must be absolute.' >&2; exit 1;; esac
case "$HOME_DIR" in *'
'*) gt_cli_print 2 red 'Installation paths cannot contain newlines.' >&2; exit 1;; esac
if [ -L "$HOME_DIR" ] || [ -L "$HOME_DIR/versions" ]; then
  gt_cli_print 2 red 'Refusing a symlinked installation directory.' >&2; exit 1
fi
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) PLATFORM=darwin; ARCH=arm64; SHA=8c039d59f2fec6195e4281ad5b0d02b9a940897b4df7b849c6fb48be6787bba6;;
  Darwin:x86_64) PLATFORM=darwin; ARCH=x64; SHA=527f0578d9812e7dfa225121bda0b1546a6a0e4b5f556295fc8299c272de5fbf;;
  Linux:aarch64|Linux:arm64) PLATFORM=linux; ARCH=arm64; SHA=4873459d7c9b28feaa1f0fade9bb9c81cb702670991ff80a51d805325c5e3456;;
  Linux:x86_64) PLATFORM=linux; ARCH=x64; SHA=7ad28fb172a9ab0593f86c1a39e5c268d0d8fc3d6cb0167f455b5655a7a6e2fd;;
  *) gt_cli_print 2 red 'Supported platforms: macOS/Linux, x64/arm64. Linux requires glibc.' >&2; exit 1;;
esac
mkdir -p "$HOME_DIR/versions" "$HOME_DIR/cache"
if [ "$PLATFORM" = darwin ]; then OWNER=$(stat -f '%u' "$HOME_DIR"); else OWNER=$(stat -c '%u' "$HOME_DIR"); fi
if [ "$OWNER" != "$(id -u)" ]; then gt_cli_print 2 red 'Installation directory belongs to another OS user.' >&2; exit 1; fi
chmod 700 "$HOME_DIR" "$HOME_DIR/versions"
RELEASE=$(mktemp -d "$HOME_DIR/versions/.install-XXXXXXXX")
cleanup() {
  if [ ! -f "$RELEASE/.installed" ]; then rm -rf -- "$RELEASE"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
VERSION=24.13.1
ARCHIVE="node-v$VERSION-$PLATFORM-$ARCH.tar.gz"
checksum() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else gt_cli_print 2 red 'A SHA-256 utility (shasum or sha256sum) is required.' >&2; return 1; fi
}
CACHE="$HOME_DIR/cache/$ARCHIVE"
if [ -L "$HOME_DIR/cache" ] || [ -L "$CACHE" ]; then gt_cli_print 2 red 'Refusing symlinked runtime cache.' >&2; exit 1; fi
if [ -f "$CACHE" ] && [ "$(checksum "$CACHE")" = "$SHA" ]; then
  cp "$CACHE" "$RELEASE/node.tar.gz"
else
  gt_cli_print 1 cyan "Installing private Node $VERSION ($PLATFORM-$ARCH)..."
  URL="https://nodejs.org/dist/v$VERSION/$ARCHIVE"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 300 --retry 3 "$URL" --output "$RELEASE/node.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --secure-protocol=TLSv1_2 --timeout=60 --tries=3 -q -O "$RELEASE/node.tar.gz" "$URL"
  else gt_cli_print 2 red 'Install requires curl or wget for HTTPS downloads.' >&2; exit 1; fi
fi
if [ "$(checksum "$RELEASE/node.tar.gz")" != "$SHA" ]; then
  gt_cli_print 2 red 'Node archive checksum mismatch. Nothing was activated.' >&2; exit 1
fi
# Exclusive cache publication; never overwrite another install or unknown cache.
ln "$RELEASE/node.tar.gz" "$CACHE" 2>/dev/null || :
tar -xzf "$RELEASE/node.tar.gz" -C "$RELEASE"
mv "$RELEASE/node-v$VERSION-$PLATFORM-$ARCH" "$RELEASE/runtime"
rm "$RELEASE/node.tar.gz"
NODE="$RELEASE/runtime/bin/node"
if [ "$("$NODE" --version)" != "v$VERSION" ]; then gt_cli_print 2 red 'Private Node validation failed.' >&2; exit 1; fi
if [ -z "$LOCAL_ROOT" ]; then
  # Downloaded standalone bootstrap: authenticate within this install command.
  NPM="$RELEASE/runtime/lib/node_modules/npm/bin/npm-cli.js"
  npm_config_update_notifier=false
  export npm_config_update_notifier
  if ! "$NODE" "$NPM" whoami --registry=https://registry.npmjs.org/ >/dev/null 2>&1; then
    if [ "$NON_INTERACTIVE" = 1 ] || ! ( : </dev/tty ) 2>/dev/null; then
      gt_cli_print 2 red 'Restricted package requires npm credentials; supply npm user config for non-interactive installation.' >&2; exit 1
    fi
    "$NODE" "$NPM" login --registry=https://registry.npmjs.org/ </dev/tty
  fi
  PATH="$RELEASE/runtime/bin:$PATH" "$NODE" "$NPM" install --prefix "$RELEASE/bootstrap" --ignore-scripts --no-audit --no-fund \
    --registry=https://registry.npmjs.org/ @tianrendong/gt-cli@0.6.1
  LOCAL_ROOT="$RELEASE/bootstrap/node_modules/@tianrendong/gt-cli"
fi
"$NODE" "$LOCAL_ROOT/scripts/installation/install.cjs" --release "$RELEASE" --cli-root "$LOCAL_ROOT" "$@"
