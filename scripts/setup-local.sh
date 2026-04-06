#!/bin/bash
# ══════════════════════════════════════════════════════════════
# KairoClaw — Bare Metal Setup
#
# Installs and configures KairoClaw to run directly on your
# machine (no Docker). The agent gets full access to your
# system — any command you can run, it can run.
#
# Usage:
#   ./scripts/setup-local.sh
#
# After setup, start with:
#   ./kairo
#
# Then configure credentials from the admin dashboard:
#   http://localhost:18181/admin/providers
#
# Data directory: ~/.agw
# ══════════════════════════════════════════════════════════════
set -e

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}[ok]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
err()   { echo -e "${RED}[error]${NC} $1"; }
step()  { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}"; }

# ── Resolve paths ───────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${AGW_STATE_DIR:-$HOME/.agw}"
CONFIG_FILE="$DATA_DIR/config.json"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     KairoClaw — Bare Metal Setup     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Project:   ${DIM}$PROJECT_DIR${NC}"
echo -e "  Data dir:  ${DIM}$DATA_DIR${NC}"
echo ""

# ── Check prerequisites ────────────────────────────────────
step "Checking prerequisites"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 18 ]; then
    err "Node.js 18+ required (found $NODE_VER)"
    exit 1
  fi
  ok "Node.js $NODE_VER"
else
  err "Node.js not found. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

# pnpm
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm -v)"
else
  warn "pnpm not found. Installing..."
  npm install -g pnpm@10
  ok "pnpm installed"
fi

# Report available CLI tools (the agent can use these via exec)
step "Available system tools"
for tool in git curl jq gh python3 docker pip npm; do
  if command -v "$tool" &>/dev/null; then
    ok "$tool"
  else
    info "$tool ${DIM}(not installed — agent won't have this)${NC}"
  fi
done

# ── Install dependencies ───────────────────────────────────
step "Installing dependencies"

cd "$PROJECT_DIR"
pnpm install
ok "Dependencies installed"

# ── Build ──────────────────────────────────────────────────
step "Building KairoClaw"

pnpm --filter @agw/types build
pnpm --filter @agw/core build
cp -r packages/core/src/db/migrations packages/core/dist/db/
pnpm --filter @agw/ui build
ok "Build complete"

# ── Create data directories ────────────────────────────────
step "Setting up data directory"

mkdir -p "$DATA_DIR/workspace/memory/sessions"
mkdir -p "$DATA_DIR/workspace/shared/documents"
mkdir -p "$DATA_DIR/workspace/shared/media"
mkdir -p "$DATA_DIR/logs"
ok "$DATA_DIR"

# Copy workspace defaults (first run only)
for f in IDENTITY.md SOUL.md RULES.md; do
  if [ ! -f "$DATA_DIR/workspace/$f" ]; then
    cp "$PROJECT_DIR/workspace-defaults/$f" "$DATA_DIR/workspace/$f"
    info "Created workspace/$f"
  fi
done

# ── Config file ─────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  step "Creating default config"

  cat > "$CONFIG_FILE" << CFGEOF
{
  "gateway": {
    "port": 18181,
    "host": "0.0.0.0",
    "token": "\${AGW_TOKEN}"
  },
  "providers": {
    "anthropic": {
      "apiKey": "\${ANTHROPIC_API_KEY}",
      "authToken": "\${ANTHROPIC_AUTH_TOKEN}",
      "baseUrl": "",
      "defaultModel": "claude-sonnet-4-20250514"
    },
    "openai": {
      "apiKey": "\${OPENAI_API_KEY}",
      "defaultModel": "gpt-4o"
    },
    "ollama": {
      "baseUrl": "\${OLLAMA_BASE_URL}",
      "defaultModel": "llama3"
    }
  },
  "model": {
    "primary": "anthropic/claude-sonnet-4-20250514",
    "fallback": ""
  },
  "channels": {
    "telegram": {
      "enabled": false,
      "botToken": "\${TELEGRAM_BOT_TOKEN}",
      "allowFrom": [],
      "groupsEnabled": false,
      "groupRequireMention": true,
      "groupAllowFrom": [],
      "groupRequireAllowFrom": true,
      "outboundPolicy": "session-only",
      "outboundAllowlist": []
    },
    "whatsapp": {
      "enabled": false,
      "allowFrom": [],
      "groupsEnabled": false,
      "groupRequireMention": true,
      "groupAllowFrom": [],
      "groupRequireAllowFrom": true,
      "sendReadReceipts": true,
      "outboundPolicy": "session-only",
      "outboundAllowlist": []
    }
  },
  "session": {
    "resetHour": 4,
    "idleMinutes": 0
  },
  "tools": {
    "exec": { "enabled": true, "timeout": 120 },
    "webSearch": { "enabled": false },
    "webFetch": { "enabled": true, "maxChars": 50000 },
    "email": { "enabled": false, "host": "", "port": 587, "secure": false, "from": "", "allowedDomains": [], "allowedRecipients": [], "maxRecipientsPerMessage": 5, "rateLimit": { "perMinute": 5, "perHour": 20, "perDay": 50, "perRecipientPerHour": 3 } },
    "transcription": { "enabled": false, "baseUrl": "", "model": "whisper-small", "language": "" },
    "browse": { "enabled": false, "remoteAccess": false }
  },
  "agent": {
    "name": "Kairo",
    "workspace": "$DATA_DIR/workspace",
    "maxToolRounds": 25,
    "compactionThreshold": 0.75,
    "softCompactionThreshold": 0.5,
    "keepRecentMessages": 10
  },
  "models": { "catalog": {} },
  "mcp": { "servers": {} }
}
CFGEOF

  ok "Config created at $CONFIG_FILE"
