#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
npm run prepack
printf '\nBuilt gt. Native installation was not changed.\nRun: %s/enable.sh --repo /path/to/repository --dry-run\n' "$ROOT"
