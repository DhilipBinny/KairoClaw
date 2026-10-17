# Container Environments

Docker-based isolated environments for KairoClaw. Two container types share the same infrastructure:

| Type | Purpose | Image | Created by |
|------|---------|-------|-----------|
| **Sandbox** | Headless code execution (`sandbox_exec` tool) | `kairoclaw-sandbox:full` (1 GB) | Agent, on first tool call |
| **Desktop** | Browser workspace with Chrome, terminal, file manager | `kairoclaw-sandbox:desktop` (2.3 GB) | Admin, via Cloud Desktop page |

Both use the same Dockerfile (multi-target build), the same `ContainerManager`, and the same admin Settings section.

## Prerequisites

- Docker Engine 24+ running on the host
- Docker socket accessible at `/var/run/docker.sock`
- If KairoClaw runs in Docker: mount the socket with `-v /var/run/docker.sock:/var/run/docker.sock`

## Building Images

Single Dockerfile, two targets:

```bash
# Sandbox image (headless code execution)
docker build -f packages/sandbox/docker/Dockerfile.sandbox --target full -t kairoclaw-sandbox:full .

# Desktop image (extends sandbox + Chrome, VNC, terminal, file manager)
docker build -f packages/sandbox/docker/Dockerfile.sandbox --target desktop -t kairoclaw-sandbox:desktop .
```

The `desktop` target inherits everything from `full` and adds: Chromium, Xvfb, x11vnc, websockify, noVNC, openbox, ttyd, wmctrl, scrot, xdotool.

### Deploying the desktop image to a remote server

```bash
docker save kairoclaw-sandbox:desktop | gzip > desktop-image.tar.gz
scp desktop-image.tar.gz user@server:/tmp/
ssh user@server "docker load < /tmp/desktop-image.tar.gz"
```

## Enable in Config

Via Admin UI: **Settings → Sandbox Execution → Enable**

Or in `config.json`:
```json
{
  "tools": {
    "sandbox": {
      "enabled": true,
      "image": "kairoclaw-sandbox:full",
      "desktopImage": "kairoclaw-sandbox:desktop",
      "desktopUsers": []
    }
  }
}
```

---

# Part 1: Sandbox (Headless Code Execution)

## How It Works

### Two Execution Tools

| Tool | Where it runs | Who can use it |
|------|---------------|---------------|
| `exec` | Host machine (no isolation) | Admin, elevated users only |
| `sandbox_exec` | Docker container (isolated) | All users (including regular) |

The agent automatically chooses based on the task. Regular users only see `sandbox_exec` — the permission system hides `exec` from them entirely.

### Container Lifecycle

- **Created** on first `sandbox_exec` call per user+session
- **Persisted** across tool calls (installed packages, files survive)
- **Destroyed** when:
  - Idle for 15 minutes (no exec activity)
  - Max lifetime reached (4 hours default)
  - Admin stops it via UI
  - Server shuts down

### Network Tiers

| Tier | Access | Use case |
|------|--------|----------|
| **Open** | Unrestricted outbound | Admin, trusted users |
| **Locked** | No network access | Default for regular users |

> **Note:** The "Balanced" tier (domain allowlist) is planned for a future release via a proxy sidecar. Currently, selecting balanced falls back to locked.

### Workspace Mounts

| Mode | Behavior |
|------|----------|
| **Read-write** | Container sees user's workspace, changes persist to host |
| **Read-only** | Container sees files but can't modify them |
| **None** | Isolated scratch space, no host file access |

- Non-admin users: their scope directory (`scopes/<userId>/`) is mounted
- Admin users: full workspace is mounted
- `shared/` directory always mounted read-only for non-admin
- Persona files (IDENTITY.md, SOUL.md, RULES.md) always read-only

## Sandbox Configuration

All settings available in **Admin UI → Settings → Sandbox Execution**:

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | false | Enable/disable sandbox |
| Image | kairoclaw-sandbox:full | Docker image to use |
| Network | balanced (→locked) | Default network tier |
| Workspace | read-write | Default mount mode |
| Escalation | confirm | Agent upgrade policy (auto/confirm/deny) |
| CPU | 1 core | Max CPU per container |
| Memory | 512 MB | Max memory per container |
| Timeout | 120 sec | Per-command timeout |
| Max Lifetime | 240 min | Max container lifespan |

### Per-Role Overrides

