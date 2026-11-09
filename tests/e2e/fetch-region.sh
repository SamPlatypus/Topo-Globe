#!/usr/bin/env bash
# Download a region file from the release, waiting (up to 75 min) while the Regions workflow builds it.
set -euo pipefail
TAG="$1"; FILE="$2"; DIR="$3"
mkdir -p "$DIR"
for i in $(seq 1 75); do
  if gh release download "$TAG" -p "$FILE" -D "$DIR" --clobber 2>/dev/null; then
    ls -la "$DIR/$FILE"
    exit 0
  fi
  echo "Waiting for $FILE on release $TAG ($i/75)…"
  sleep 60
done
echo "::error::$FILE is not on release $TAG"
exit 1
