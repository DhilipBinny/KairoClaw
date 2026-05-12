#!/bin/bash
# Build & start in foreground (production mode)
set -e
cd "$(dirname "$0")/.."

echo "Building all packages..."
pnpm -r build
pnpm --filter @agw/ui build

echo ""
echo "Starting KairoClaw..."
echo "  http://localhost:18181"
echo "  Ctrl+C to stop"
echo ""

NODE_ENV=production AGW_STATE_DIR=./agw-data AGW_CONFIG=./agw-data/config.json exec node packages/core/dist/index.js
