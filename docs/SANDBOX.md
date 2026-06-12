# Sandbox Execution

Docker-based isolated code execution for KairoClaw. The agent runs untrusted code, package installs, and builds inside a sandboxed container instead of directly on the host.

## Prerequisites

- Docker Engine 24+ running on the host
- Docker socket accessible at `/var/run/docker.sock`
- If KairoClaw runs in Docker: mount the socket with `-v /var/run/docker.sock:/var/run/docker.sock`

## Quick Setup

### 1. Build the sandbox image

```bash
docker build -t kairoclaw-sandbox:full -f packages/sandbox/docker/Dockerfile.full .
```

The image includes: Debian bookworm-slim, Node.js 22, Python 3.12, npm, pnpm, pip, git, curl, jq, wget.

### 2. Enable in config

Via Admin UI: **Settings → Sandbox Execution → Enable**

Or in `config.json`:
```json
{
  "tools": {
    "sandbox": {
      "enabled": true
    }
  }
}
```

### 3. If running KairoClaw in Docker

Add the socket mount to your docker-compose or docker run:

```yaml
services:
  kairoclaw:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
```

### 4. Verify

Check **Settings → Sandbox Execution** in the Admin UI. Status should show **Ready** in green.

Or via API:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:18181/api/v1/admin/sandbox/status
```

## How It Works

### Two Execution Tools

| Tool | Where it runs | Who can use it |
|---|---|---|
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
|---|---|---|
| **Open** | Unrestricted outbound | Admin, trusted users |
| **Locked** | No network access | Default for regular users |

> **Note:** The "Balanced" tier (domain allowlist) is planned for a future release via a proxy sidecar. Currently, selecting balanced falls back to locked.

### Workspace Mounts

| Mode | Behavior |
|---|---|
| **Read-write** | Container sees user's workspace, changes persist to host |
| **Read-only** | Container sees files but can't modify them |
| **None** | Isolated scratch space, no host file access |

- Non-admin users: their scope directory (`scopes/<userId>/`) is mounted
- Admin users: full workspace is mounted
- `shared/` directory always mounted read-only for non-admin
- Persona files (IDENTITY.md, SOUL.md, RULES.md) always read-only

## Configuration

All settings available in **Admin UI → Settings → Sandbox Execution**:

| Setting | Default | Description |
|---|---|---|
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

In `config.json`, set different defaults per role:

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

## Container Security

Containers run with:
- Non-root user (uid 1000)
- All Linux capabilities dropped (`--cap-drop ALL`)
- No privilege escalation (`--security-opt no-new-privileges`)
- PID limit (256 default)
- Memory limit with swap disabled
- Init process for zombie reaping (`--init`)
- OOM score adjustment (sandbox killed first under pressure)
- Core dumps disabled

## Troubleshooting

### "Sandbox is not available"
- Docker daemon not running: `systemctl start docker`
- Socket not mounted: add `-v /var/run/docker.sock:/var/run/docker.sock`
- Image not built: run the build command above

### "Image not found"
```bash
docker images kairoclaw-sandbox:full
# If empty, build it:
docker build -t kairoclaw-sandbox:full -f packages/sandbox/docker/Dockerfile.full .
```

### Container won't start
```bash
# Check Docker logs
docker logs <container-id>
# Check system resources
docker system df
free -h
```

### Admin can't see sandbox in Settings
Ensure the server has been restarted after adding the sandbox config. Or toggle sandbox enabled/disabled in Settings — the hot-reload will pick it up.

## Custom Images

You can use any Docker image as the sandbox. Set the image name in Settings or config:

```json
{ "tools": { "sandbox": { "image": "ubuntu:22.04" } } }
```

Requirements for custom images:
- Must have `/bin/sh` (used for command execution)
- Should have a user with uid 1000 (container runs as this user)
- Directories `/workspace`, `/shared`, `/persona` are created automatically
