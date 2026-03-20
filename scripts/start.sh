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
mkdir -p packages/core/dist/db/migrations
cp packages/core/src/db/migrations/*.sql packages/core/dist/db/migrations/

echo "🎨 Building @agw/ui..."
pnpm --filter @agw/ui build

echo ""
echo "🚀 Starting AGW v2..."
echo "   http://localhost:18181"
echo "   Ctrl+C to stop"
echo ""

AGW_STATE_DIR=./agw-data AGW_CONFIG=./agw-data/config.json exec node packages/core/dist/index.js