else
  info "Config already exists, skipping"
fi

# ── Create launcher script ──────────────────────────────────
step "Installing kairo command"

LAUNCHER="/usr/local/bin/kairo"
TEMP_LAUNCHER=$(mktemp)
cat > "$TEMP_LAUNCHER" << 'LAUNCHEOF'
#!/bin/bash
# ══════════════════════════════════════════════════════════════
# kairo — KairoClaw CLI
#
# Usage:
#   kairo                 Start the server (foreground)
#   kairo build           Rebuild after code changes
#   kairo start           Start via systemd (background)
#   kairo stop            Stop systemd service
#   kairo restart         Rebuild + restart systemd service
#   kairo logs            Tail systemd logs (Ctrl+C to stop)
#   kairo status          Check if running
#   kairo dev             Start in dev mode (watch for changes)
# ══════════════════════════════════════════════════════════════
set -e

LAUNCHEOF

# Inject paths (these are baked in at install time)
cat >> "$TEMP_LAUNCHER" << LAUNCHEOF
PROJECT_DIR="$PROJECT_DIR"
DATA_DIR="$DATA_DIR"
SERVICE="kairoclaw"

LAUNCHEOF

cat >> "$TEMP_LAUNCHER" << 'LAUNCHEOF'
export AGW_STATE_DIR="$DATA_DIR"
export AGW_CONFIG="$DATA_DIR/config.json"
export LOG_LEVEL="${LOG_LEVEL:-info}"

cd "$PROJECT_DIR"

CMD="${1:-run}"

