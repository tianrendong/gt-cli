#!/bin/sh
set -eu
ROOT=$1
. "$ROOT/scripts/installation/output.sh"
KIND=$2
shift 2
CURRENT="${GT_CLI_HOME:-$HOME/.local/share/gt-cli}/current/app/node_modules/@tianrendong/gt-cli"
if [ "$KIND" = disable ]; then
  # Escape cannot depend on a healthy private runtime, compiled CLI, or SQLite.
  # Ambient Node is permitted only for this dependency-free rescue command.
  for NODE in "$ROOT/.runtime-node" "$CURRENT/.runtime-node" "${GT_NODE_BIN:-node}" node; do
    if "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
      exec "$NODE" "$ROOT/scripts/installation/disable.cjs" "$@"
    fi
  done
  exec /bin/sh "$ROOT/scripts/installation/disable-native.sh" "$@"
fi
if [ -L "$ROOT/.runtime-node" ]; then
  if [ ! -x "$ROOT/.runtime-node" ]; then
    gt_cli_print 2 red 'Installed runtime is missing. Rerun npm bootstrap; do not remove an active installation.' >&2
    exit 1
  fi
  if [ -d "$ROOT/.tools-bin" ]; then PATH="$PATH:$ROOT/.tools-bin"; export PATH; fi
  if [ "$KIND" = update ]; then
    exec "$ROOT/.runtime-node" "$ROOT/scripts/installation/update.cjs" "$@"
  fi
  if [ "$KIND" = config ] || [ "$KIND" = graphite ]; then
    exec "$ROOT/.runtime-node" "$ROOT/dist/src/settings_cli.js" "$KIND" "$@"
  fi
  exec "$ROOT/.runtime-node" "$ROOT/dist/src/toggle_cli.js" "$KIND" "$@"
fi
if [ -x "$CURRENT/.runtime-node" ]; then
  exec "$CURRENT/bin/gt-cli" "$KIND" "$@"
fi
# Source development keeps an explicit escape hatch; normal installs never use
# ambient Node or GT_NODE_BIN, and never require environment changes.
if [ "$KIND" != update ] && [ "$KIND" != config ] && [ "$KIND" != graphite ] && [ -f "$ROOT/../../.yarn/releases/yarn-3.2.1.cjs" ] && [ -f "$ROOT/dist/src/toggle_cli.js" ]; then
  exec "${GT_NODE_BIN:-node}" "$ROOT/dist/src/toggle_cli.js" "$KIND" "$@"
fi
gt_cli_print 2 red 'gt-cli is not installed. Run npx @tianrendong/gt-cli install first.' >&2
exit 1
