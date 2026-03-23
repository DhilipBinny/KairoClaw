#!/bin/bash
# Build all packages (types → core → UI)
set -e
cd "$(dirname "$0")/.."

echo "Building @agw/types..."
pnpm --filter @agw/types build

echo "Building @agw/core..."
pnpm --filter @agw/core build

echo "Copying migrations..."
cp -r packages/core/src/db/migrations packages/core/dist/db/

echo "Building @agw/ui..."
pnpm --filter @agw/ui build

echo "Build complete."
