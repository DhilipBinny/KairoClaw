#!/bin/bash
# ══════════════════════════════════════════════
# AGW v2 — Build & Start (foreground)
# ══════════════════════════════════════════════
set -e

cd "$(dirname "$0")/.."

echo "🔨 Building @agw/types..."
pnpm --filter @agw/types build

echo "🔨 Building @agw/core..."
pnpm --filter @agw/core build

echo "📋 Copying migrations..."
cp -r packages/core/src/db/migrations packages/core/dist/db/

echo "🎨 Building @agw/ui..."
pnpm --filter @agw/ui build

echo ""
echo "🚀 Starting AGW v2..."
echo "   http://localhost:18181"
echo "   Ctrl+C to stop"
echo ""

AGW_STATE_DIR=./local_data/agw-data AGW_CONFIG=./local_data/agw-data/config.json exec node packages/core/dist/index.js
