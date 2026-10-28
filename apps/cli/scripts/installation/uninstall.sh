#!/bin/sh
set -eu
if [ -e "${GT_CLI_HOME:-$HOME/.local/share/gt-cli}/current" ]; then
  printf '%s\n' 'Managed installations may contain the preserved native binary. Use gt-cli disable --global to switch back; this legacy uninstall helper will not delete versioned installations.' >&2
  exit 1
fi
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/gt-gh/launchers"
node - "$STATE" <<'NODE'
const fs = require('fs'), path = require('path');
const root = process.argv[2];
if (fs.existsSync(root)) for (const entry of fs.readdirSync(root)) {
  const file = path.join(root, entry, 'launcher.json');
  if (!fs.existsSync(file)) continue;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (![1, 2].includes(state.schemaVersion) || state.defaultMode === 'gt-gh' || state.phase !== 'restored' || !Array.isArray(state.repositories) || state.repositories.length) {
    console.error('Run disable.sh --global and disable.sh for every registered repository before uninstalling. Native gt was not changed.');
    process.exit(1);
  }
}
NODE
npm uninstall --prefix "$HOME/.local/share/gt-cli" @tianrendong/gt-cli
# Keep manifests and native backups as recovery evidence; never delete lock files.
