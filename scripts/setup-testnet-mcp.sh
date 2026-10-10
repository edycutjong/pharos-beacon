#!/usr/bin/env bash
# The hosted Chain MCP (mcp.pharos.xyz) serves mainnet only. For Atlantic testnet we run the same
# sponsor server (PharosNetwork/pharos-mcp, pinned commit) locally over stdio, pointed at the testnet RPC.
set -euo pipefail
COMMIT=9a3750ca2747cdd3c88b21c6c53ea7c1d66e0cbb
DIR="$(cd "$(dirname "$0")/.." && pwd)/.cache/pharos-mcp"
if [ -f "$DIR/dist/src/index.js" ] && [ "$(cat "$DIR/.commit" 2>/dev/null)" = "$COMMIT" ]; then
  echo "pharos-mcp $COMMIT already built at $DIR"; exit 0
fi
rm -rf "$DIR" && mkdir -p "$DIR"
git -C "$DIR" init -q
git -C "$DIR" fetch -q --depth 1 https://github.com/PharosNetwork/pharos-mcp "$COMMIT"
git -C "$DIR" checkout -q FETCH_HEAD
rm -rf "$DIR/.git" && echo "$COMMIT" > "$DIR/.commit"
(cd "$DIR" && npm ci --silent && npm run build --silent)
echo "built pharos-mcp $COMMIT at $DIR"
