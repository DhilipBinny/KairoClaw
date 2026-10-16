# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in KairoClaw, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email: **contact@bsigma.ai**

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix release**: depends on severity (critical: ASAP, high: within 14 days)

## Scope

The following are in scope:
- Authentication and authorization bypass
- SQL injection, command injection, path traversal
- Secret/credential exposure
- Cross-site scripting (XSS) in the admin dashboard
- Server-side request forgery (SSRF)
- Container escape in sandbox execution
- Privilege escalation between user roles

## Out of Scope

- Vulnerabilities in third-party dependencies (report upstream)
- Issues requiring physical access to the server
- Social engineering attacks
- Denial of service (self-hosted, operator controls access)

## Security Features

KairoClaw includes multiple security layers:
- AES-256-GCM encryption at rest for all API keys and secrets
- HMAC-SHA256 keyed API key hashing
- Signed media URLs with time-limited access
- Docker sandbox with CapDrop ALL, non-root execution, PID/memory limits
- Span-based secret redaction (22 patterns) on all agent output
- Prompt injection detection (11 pattern types) with indirect injection scanning on tool results
- Tamper-evident audit trail
- Per-user scope isolation for files, memory, and tool execution
- Rate limiting on authentication endpoints
- Content-Security-Policy with script, style, font, image, and connection restrictions
- Cross-Origin-Opener-Policy, X-Frame-Options, Referrer-Policy, Permissions-Policy headers
- Webhook replay protection (HMAC-SHA256 over timestamp + payload)
- Request trace IDs for end-to-end audit correlation across all channels
