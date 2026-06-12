#!/bin/sh
# Docker entrypoint — setup data directories then start
set -e

DATA_DIR="${AGW_STATE_DIR:-/data}"

# Ensure data directories exist and are owned by node (handles bind-mounted volumes)
mkdir -p "$DATA_DIR/workspace/memory" "$DATA_DIR/workspace/shared/documents" "$DATA_DIR/workspace/shared/media" "$DATA_DIR/logs"
chown -R node:node "$DATA_DIR"

# Ensure Claude CLI config directory exists for SDK/CLI mode
mkdir -p /home/node/.claude
chown -R node:node /home/node/.claude /home/node/.claude.json 2>/dev/null || true

# Copy workspace defaults if first run
for f in IDENTITY.md SOUL.md RULES.md; do
  if [ ! -f "$DATA_DIR/workspace/$f" ] && [ -f "/app/workspace-defaults/$f" ]; then
    cp "/app/workspace-defaults/$f" "$DATA_DIR/workspace/$f"
  fi
done

# Docker socket access for sandbox_exec (fallback if group_add not set in compose)
# The preferred method is group_add in docker-compose.yml — this is a safety net.
# See docs/SANDBOX.md for setup instructions.
if [ "$(id -u)" = "0" ] && [ -S /var/run/docker.sock ]; then
  if ! gosu node test -r /var/run/docker.sock -a -w /var/run/docker.sock 2>/dev/null; then
    DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
    if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
      groupadd -g "$DOCKER_GID" dockerhost 2>/dev/null || true
    fi
    GROUP_NAME=$(getent group "$DOCKER_GID" | cut -d: -f1)
    usermod -aG "$GROUP_NAME" node 2>/dev/null || true
  fi
fi

echo "Starting AGW..."
if [ -f /app/dist/index.js ]; then
  exec gosu node node /app/dist/index.js
else
  exec gosu node node /app/packages/core/dist/index.js
fi
