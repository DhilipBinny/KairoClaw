#!/bin/bash
# Development mode — watch for changes and auto-restart
set -e
cd "$(dirname "$0")/.."

echo "Building packages..."
pnpm -r build

echo "Starting core in watch mode..."
AGW_STATE_DIR=./agw-data AGW_CONFIG=./agw-data/config.json pnpm --filter @agw/core dev
