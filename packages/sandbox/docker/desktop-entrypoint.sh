#!/usr/bin/env bash
set -euo pipefail

# ── KairoClaw Desktop Sandbox Entrypoint ─────────────────
#
# Starts: Xvfb → x11vnc → websockify → Chromium → socat → ttyd → file-server
# Serves a custom workspace web UI with browser, terminal, and file panels.

# ── Configuration (env overrides) ────────────────────────
DISPLAY_NUM="${KAIRO_DISPLAY_NUM:-99}"
RESOLUTION="${KAIRO_RESOLUTION:-1280x720x24}"
VNC_PORT="${KAIRO_VNC_PORT:-5900}"
NOVNC_PORT="${KAIRO_NOVNC_PORT:-6080}"
CDP_INTERNAL_PORT="${KAIRO_CDP_INTERNAL_PORT:-9223}"
CDP_PORT="${KAIRO_CDP_PORT:-9222}"
TTYD_PORT="${KAIRO_TTYD_PORT:-7681}"
FILE_SERVER_PORT="${KAIRO_FILE_SERVER_PORT:-8090}"

export DISPLAY=":${DISPLAY_NUM}"
export HOME=/home/sandbox

# Container's bridge IP — used to bind services instead of 0.0.0.0
BIND_ADDR="$(hostname -i 2>/dev/null | awk '{print $1}')"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"

PIDS=()

