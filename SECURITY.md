# Security Policy

## Reporting Vulnerabilities

**Critical vulnerabilities** (credential exposure, container escape, remote code execution): Contact the maintainer directly via email. Do not open a public issue.

**Non-critical vulnerabilities** (information disclosure, DoS, minor injection vectors): Open a [Security Report issue](.github/ISSUE_TEMPLATE/security_report.md).

We aim to acknowledge reports within 48 hours and provide a fix or mitigation within 7 days.

## Security Model

### 6-Layer Architecture

| Layer | Component | Threat Mitigated |
|-------|-----------|------------------|
| Ingress | `normalizer.ts` | Malformed input, oversized messages |
| Trust | `trust-engine.ts`, `injection-guard.ts`, `rate-limiter.ts` | Prompt injection, abuse, DoS |
| Router | `task-builder.ts`, `group-queue.ts` | Unauthorized task execution |
| Execution | `container-backend.ts`, `network-policy.ts` | Container escape, network exfiltration |
| Memory | `session-memory.ts`, `memory-controller.ts` | Cross-session data leakage |
| Audit | `local-audit.ts` | Log tampering, accountability |

### Credential Isolation

- API keys are stored in a process closure — never serialized or logged
- Distribution via Unix socket with per-session 256-bit tokens
- Timing-safe comparison prevents side-channel attacks
- Per-session request limit (default: 3) prevents brute-force

### Container Sandboxing

- Each agent task runs in an isolated container (`sclaw-${taskId}`)
- Non-root user (`node`) inside containers
- Resource limits: memory and CPU caps per policy
- Network policy presets:
  - `isolated`: `--network none`
  - `claude_only`: HTTPS proxy to Claude API only
  - `trusted`: Unrestricted (for trusted groups)
  - `open`: Unrestricted (for admin groups)

### Trust Model

- Senders start as `UNTRUSTED` by default
- Trust levels: `UNTRUSTED → TRUSTED → ADMIN` (and `BLOCKED` for banned senders)
- Admin senders configured in `secureclaw.yaml` bootstrap section
- Injection guard scores messages on a 0.0–1.0 scale
- Messages above `max_injection_score` (default: 0.75) are blocked

## Known Limitations

1. **Single-process credential proxy**: If the main process crashes, all active sessions lose access. Restart recovers automatically.

2. **WhatsApp E2E encryption**: Messages are decrypted at the baileys layer before processing. The agent sees plaintext.

3. **Container runtime trust**: We trust the container runtime (Docker/Apple Container) for isolation. A compromised runtime would break the sandbox.

4. **Prompt injection is heuristic**: The injection guard uses pattern matching and scoring. Sophisticated attacks may bypass detection. Defense in depth (container isolation + capability restrictions) provides secondary protection.

5. **Audit log on local filesystem**: HMAC integrity protects against tampering, but an attacker with root access to the host could delete the log file. For high-security deployments, forward audit events to an external SIEM.

## Secure Development Practices

- All user input validated at system boundaries
- Parameterized queries for all database operations
- No secrets in source code or logs
- Container names validated against `SAFE_ID_PATTERN`
- Socket files created with mode `0o600`
- Credential socket directory created with mode `0o700`
