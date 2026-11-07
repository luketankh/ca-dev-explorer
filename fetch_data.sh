#!/usr/bin/env bash
# Download the pre-built map data (PMTiles + GeoJSON, ~95 MB) from the GitHub release into
# web/public/data, so the app runs without re-running the ~1 GB data pipeline.
# Usage: ./fetch_data.sh [release-tag]   (default: data-v6)
set -euo pipefail
cd "$(dirname "$0")"
TAG="${1:-data-v6}"
URL="https://github.com/luketankh/ca-dev-explorer/releases/download/${TAG}/map-data.zip"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading map data ($TAG, ~95 MB) ..."
curl -fL --progress-bar -o "$tmp/map-data.zip" "$URL"
mkdir -p web/public/data
unzip -o -q "$tmp/map-data.zip" -d web/public/data
echo "Map data ($TAG) installed in web/public/data"
