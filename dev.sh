#!/usr/bin/env bash
# Start the web app at http://localhost:5173 (uses the project-local Node in .tools/ if present).
set -euo pipefail
cd "$(dirname "$0")/web"
[ -d ../.tools/node/bin ] && export PATH="$PWD/../.tools/node/bin:$PATH"
[ -d node_modules ] || npm install
npm run dev
