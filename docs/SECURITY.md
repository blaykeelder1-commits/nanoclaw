# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Apple Container (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Mounted Credentials:**
- Claude auth tokens (filtered from `.env`, read-only)

**NOT Mounted:**
- WhatsApp session (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only these environment variables are exposed to containers:
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
```

> **Note:** Anthropic credentials are mounted so that Claude Code can authenticate when the agent runs. However, this means the agent itself can discover these credentials via Bash or file operations. Ideally, Claude Code would authenticate without exposing credentials to the agent's execution environment, but I couldn't figure this out. **PRs welcome** if you have ideas for credential isolation.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

### 6. Webhook Security (Quo/OpenPhone SMS)

The Quo channel receives inbound SMS via HTTP webhook on port 3100.

**Defenses (application layer):**
- **Rate limiting** — 30 requests/min per IP, in-memory counter with auto-cleanup
- **Signature verification** — HMAC-SHA256 via `openphone-signature` header, timing-safe comparison
- **Input validation** — Zod schema validation rejects malformed payloads with 400
- **Body size limit** — 1MB max, prevents memory exhaustion
- **Audit logging** — Rate limits, signature failures, and validation errors logged with `[AUDIT]` tag

**Defenses (infrastructure layer):**
- **nginx reverse proxy** — TLS termination, additional rate limiting (10 req/s burst 20)
- **fail2ban** — Bans IPs with 10+ 4xx errors in 60s for 1 hour
- **Firewall** — Port 3100 not exposed externally; nginx proxies from 443

**Configuration required:**
- `QUO_WEBHOOK_SECRET` in `.env` — Base64-encoded signing secret from OpenPhone webhook settings
- TLS certificates via certbot or self-signed (see `deploy/nginx.conf`)

### 7. Container Network Policy

All containers currently have unrestricted outbound network access. This is required because every skill makes API calls (Google Sheets, SMTP, social media APIs, etc.).

**Mitigations:**
- Docker `--cap-drop=ALL` and `--security-opt=no-new-privileges` on Linux
- Apple Container VM isolation on macOS
- No inbound ports published from containers

## Secret Rotation Procedure

| Secret | Where | How to Rotate |
|--------|-------|---------------|
| `ANTHROPIC_API_KEY` | `.env` | Generate new key at console.anthropic.com, update `.env`, restart |
| `CLAUDE_CODE_OAUTH_TOKEN` | `.env` | Re-authenticate via `claude auth`, update `.env`, restart |
| `QUO_API_KEY` | `.env` | Generate new key in OpenPhone dashboard, update `.env`, restart |
| `QUO_WEBHOOK_SECRET` | `.env` | Regenerate in OpenPhone webhook settings, update `.env`, restart |
| `SMTP_PASS` | `.env` | Reset via email provider, update `.env`, restart |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `.env` | Rotate key in GCP IAM console, update `.env`, restart |
| Social API tokens | `.env` | Regenerate via respective developer portals, update `.env`, restart |

**General rotation steps:**
1. Generate new credential in the provider's dashboard
2. Update the value in `/home/nanoclaw/nanoclaw/.env`
3. `sudo systemctl restart nanoclaw`
4. Verify via `journalctl -u nanoclaw -f` — look for successful connection logs
5. Revoke the old credential in the provider's dashboard

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