```json
{
  "tools": {
    "sandbox": {
      "roles": {
        "admin": { "network": "open", "workspace": "read-write" },
        "user": { "network": "locked", "workspace": "read-only" }
      }
    }
  }
}
```

### Per-User Overrides

```json
{
  "tools": {
    "sandbox": {
      "userOverrides": {
        "<user-uuid>": { "network": "open" }
      }
    }
  }
}
```

---

# Part 2: Cloud Desktop (Browser Workspace)

A full desktop environment inside a container: Chromium browser, terminal, and file manager — accessible through the admin UI.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Admin Browser                                   │
│  /admin/desktop → Click "Open"                  │
│       │                                          │
│       ▼ POST /workspace-token (API key header)  │
│       │ ← one-time code (60s expiry)            │
│       │                                          │
│       ▼ GET /workspace-auth?code=X (new tab)    │
│       │ ← Set-Cookie: kairo_ws (HttpOnly)       │
│       │ ← 302 → /workspace                      │
│       │                                          │
│       ▼ GET /workspace (cookie auth)             │
│       │ ← Workspace HTML (CSP sandboxed)        │
│       │                                          │
│       ├─ VNC iframe → WS /vnc (cookie auth)     │
│       ├─ File tree → HTTP /files/* (cookie auth)│
│       └─ Terminal → (future: WS /terminal)      │
└──────────┬──────────────────────────────────────┘
           │  HTTP/WS proxy (admin API routes)
           ▼
┌──────────────────────────────────────────────────┐
│  Desktop Container (Docker bridge network)       │
│                                                  │
│  Xvfb :99 ──→ x11vnc ──→ websockify :6080      │
│  openbox (WM) ──→ Chromium (borderless)         │
│  ttyd :7681 (terminal with token auth)          │
│  Python file server :8090 (CRUD with token)     │
│  socat :9222 → Chrome CDP (localhost only)       │
│                                                  │
│  /opt/workspace-ui/index.html (workspace page)  │
│  /tmp/desktop-secrets.json (VNC pw + token)     │
└──────────────────────────────────────────────────┘
```

## Authentication Flow

The workspace uses a one-time code → HttpOnly cookie exchange pattern (similar to OAuth authorization codes). No API keys or reusable tokens appear in URLs.

1. **Admin clicks "Open"** in the Cloud Desktop admin page
2. **UI requests a one-time code** via `POST /admin/desktop/:userId/workspace-token` (API key sent in Authorization header)
3. **Server generates a random code** (32 bytes, 60-second expiry, stored in memory)
4. **UI opens a new tab** at `/admin/desktop/:userId/workspace-auth?code=X`
5. **Server validates the code**, deletes it (one-time use), generates a session ID, sets an HttpOnly cookie:
   - `kairo_ws=<sessionId>`
   - `Path=/api/v1/admin/desktop/<userId>/` (scoped per user)
   - `HttpOnly; Secure; SameSite=Strict; Max-Age=300`
   - `Referrer-Policy: no-referrer` (prevents code leaking via Referer)
6. **Server redirects** to `/admin/desktop/:userId/workspace` (clean URL, no secrets)
7. **All subsequent requests** (HTML, config.js, VNC WebSocket, file API) use the cookie automatically

### Why this design

| Alternative | Problem |
|------------|---------|
| API key in URL query param | Persists in server logs, browser history, proxy caches |
| API key in URL hash | Not sent to server (can't auth) |
| Reusable bearer token in URL | Same log/history problem, plus replay attacks |
| Session cookie alone | Can't set cookie from a `<button onclick>` without a redirect flow |

## Admin Workflow

1. Go to **Admin → Cloud Desktop** in the sidebar
2. **Toggle ON** desktop for a user in the users table
3. Click **Start** to create the container (takes ~15 seconds for Chrome startup)
4. Click **Open** to launch the workspace in a new tab
5. Click **Stop** to destroy the container

## Desktop Container Lifecycle

| Property | Value |
|----------|-------|
| Keyed by | userId only (not session — persists across conversations) |
| Network | Open (bridge — Chrome needs internet) |
| Memory | 1024 MB |
| SHM | 256 MB (for Chrome) |
| PID limit | 512 |
| Idle timeout | 60 minutes |
| Max lifetime | 8 hours |
| Workspace mount | Read-write |

## Agent Tools

When a desktop container is running for a user, the agent gains 7 tools:

| Tool | Description |
|------|-------------|
| `desktop_navigate` | Navigate Chrome to a URL |
| `desktop_screenshot` | Take a screenshot (base64 PNG) |
| `desktop_read_page` | Read current page title and URL via CDP |
| `desktop_click_xy` | Click at x,y coordinates |
| `desktop_type_raw` | Type text at cursor position |
| `desktop_key` | Press a key or key combination |
| `desktop_scroll` | Scroll up/down |

Tools are registered globally but check per-request whether the user has an active desktop container. If no container is running, tools return a clear error message.

## API Endpoints

### Admin management (require admin API key)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/desktop/:userId/status` | Container status + secrets |
| POST | `/admin/desktop/:userId/start` | Start desktop (checks isDesktopEnabled) |
| POST | `/admin/desktop/:userId/stop` | Stop and remove container |
| GET | `/admin/desktop/list` | List all desktop containers |
| POST | `/admin/desktop/:userId/workspace-token` | Generate one-time access code |

### Workspace proxy (require session cookie)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/desktop/:userId/workspace-auth` | Exchange code for cookie + redirect |
| GET | `/admin/desktop/:userId/workspace` | Proxy workspace HTML from container |
| GET | `/admin/desktop/:userId/workspace/*` | Proxy workspace static files |
| GET | `/admin/desktop/:userId/files/*` | Proxy file server (list, download) |
| POST | `/admin/desktop/:userId/files/*` | Proxy file upload, mkdir |
| DELETE | `/admin/desktop/:userId/files/*` | Proxy file/dir delete |

### WebSocket proxy (require admin API key or session cookie)

| Path | Target |
|------|--------|
| `/admin/desktop/:userId/vnc` | Container port 6080 (websockify) |
| `/admin/desktop/:userId/terminal` | Container port 7681 (ttyd) |

## Security

### Container isolation
- Non-root user (uid 1000), all capabilities dropped
- CDP (Chrome DevTools Protocol) bound to localhost only inside the container
- File server has per-session token auth + CORS restricted to workspace origin
- ttyd has credential-based auth

### Proxy security
- `Content-Security-Policy: sandbox allow-scripts allow-forms` on all proxied content (isolates from admin origin's cookies/storage)
- `X-Content-Type-Options: nosniff` on all proxied responses
- File downloads forced to `application/octet-stream` with `Content-Disposition: attachment`
- Upload size limited to 100 MB
- Path traversal protection via `os.path.normpath` + `os.path.realpath` containment check

### Secrets
- VNC password and file server token generated per-container at startup
- Written to `/tmp/desktop-secrets.json` (not served over HTTP)
- Read by the admin API via `docker exec`
- Passed to the workspace UI via the proxied `config.js` (admin auth required)

---

# Shared: Container Security

Both sandbox and desktop containers run with:
- Non-root user (uid 1000)
- All Linux capabilities dropped (`--cap-drop ALL`)
- No privilege escalation (`--security-opt no-new-privileges`)
- Memory limit with swap disabled
- Init process for zombie reaping (`--init`)
- OOM score adjustment (container killed first under pressure)
- Core dumps disabled

## Troubleshooting

### "Sandbox is not available"
- Docker daemon not running: `systemctl start docker`
- Socket not mounted: add `-v /var/run/docker.sock:/var/run/docker.sock`
- Image not built: run the build commands above

### "Image not found"
```bash
docker images kairoclaw-sandbox --format '{{.Repository}}:{{.Tag}} {{.Size}}'
# Should show both :full and :desktop
```

### Desktop container won't start
```bash
# Check if the desktop image exists
docker images kairoclaw-sandbox:desktop
# If empty, build it (see Building Images above)

# Check Docker resources
docker system df
free -h
```

### Workspace shows blank page
- Check the container is still running in the Cloud Desktop admin page
- The workspace session cookie expires after 5 minutes — click Open again
- Check browser console for errors

## Custom Images

You can use any Docker image as the sandbox. Set the image name in Settings or config:

```json
{ "tools": { "sandbox": { "image": "ubuntu:22.04" } } }
```

Requirements for custom sandbox images:
- Must have `/bin/sh` (used for command execution)
- Should have a user with uid 1000 (container runs as this user)
- Directories `/workspace`, `/shared`, `/persona` are created automatically
