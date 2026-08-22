#!/usr/bin/env bash
# Launch one already-built immutable Feather release.
set -euo pipefail

cd "$(dirname "$0")"
[ -d node_modules ] || { echo 'Feather release is missing node_modules; stage it again.' >&2; exit 1; }
[ -d static/assets ] || { echo 'Feather release is missing static assets; stage it again.' >&2; exit 1; }
exec node server-single.js
