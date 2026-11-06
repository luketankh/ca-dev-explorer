#!/usr/bin/env bash
# Download the pre-built map data (PMTiles + GeoJSON, ~85 MB) from the GitHub release into
# web/public/data, so the app runs without re-running the ~1 GB data pipeline.
# Needs the GitHub CLI (https://cli.github.com) logged in with access to this repo: `gh auth login`.
set -euo pipefail
cd "$(dirname "$0")"
TAG="${1:-data-v1}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download "$TAG" --pattern "map-data.zip" --dir "$tmp"
mkdir -p web/public/data
unzip -o -q "$tmp/map-data.zip" -d web/public/data
echo "Map data ($TAG) installed in web/public/data"
