#!/bin/bash
# Development mode — watch for changes and auto-restart
set -e
cd "$(dirname "$0")/.."

# Build types first (core depends on them)
echo "Building @agw/types..."
pnpm --filter @agw/types build

echo "Starting core in watch mode..."
AGW_STATE_DIR=./agw-data AGW_CONFIG=./agw-data/config.json pnpm --filter @agw/core dev
