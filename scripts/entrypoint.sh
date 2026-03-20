#!/bin/sh
# Docker entrypoint — setup data directories then start
set -e

DATA_DIR="${AGW_STATE_DIR:-/data}"

# Ensure data directories exist
mkdir -p "$DATA_DIR/workspace/memory" "$DATA_DIR/logs"

# Copy workspace defaults if first run
for f in AGENTS.md SOUL.md USER.md IDENTITY.md MEMORY.md; do
  if [ ! -f "$DATA_DIR/workspace/$f" ] && [ -f "/app/workspace-defaults/$f" ]; then
    cp "/app/workspace-defaults/$f" "$DATA_DIR/workspace/$f"
  fi
done

echo "Starting AGW..."
exec node /app/packages/core/dist/index.js
