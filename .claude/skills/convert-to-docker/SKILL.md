---
name: convert-to-docker
description: Switch SecureClaw container runtime between Docker and Apple Container. Use when user wants to change the container runtime.
---

# Convert Container Runtime

Switch SecureClaw between Docker and Apple Container (macOS only).

## When to Use

- User wants to switch from Apple Container to Docker (or vice versa)
- Setting up on a new machine with a different runtime
- Troubleshooting container issues by switching runtimes

## Steps

### 1. Check Current Runtime

Read `secureclaw.yaml` and check the `container.runtime` field:
```bash
grep 'runtime:' secureclaw.yaml
```

### 2. Verify Target Runtime is Available

**For Docker:**
```bash
docker info
```
If not installed, guide user through Docker installation.

**For Apple Container (macOS only):**
```bash
container --version
```
If not available, this runtime is not supported on the current platform.

### 3. Update Configuration

Edit `secureclaw.yaml`:
```yaml
container:
  runtime: "docker"   # or "apple"
```

### 4. Rebuild Container Image

```bash
CONTAINER_RUNTIME=docker ./container/build.sh    # for Docker
CONTAINER_RUNTIME=container ./container/build.sh  # for Apple Container
```

### 5. Restart Service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.secureclaw

# Linux
systemctl --user restart secureclaw
```

### 6. Verify

```bash
npx tsx setup/index.ts --step verify
```

## Notes

- Apple Container is macOS-only (uses native virtualization)
- Docker works on macOS, Linux, and WSL
- The agent container image (`secureclaw-agent:latest`) must be rebuilt after switching
- Running containers will be terminated during the switch