case "$CMD" in

  run|"")
    echo "Starting KairoClaw..."
    echo "  http://localhost:18181"
    echo "  Ctrl+C to stop"
    echo ""
    exec node packages/core/dist/index.js
    ;;

  build)
    echo "Building KairoClaw..."
    pnpm --filter @agw/types build
    pnpm --filter @agw/core build
    cp -r packages/core/src/db/migrations packages/core/dist/db/
    pnpm --filter @agw/ui build
    echo "Build complete."
    ;;

  start)
    if [ ! -f "/etc/systemd/system/$SERVICE.service" ]; then
      echo "Systemd service not found. Run setup-local.sh to create it."
      echo "Or use: kairo  (runs in foreground)"
      exit 1
    fi
    sudo systemctl start "$SERVICE"
    echo "KairoClaw started (background)"
    echo "  http://localhost:18181"
    echo "  kairo logs    to see output"
    echo "  kairo stop    to stop"
    ;;

  stop)
    sudo systemctl stop "$SERVICE"
    echo "KairoClaw stopped."
    ;;

  restart)
    echo "Building..."
    pnpm --filter @agw/types build
    pnpm --filter @agw/core build
    cp -r packages/core/src/db/migrations packages/core/dist/db/
    pnpm --filter @agw/ui build
    echo ""
    sudo systemctl restart "$SERVICE"
    echo "KairoClaw rebuilt and restarted."
    echo "  kairo logs    to see output"
    ;;

  logs)
    journalctl -u "$SERVICE" -f --no-hostname -o cat
    ;;

  status)
    if systemctl is-active "$SERVICE" &>/dev/null 2>&1; then
      echo "KairoClaw is running (systemd)"
      systemctl status "$SERVICE" --no-pager -l 2>/dev/null | head -5
    elif pgrep -f "node.*packages/core/dist/index.js" &>/dev/null; then
      echo "KairoClaw is running (foreground)"
      PID=$(pgrep -f "node.*packages/core/dist/index.js")
      echo "  PID: $PID"
    else
      echo "KairoClaw is not running."
    fi
    if curl -sf http://localhost:18181/api/v1/health &>/dev/null; then
      echo "  Health: OK"
    else
      echo "  Health: not responding"
    fi
    ;;

  dev)
    echo "Starting KairoClaw in dev mode (watch)..."
    echo "  http://localhost:18181"
    echo "  Ctrl+C to stop"
    echo ""
    pnpm --filter @agw/types build
    AGW_STATE_DIR="$DATA_DIR" AGW_CONFIG="$DATA_DIR/config.json" pnpm --filter @agw/core dev
    ;;

  *)
    echo "kairo — KairoClaw CLI"
    echo ""
    echo "Usage: kairo [command]"
    echo ""
    echo "Commands:"
    echo "  (none)     Start in foreground"
    echo "  build      Rebuild after code changes"
    echo "  start      Start via systemd (background)"
    echo "  stop       Stop systemd service"
    echo "  restart    Rebuild + restart systemd"
    echo "  logs       Tail logs (Ctrl+C to stop)"
    echo "  status     Check if running"
    echo "  dev        Start in dev mode (watch for changes)"
    echo ""
    echo "Data:    $DATA_DIR"
    echo "Config:  $DATA_DIR/config.json"
    echo "Project: $PROJECT_DIR"
    ;;

esac
LAUNCHEOF

sudo install -m 755 "$TEMP_LAUNCHER" "$LAUNCHER"
rm -f "$TEMP_LAUNCHER"
# Also keep a copy in the project root for convenience
cp "$LAUNCHER" "$PROJECT_DIR/kairo" 2>/dev/null || true
ok "kairo installed to $LAUNCHER"
info "You can now run 'kairo' from anywhere"

# ── Optional: systemd service ───────────────────────────────
SERVICE="kairoclaw"
if command -v systemctl &>/dev/null; then
  echo ""
  read -rp "  Create systemd service for auto-start? [y/N]: " CREATE_SERVICE
  if [[ "$CREATE_SERVICE" =~ ^[Yy] ]]; then
    SERVICE_FILE="/etc/systemd/system/kairoclaw.service"
    sudo tee "$SERVICE_FILE" > /dev/null << SVCEOF
[Unit]
Description=KairoClaw AI Agent
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_DIR
Environment=AGW_STATE_DIR=$DATA_DIR
Environment=AGW_CONFIG=$CONFIG_FILE
Environment=LOG_LEVEL=info
Environment=NODE_ENV=production
ExecStart=$(which node) packages/core/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE"
    sudo systemctl start "$SERVICE"
    ok "Service installed, enabled, and started"
    info "  kairo status    check health"
    info "  kairo logs      tail logs"
    info "  kairo stop      stop service"
  fi
fi

# ── Done ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Setup complete!${NC}"
echo ""
echo -e "  ${BOLD}Start:${NC}  kairo"
echo -e "  ${BOLD}Admin:${NC}  http://localhost:18181"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo -e "    ${CYAN}kairo${NC}           Start the server"
echo -e "    ${CYAN}kairo build${NC}     Rebuild after code changes"
echo -e "    ${CYAN}kairo start${NC}     Start via systemd (background)"
echo -e "    ${CYAN}kairo stop${NC}      Stop systemd service"
echo -e "    ${CYAN}kairo restart${NC}   Rebuild + restart"
echo -e "    ${CYAN}kairo logs${NC}      Tail logs"
echo -e "    ${CYAN}kairo status${NC}    Check health"
echo -e "    ${CYAN}kairo dev${NC}       Dev mode (watch for changes)"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "  1. Run ${CYAN}kairo${NC}"
echo -e "  2. Open ${CYAN}http://localhost:18181/admin/providers${NC}"
echo -e "  3. Configure your Anthropic API key or auth token"
echo -e "  4. Start chatting!"
echo ""
