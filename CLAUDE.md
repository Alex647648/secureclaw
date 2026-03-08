# SecureClaw

Enterprise AI Agent security framework. See [README.md](README.md) for architecture and setup.

## Quick Context

Single Node.js process (CommonJS) that connects to messaging channels, routes messages through 6 security layers, and runs Claude Code agents in isolated containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/core/index.ts` | 18-step init, full orchestration |
| `src/core/config.ts` | YAML + env config loading |
| `src/core/types.ts` | All type definitions |
| `src/channels/channel-manager.ts` | Multi-channel adapter management |
| `src/integration/message-pipeline.ts` | Ingress → trust → route → execute |
| `src/integration/session-runner.ts` | Session lifecycle management |
| `src/integration/scheduler.ts` | Cron-based task scheduling |
| `src/execution/container-backend.ts` | Container spawning with markers |
| `src/security/credential-proxy.ts` | API Key isolation via Unix socket |
| `src/trust/trust-engine.ts` | Per-sender trust levels |
| `src/trust/injection-guard.ts` | Prompt injection detection |
| `src/db/db.ts` | SQLite with WAL mode |
| `groups/{name}/CLAUDE.md` | Per-group agent memory |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/add-gmail` | Phase 2 Gmail integration (placeholder) |
| `/convert-to-docker` | Switch container runtime |

## Development

```bash
npm run dev          # Hot reload with tsx
npm run build        # Compile TypeScript
npm test             # Run vitest
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.secureclaw.plist
launchctl unload ~/Library/LaunchAgents/com.secureclaw.plist
launchctl kickstart -k gui/$(id -u)/com.secureclaw

# Linux (systemd)
systemctl --user start secureclaw
systemctl --user stop secureclaw
systemctl --user restart secureclaw
```

## Conventions

- `SC_` env prefix, `sc_` DB table prefix, `sclaw-` container prefix
- `SAFE_ID_PATTERN`: `/^[a-zA-Z0-9_-]{1,64}$/` for all IDs
- Rate limit: 30 msgs/min per sender
- Credential proxy: Unix socket, 256-bit token, max 3 req/session
- Container naming: `sclaw-${taskId}`
- CommonJS in `src/`, ESM in `container/agent-runner/`
- Chinese comments in source code