# ── Cleanup on exit ──────────────────────────────────────
cleanup() {
    local exit_code=$?
    for ((i=${#PIDS[@]}-1; i>=0; i--)); do
        local pid="${PIDS[i]}"
        if kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    sleep 1
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    exit "$exit_code"
}
trap cleanup SIGTERM SIGINT EXIT

# ── Clean stale lock files ───────────────────────────────
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

# ── 1. Xvfb (virtual display) ────────────────────────────
Xvfb ":${DISPLAY_NUM}" -screen 0 "${RESOLUTION}" -ac -nolisten tcp -nolisten unix &
PIDS+=($!)

for _ in $(seq 1 50); do
    if xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then break; fi
    sleep 0.1
done
if ! xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
    echo "FATAL: Xvfb failed to start on display :${DISPLAY_NUM}" >&2
    exit 1
fi

# ── 2. x11vnc (VNC server, localhost only) ────────────────
VNC_PASSWD_FILE="${HOME}/.vnc/passwd"
mkdir -p "${HOME}/.vnc"
VNC_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 8)"
x11vnc -storepasswd "${VNC_PASSWORD}" "${VNC_PASSWD_FILE}" >/dev/null 2>&1
chmod 600 "${VNC_PASSWD_FILE}"

# Generate per-session token for file server auth
SESSION_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"

# Write runtime config for the workspace UI (injected at startup, served as JS)
cat > /opt/workspace-ui/config.js << CFGEOF
window.DESKTOP_CONFIG = {
  vncPassword: "${VNC_PASSWORD}",
  ttydPort: ${TTYD_PORT},
  filePort: ${FILE_SERVER_PORT},
  cdpPort: ${CDP_PORT},
  sessionToken: "${SESSION_TOKEN}"
};
CFGEOF

x11vnc \
    -display ":${DISPLAY_NUM}" \
    -rfbport "${VNC_PORT}" \
    -rfbauth "${VNC_PASSWD_FILE}" \
    -shared -forever -localhost -noxdamage -nap -q &
PIDS+=($!)

for _ in $(seq 1 30); do
    if (echo > "/dev/tcp/localhost/${VNC_PORT}") 2>/dev/null; then break; fi
    sleep 0.1
done

# ── 3. websockify (noVNC WebSocket, serves workspace UI) ──
# Serves our custom workspace page from /opt/workspace-ui/ (built into image).
# noVNC assets are copied at build time in the Dockerfile.
websockify \
    --web "/opt/workspace-ui/" \
    --heartbeat=30 \
    "${BIND_ADDR}:${NOVNC_PORT}" \
    "localhost:${VNC_PORT}" &
PIDS+=($!)

# ── 4. Openbox (borderless window manager) ────────────────
# Openbox removes Chrome's window borders so it fills the full display.
# Configured for zero decorations: no title bar, no borders, no menu.
mkdir -p "${HOME}/.config/openbox"
cat > "${HOME}/.config/openbox/rc.xml" << 'OBXML'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <theme>
    <name>Clearlooks</name>
    <titleLayout></titleLayout>
  </theme>
  <applications>
    <application class="*">
      <decor>no</decor>
      <maximized>yes</maximized>
      <position force="yes"><x>0</x><y>0</y></position>
    </application>
  </applications>
  <keyboard/>
  <mouse/>
  <menu/>
</openbox_config>
OBXML
xsetroot -solid "#ffffff" 2>/dev/null || true
openbox &
PIDS+=($!)
sleep 0.5

# ── 5. Chromium (auto-restart on close/crash) ────────────
(while true; do
    chromium \
        --no-sandbox \
        --no-first-run \
        --no-default-browser-check \
        --disable-dev-shm-usage \
        --disable-background-networking \
        --disable-features=TranslateUI \
        --disable-breakpad \
        --disable-crash-reporter \
        --no-zygote \
        --disable-gpu \
        --disable-software-rasterizer \
        --disable-3d-apis \
        --disable-extensions \
        --test-type \
        --renderer-process-limit=2 \
        --metrics-recording-only \
        --remote-debugging-address=127.0.0.1 \
        --remote-debugging-port="${CDP_INTERNAL_PORT}" \
        --user-data-dir="${HOME}/.chrome" \
        --start-maximized \
        about:blank 2>/dev/null
    sleep 1
done) &
CHROME_LOOP_PID=$!

for _ in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:${CDP_INTERNAL_PORT}/json/version" >/dev/null 2>&1; then break; fi
    sleep 0.1
done

# Maximize Chrome to fill the entire display (openbox handles the borderless part)
sleep 0.5
for wid in $(xdotool search --name "Chromium" 2>/dev/null); do
    wmctrl -i -r "${wid}" -b add,maximized_vert,maximized_horz 2>/dev/null || \
    xdotool windowactivate --sync "${wid}" key --clearmodifiers super+Up 2>/dev/null || \
    xdotool windowsize "${wid}" 1280 720 windowmove "${wid}" 0 0 2>/dev/null || true
done

# ── 5. socat (CDP proxy) ─────────────────────────────────
socat "TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=${BIND_ADDR}" "TCP:127.0.0.1:${CDP_INTERNAL_PORT}" &
PIDS+=($!)

# ── 6. ttyd (web terminal) ───────────────────────────────
TTYD_CREDENTIAL="sandbox:${SESSION_TOKEN}"
ttyd \
    --port "${TTYD_PORT}" \
    --interface "${BIND_ADDR}" \
    --writable \
    --max-clients 3 \
    --ping-interval 30 \
    --credential "${TTYD_CREDENTIAL}" \
    --check-origin \
    bash &
PIDS+=($!)

# ── 7. File server (Python, serves /workspace with CRUD) ─
export BIND_ADDR FILE_SERVER_PORT SESSION_TOKEN
python3 << 'PYEOF' &
import http.server, json, os, shutil, socketserver, re

BASE = '/workspace'
BIND = os.environ.get('BIND_ADDR', '0.0.0.0')
PORT = int(os.environ.get('FILE_SERVER_PORT', '8090'))
TOKEN = os.environ.get('SESSION_TOKEN', '')

def safe_path(path):
    rel = path.replace('..', '').lstrip('/')
    target = os.path.join(BASE, rel) if rel else BASE
    real = os.path.realpath(target)
    if not real.startswith(os.path.realpath(BASE)):
        return None
    return real

class FileHandler(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'X-Desktop-Token')

    def check_token(self):
        if not TOKEN: return True
        if self.headers.get('X-Desktop-Token', '') != TOKEN:
            self.send_error(401, 'Invalid token')
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if not self.check_token(): return
        if self.path.startswith('/download/'):
            rel = self.path[10:]
            target = safe_path(rel)
            if not target or not os.path.isfile(target):
                self.send_error(404); return
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', 'attachment; filename="' + os.path.basename(target) + '"')
            self.cors()
            self.end_headers()
            with open(target, 'rb') as f:
                shutil.copyfileobj(f, self.wfile)
            return

        target = safe_path(self.path)
        if not target or not os.path.exists(target):
            self.send_error(404); return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.cors()
        self.end_headers()
        if os.path.isdir(target):
            entries = []
            for name in sorted(os.listdir(target)):
                full = os.path.join(target, name)
                try:
                    st = os.stat(full)
                    entries.append({'name': name, 'type': 'dir' if os.path.isdir(full) else 'file', 'size': st.st_size})
                except: pass
            self.wfile.write(json.dumps(entries).encode())
        else:
            content = open(target, 'r', errors='replace').read(50000)
            self.wfile.write(json.dumps({'content': content}).encode())

    def do_POST(self):
        if not self.check_token(): return
        if self.path.startswith('/mkdir/'):
            rel = self.path[7:]
            target = safe_path(rel)
            if not target:
                self.send_error(400); return
            os.makedirs(target, exist_ok=True)
            self.send_response(200)
            self.cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        if self.path.startswith('/upload/'):
            rel = self.path[8:]
            target_dir = safe_path(rel)
            if not target_dir or not os.path.isdir(target_dir):
                self.send_error(400); return
            content_type = self.headers.get('Content-Type', '')
            if 'multipart/form-data' in content_type:
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length)
                boundary = re.search(r'boundary=([^\s;]+)', content_type)
                if boundary:
                    parts = body.split(b'--' + boundary.group(1).encode())
                    for part in parts:
                        if b'filename="' not in part: continue
                        fname_match = re.search(rb'filename="([^"]+)"', part)
                        if not fname_match: continue
                        fname = os.path.basename(fname_match.group(1).decode())
                        file_data = part.split(b'\r\n\r\n', 1)
                        if len(file_data) < 2: continue
                        content = file_data[1].rstrip(b'\r\n--')
                        dest = os.path.join(target_dir, fname)
                        with open(dest, 'wb') as f:
                            f.write(content)
                self.send_response(200)
                self.cors()
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            else:
                self.send_error(400)
            return

        self.send_error(404)

    def do_DELETE(self):
        if not self.check_token(): return
        if self.path.startswith('/delete/'):
            rel = self.path[8:]
            target = safe_path(rel)
            if not target or not os.path.exists(target):
                self.send_error(404); return
            if target == os.path.realpath(BASE):
                self.send_error(403); return
            if os.path.isdir(target):
                shutil.rmtree(target)
            else:
                os.remove(target)
            self.send_response(200)
            self.cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        self.send_error(404)

    def log_message(self, *args): pass

with socketserver.TCPServer((BIND, PORT), FileHandler) as s:
    s.serve_forever()
PYEOF
PIDS+=($!)

echo "Desktop sandbox ready: workspace=:${NOVNC_PORT} terminal=:${TTYD_PORT} files=:${FILE_SERVER_PORT} CDP=:${CDP_PORT}"

wait -n
echo "A desktop process exited unexpectedly" >&2
exit 1
