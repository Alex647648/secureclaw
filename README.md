<p align="center">
  <img src="assets/banner.svg" alt="SecureClaw" width="600" />
</p>

<p align="center">
  An enterprise AI agent security framework that runs Claude Code agents inside isolated containers.<br/>
  6-layer security pipeline. Multi-channel messaging. Zero trust by default.
</p>

<p align="center">
  <a href="README.zh-CN.md">中文</a> ·
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node" />
  <img src="https://img.shields.io/badge/tests-558%20passed-brightgreen.svg" alt="Tests" />
  <img src="https://img.shields.io/badge/typescript-5.9-blue.svg" alt="TypeScript" />
</p>

---

```
 WhatsApp · Telegram · Slack · Discord
              │
  ┌───────────▼────────────┐
  │  Ingress    normalize  │  trigger word filter, message normalization
  │  Trust      evaluate   │  injection guard, rate limiter, trust scoring
  │  Router     enqueue    │  task builder, per-group FIFO queue
  │  Execution  run        │  container sandbox, credential proxy, network policy
  │  Memory     persist    │  per-group CLAUDE.md, session directory lifecycle
  │  Audit      record     │  HMAC hash-chain, append-only log
  └────────────────────────┘
```

## Table of Contents

- [What is SecureClaw](#what-is-secureclaw)
- [Why SecureClaw](#why-secureclaw)
- [Comparison with Other Projects](#comparison-with-other-projects)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed installation](#detailed-installation)
- [Configuration](#configuration)
- [Daily use](#daily-use)
- [Channel Setup](#channel-setup)
- [Admin Commands](#admin-commands)
- [FAQ](#faq)
- [Security Model](#security-model)
- [Monitoring](#monitoring)
- [Development](#development)
- [Project Structure](#project-structure)
- [License](#license)

## What is SecureClaw

SecureClaw is an **enterprise AI agent security framework**. It receives messages from WhatsApp, Telegram, Slack, and Discord, processes them through a six-layer security pipeline, runs Claude Code agents inside **isolated containers**, and sends replies back to the right group. It targets teams or organizations that need security, auditability, and multi-channel support.

## Why SecureClaw

| Advantage | Description |
|-----------|-------------|
| **Security by design** | Every message goes through six layers; every agent task runs in its **own container by default** — no need to “remember to enable sandbox”. |
| **API keys never in containers** | Keys stay on the host; a credential proxy issues session tokens on demand. Containers never see the raw key, reducing leakage by design. |
| **Zero trust by default** | New users are untrusted until an admin promotes them; capabilities and network policy follow trust level. |
| **Enterprise audit** | Built-in audit log and HMAC hash chain; network policies (no network / Claude API only / open) are built in. |
| **Clear scope** | Four channels + Claude only; simple stack for security review and compliance. |

## Comparison with Other Projects

The "Claw" ecosystem has grown rapidly. Here is how SecureClaw compares with other major frameworks:

| | **SecureClaw** | **OpenClaw** | **NanoClaw** | **ZeroClaw** |
|---|---|---|---|---|
| **Positioning** | Enterprise security framework | Personal AI assistant gateway | Lightweight container-first agent | Minimal Rust runtime |
| **Language** | TypeScript | TypeScript | TypeScript | Rust |
| **Security model** | 6-layer pipeline (Ingress → Trust → Router → Execution → Memory → Audit) | DM policy gate, per-session sandbox | Container-level isolation only | Trait-based sandbox controls |
| **Trust model** | Multi-tenant, per-sender trust levels (BLOCKED → UNTRUSTED → TRUSTED → ADMIN) | Single-operator (one trusted user, many agents) | No built-in trust scoring | Allowlists |
| **Credential isolation** | API keys **never enter containers**; Unix socket proxy with 256-bit session tokens, 3 req/session limit | Keys passed via environment variables | Keys mounted or passed in | Encrypted secrets store |
| **Injection defense** | 13 heuristic rules, 0.0–1.0 scoring, configurable threshold | No built-in injection guard | No built-in injection guard | No built-in injection guard |
| **Audit trail** | Append-only SQLite + HMAC hash-chain (tamper-evident) | Basic logging | No audit chain | Observability hooks |
| **Network policy** | 4 presets: `isolated` / `claude_only` / `trusted` / `open` | Per-session sandbox policy | Container network defaults | Sandbox controls |
| **Channels** | WhatsApp, Telegram, Slack, Discord | 25+ channels | WhatsApp, Telegram, Slack, Discord, Gmail | 15+ channels |
| **Container runtime** | Docker + Apple Container | Docker | Docker + Apple Container | Built-in sandbox |
| **Rate limiting** | Per-sender, configurable | No built-in rate limiter | No built-in rate limiter | No built-in rate limiter |
| **Codebase size** | ~12K lines, 558 tests | Large (full gateway) | ~3,900 lines | Single binary (8.8 MB) |
| **Best for** | Teams needing security, compliance, and auditability | Personal power users wanting maximum channel coverage | Developers wanting a minimal, hackable agent | Performance-critical deployments |

### Key advantages of SecureClaw

1. **Security is the architecture, not an add-on.** Every message passes through six layers before an agent sees it. Other frameworks treat security as optional configuration — SecureClaw makes it the default.

2. **API keys never touch the container.** The credential proxy distributes short-lived session tokens over a Unix socket. Even if the container is compromised, the attacker cannot extract the raw API key. No other Claw framework implements this level of credential isolation.

3. **Tamper-evident audit trail.** The HMAC hash-chain means any deleted or modified log entry breaks the chain. This matters for regulated industries and compliance requirements.

4. **Multi-tenant trust engine.** OpenClaw assumes a single trusted operator. SecureClaw supports multiple users at different trust levels in the same group, with capabilities and network policies tied to each level.

5. **Prompt injection defense built in.** 13 heuristic rules score every inbound message before it reaches the agent. Configurable threshold allows tuning the sensitivity for your use case.

6. **Production-ready from day one.** Health endpoint, structured logging (pino), metrics counters, system service installers (launchd / systemd), and 558 tests are included out of the box.

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 20 |
| Container runtime | Docker **or** Apple Container (macOS) |
| Anthropic API Key | `sk-ant-*` from [console.anthropic.com](https://console.anthropic.com) |

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url> secureclaw && cd secureclaw
bash setup.sh
```

`setup.sh` checks Node.js version, runs `npm install`, and verifies native modules (better-sqlite3).

### 2. Configure

```bash
cp secureclaw.env.example secureclaw.env
cp secureclaw.example.yaml secureclaw.yaml
```

Edit `secureclaw.env` — at minimum set your API key:

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Edit `secureclaw.yaml` — set your admin group and channel:

```yaml
app:
  trigger_word: "@SecureClaw"
  timezone: "Asia/Shanghai"

bootstrap:
  admin_group_id: "main"
  admin_channel_id: "120363xxx@g.us"   # WhatsApp JID / Telegram chat ID / etc.
  admin_sender_ids:
    - "8613800001111"                  # these users get ADMIN trust

container:
  runtime: "apple"                     # "apple" or "docker"
  image: "secureclaw-agent:latest"
  timeout_ms: 1800000                  # 30 min per task
  max_concurrent: 5

channels:
  whatsapp:
    enabled: true
  telegram:
    enabled: false
  slack:
    enabled: false
  discord:
    enabled: false
```

See [`secureclaw.example.yaml`](secureclaw.example.yaml) for all options.

### 3. Build the agent container

```bash
./container/build.sh
```

### 4. Start

```bash
npm start
```

On first launch with WhatsApp enabled, a QR code appears in the terminal — scan it to authenticate.

## Detailed installation

For step-by-step or production deployment, run these after copying and editing config (see Quick Start):

| Step | Command | Description |
|------|---------|-------------|
| 1 | `npx tsx setup/index.ts --step environment` | Check Node, container runtime, etc. |
| 2 | `npx tsx setup/index.ts --step container` | Build agent container image |
| 3 | `npx tsx setup/index.ts --step credentials -- --key sk-ant-YOUR_KEY` | Write API key to secureclaw.env |
| 4 | `npx tsx setup/index.ts --step channel-auth` | Complete channel auth (e.g. WhatsApp QR) |
| 5 | `npx tsx setup/index.ts --step register -- --group-id main --channel-id "CHANNEL_ID" --channel-type whatsapp` | Register admin group (see below) |
| 6 | `npx tsx setup/index.ts --step service` | Install system service (launchd / systemd) |
| 7 | `npx tsx setup/index.ts --step verify` | Verify installation |

**Channel ID examples for register**: WhatsApp `"120363xxx@g.us"`; Telegram `"-1001234567890"`; Slack `"C01234ABCD"`; Discord `"123456789012345678"`.

## Configuration

### Environment variables (`secureclaw.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | **Yes** | Claude API key |
| `TELEGRAM_BOT_TOKEN` | If Telegram enabled | From [@BotFather](https://t.me/BotFather) |
| `SLACK_BOT_TOKEN` | If Slack enabled | `xoxb-*` Bot token |
| `SLACK_APP_TOKEN` | If Slack enabled | `xapp-*` App-level token (Socket Mode) |
| `DISCORD_BOT_TOKEN` | If Discord enabled | Bot token from Discord Developer Portal |
| `SC_HEALTH_PORT` | No | Health check port (default: `9090`) |

### YAML config (`secureclaw.yaml`)

| Section | Key | Default | Description |
|---------|-----|---------|-------------|
| `app` | `trigger_word` | `@SecureClaw` | Message prefix to activate agent. Empty = respond to all |
| `app` | `timezone` | `Asia/Shanghai` | Timezone for cron scheduler |
| `container` | `runtime` | `apple` | `apple` (Apple Container) or `docker` |
| `container` | `timeout_ms` | `1800000` | Max agent task duration (30 min) |
| `container` | `max_concurrent` | `5` | Max simultaneous containers |
| `security` | `max_injection_score` | `0.75` | Injection threshold (0.0–1.0) |
| `security.credential_proxy` | `max_requests_per_session` | `3` | API key requests per session |
| `logging` | `level` | `info` | `debug` / `info` / `warn` / `error` |

## Deployment

### Step-by-step setup

Same as the “Detailed installation” table above; register examples are in that section.

### System service

<details>
<summary><strong>macOS (launchd)</strong></summary>

```bash
launchctl load   ~/Library/LaunchAgents/com.secureclaw.plist   # start on login
launchctl unload ~/Library/LaunchAgents/com.secureclaw.plist   # stop
launchctl kickstart -k gui/$(id -u)/com.secureclaw             # restart
```
</details>

<details>
<summary><strong>Linux (systemd)</strong></summary>

```bash
systemctl --user enable  secureclaw
systemctl --user start   secureclaw
systemctl --user stop    secureclaw
systemctl --user restart secureclaw
journalctl --user -u secureclaw -f    # view logs
```
</details>

<details>
<summary><strong>WSL</strong></summary>

```bash
bash ~/secureclaw/start-secureclaw.sh
```
</details>

### Production checklist

- [ ] `ANTHROPIC_API_KEY` set via secret manager (not plaintext in `.env`)
- [ ] `secureclaw.yaml` and `secureclaw.env` not committed to git
- [ ] Container image built and accessible
- [ ] At least one channel enabled and authenticated
- [ ] Admin group registered with correct `channel_id`
- [ ] Admin senders listed in `bootstrap.admin_sender_ids`
- [ ] Service installed and running
- [ ] Health endpoint responding: `curl http://127.0.0.1:9090/health`
- [ ] Logs visible via `journalctl` (Linux) or Console.app (macOS)

## Daily use

- **Trigger in group**: Include the trigger word (default `@SecureClaw`) in your message, e.g. “@SecureClaw summarize the discussion”. The group must be registered via `!admin group add`.
- **Trust levels**: New users are UNTRUSTED by default; admins can run `!admin trust set <group> <sender> <level>` to promote. Levels: BLOCKED → UNTRUSTED → TRUSTED → ADMIN.
- **Health check**: `curl http://127.0.0.1:9090/health` — 200 and status ok means healthy.
- **Logs**: When run directly, output is in the terminal; when run as a service, see `logs/secureclaw.log` or `journalctl --user -u secureclaw -f` on Linux.

## Channel Setup

<details>
<summary><strong>WhatsApp</strong></summary>

1. Set `channels.whatsapp.enabled: true`
2. Start the service — a QR code appears in the terminal
3. Open WhatsApp → Settings → Linked Devices → Link a Device → Scan QR
4. Session persists in `scdata/whatsapp-auth/`
</details>

<details>
<summary><strong>Telegram</strong></summary>

1. Create a bot via [@BotFather](https://t.me/BotFather), get the token
2. Set `TELEGRAM_BOT_TOKEN` in `secureclaw.env`
3. Set `channels.telegram.enabled: true`
4. Add the bot to your group and make it admin
</details>

<details>
<summary><strong>Slack</strong></summary>

1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode, get App-Level Token (`xapp-*`)
3. Add Bot Token Scopes: `chat:write`, `channels:history`, `groups:history`
4. Install to workspace, get Bot Token (`xoxb-*`)
5. Set both tokens in `secureclaw.env`
6. Set `channels.slack.enabled: true`
7. Invite the bot to your channel
</details>

<details>
<summary><strong>Discord</strong></summary>

1. Create application at [discord.com/developers](https://discord.com/developers/applications)
2. Create Bot, enable Message Content Intent
3. Get Bot Token, set `DISCORD_BOT_TOKEN` in `secureclaw.env`
4. Set `channels.discord.enabled: true`
5. Invite bot to server with `Send Messages` + `Read Message History` permissions
</details>

## Admin Commands

Send in any registered group (requires `ADMIN` trust level):

| Command | Description |
|---------|-------------|
| `!admin help` | Show all commands |
| `!admin status` | System status |
| `!admin group list` | List registered groups |
| `!admin group add <id> <channel_id> <type>` | Register group |
| `!admin group remove <id>` | Unregister group |
| `!admin trust set <group> <sender> <level>` | Set trust level |
| `!admin trust get <group> <sender>` | Check trust level |
| `!admin task list` | List scheduled tasks |
| `!admin task add <group> <cron> <prompt>` | Add cron task |
| `!admin task enable/disable <task_id>` | Toggle task |

Trust levels: `BLOCKED` (0) → `UNTRUSTED` (1) → `TRUSTED` (2) → `ADMIN` (3)

## FAQ

- **No QR code on first WhatsApp start?** Ensure `channels.whatsapp.enabled: true`, check terminal or logs for errors; you can remove `scdata/whatsapp-auth/` and restart to scan again.
- **Message sent but no agent reply?** Check trigger word, group is registered (`!admin group list`), sender is not BLOCKED, and not rate-limited or blocked by injection guard (see logs or /health metrics).
- **How to change API key?** Edit `ANTHROPIC_API_KEY` in `secureclaw.env` and restart; run `chmod 600 secureclaw.env` if needed.
- **Docker vs Apple Container?** Both work on macOS; Linux supports docker only.
- **Are secureclaw.env / secureclaw.yaml committed to Git?** No; both are in .gitignore.

## Security Model

| Layer | Mechanism | What it protects against |
|-------|-----------|------------------------|
| **Credential isolation** | API keys in process closure, distributed via Unix socket with 256-bit session tokens, 3 requests/session limit | Key exfiltration |
| **Container sandbox** | Each task → own container, non-root user, memory/CPU caps, mount whitelist | Container escape, host access |
| **Network policy** | `isolated` (none) / `claude_only` (proxy) / `trusted` / `open` | Data exfiltration |
| **Injection guard** | 13 heuristic rules, 0.0–1.0 scoring, configurable threshold | Prompt injection |
| **Trust engine** | Per-sender levels, capability-based tool restrictions | Unauthorized actions |
| **Audit trail** | Append-only SQLite, HMAC hash-chain | Accountability, tampering |

See [SECURITY.md](SECURITY.md) for details and vulnerability reporting.

## Monitoring

### Health endpoint

```bash
curl http://127.0.0.1:9090/health
```

```json
{
  "status": "ok",
  "uptime": 3600000,
  "timestamp": 1709827200000,
  "channels": 2,
  "metrics": {
    "tasks":       { "total": 42, "success": 40, "failed": 2 },
    "queue":       { "enqueued": 45, "rejected": 0 },
    "credentials": { "issued": 120 },
    "messages":    { "received": 200, "sent": 42, "rateLimited": 3, "injectionBlocked": 1 }
  }
}
```

`200` = healthy &nbsp;|&nbsp; `503` = shutting down &nbsp;|&nbsp; Port configurable via `SC_HEALTH_PORT`

### Logging

Structured NDJSON (pino) in production. Colorized in development.

```bash
npm start | jq .                                    # pretty print all
npm start | jq 'select(.module == "trust-engine")'  # filter by module
npm start | jq 'select(.level >= 50)'               # errors only
```

## Development

```bash
npm run dev          # hot reload with tsx
npm run build        # compile TypeScript
npm test             # run all 558 tests
npm run test:watch   # watch mode
npm run typecheck    # type check only
```

### Test coverage

```
core/         config, types, utils, health, logger, metrics   74 tests
trust/        trust-engine, injection-guard, rate-limiter     66 tests
security/     credential-proxy, mount-controller, sandbox     57 tests
admin/        command-handler                                 52 tests
channels/     adapters, channel-manager                       45 tests
db/           database operations                             41 tests
routing/      task-builder, group-queue                       38 tests
integration/  pipeline, session-runner, scheduler             38 tests
ingress/      normalizer                                      37 tests
memory/       memory-controller, session-memory               29 tests
execution/    container-backend, network-policy               29 tests
cli/          setup-wizard                                    26 tests
setup/        environment, platform, service, verify          26 tests
```

## Project Structure

```
secureclaw/
├── src/
│   ├── admin/           Admin command handler (!admin)
│   ├── audit/backend/   Audit interface + local SQLite backend
│   ├── channels/        WhatsApp, Telegram, Slack, Discord adapters + manager
│   ├── cli/             Setup wizard
│   ├── core/            Config, types, utils, entry, health, logger, metrics
│   ├── db/              SQLite database (WAL mode)
│   ├── execution/       Container backend + network policy
│   ├── ingress/         Message normalizer
│   ├── integration/     Message pipeline, session runner, scheduler
│   ├── memory/          Group memory (CLAUDE.md) + session lifecycle
│   ├── routing/         Task builder + group queue
│   ├── security/        Credential proxy, mount controller, sandbox validator
│   └── trust/           Trust engine, injection guard, rate limiter
├── setup/               Installation CLI steps
├── container/           Dockerfile + agent runner (ESM)
├── assets/              Logo and banner SVG
├── .github/workflows/   CI: typecheck + vitest
└── .claude/skills/      Claude Code skills
```

## License

MIT
