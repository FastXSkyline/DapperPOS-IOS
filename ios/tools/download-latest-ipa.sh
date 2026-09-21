#!/usr/bin/env bash
# Downloads the latest unsigned IPA release into ios/builds/
set -euo pipefail
REPO="FastXSkyline/DapperPOS-IOS"
OUT="$(cd "$(dirname "$0")/../builds" && pwd)"
mkdir -p "$OUT"
echo "Downloading latest IPA from $REPO ..."
curl -fL -o "$OUT/DapperPOS-unsigned.ipa" \
  "https://github.com/$REPO/releases/latest/download/DapperPOS-unsigned.ipa"
echo "Saved to $OUT/DapperPOS-unsigned.ipa"
