#!/bin/bash
# Build all packages in dependency order
set -e
cd "$(dirname "$0")/.."

echo "Building all packages..."
pnpm -r build

echo "Building UI..."
pnpm --filter @agw/ui build

echo "Build complete."
