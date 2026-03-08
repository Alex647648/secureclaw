---
name: setup
description: Run initial SecureClaw setup. Use when user wants to install dependencies, configure channels, register groups, or start services. Triggers on "setup", "install", "configure secureclaw", or first-time setup requests.
---

# SecureClaw Setup

Run setup steps automatically. Only pause when user action is required (WhatsApp QR, pasting tokens, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. scanning a QR code, pasting a secret token).

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` or nvm
  - Linux: nodesource or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools.
- If NATIVE_OK=false → better-sqlite3 failed. Install build tools and retry.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → note that channel auth exists, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 3. Container Runtime

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>`.

### Choose runtime:
- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → AskUserQuestion: Docker or Apple Container?
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### Install if needed:
- DOCKER=running → continue
- DOCKER=installed_not_running → start Docker
- DOCKER=not_found → AskUserQuestion: install Docker?

### Build and test:
- If BUILD_OK=false → check `logs/setup.log`, try `docker builder prune -f` and retry
- If TEST_OK=false but BUILD_OK=true → runtime not fully started, wait and retry

## 4. Claude API Key

Run `npx tsx setup/index.ts --step credentials -- --verify` to check current state.

If no key: AskUserQuestion for ANTHROPIC_API_KEY. Then:
```bash
npx tsx setup/index.ts --step credentials -- --key <key>
```

## 5. Channel Authentication

AskUserQuestion: Which channel? (WhatsApp / Telegram / Slack / Discord)

### WhatsApp
```bash
npx tsx setup/index.ts --step channel-auth -- --channel whatsapp --method <qr-browser|pairing-code|qr-terminal> [--phone NUMBER]
```

### Telegram
Ask for BotFather token:
```bash
npx tsx setup/index.ts --step channel-auth -- --channel telegram --token <TOKEN>
```

### Slack
Ask for bot token (xoxb-) and app token (xapp-):
```bash
npx tsx setup/index.ts --step channel-auth -- --channel slack --bot-token <BOT_TOKEN> --app-token <APP_TOKEN>
```

### Discord
Ask for bot token:
```bash
npx tsx setup/index.ts --step channel-auth -- --channel discord --token <TOKEN>
```

## 6. Register Admin Group

AskUserQuestion for: group ID, channel ID, trigger word, assistant name.

```bash
npx tsx setup/index.ts --step register -- \
  --group-id main \
  --channel-id "120363xxx@g.us" \
  --channel-type whatsapp \
  --admin-sender "xxx@s.whatsapp.net" \
  --trigger "@SecureClaw" \
  --assistant-name "SecureClaw"
```

## 7. Start Service

```bash
npx tsx setup/index.ts --step service
```

- If FALLBACK=wsl_no_systemd → tell user about `start-secureclaw.sh` wrapper
- If DOCKER_GROUP_STALE=true → guide user through `setfacl` fix
- If SERVICE_LOADED=false → check `logs/secureclaw.error.log`

## 8. Verify

```bash
npx tsx setup/index.ts --step verify
```

Fix each failing check:
- SERVICE=stopped → restart service
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4
- CHANNEL_AUTH=not_found → re-run step 5
- REGISTERED_GROUPS=0 → re-run step 6
- CONTAINER_RUNTIME=none → re-run step 3

Tell user to test by sending a message in their registered channel. Show: `tail -f logs/secureclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/secureclaw.error.log`. Common: wrong Node path, missing env, missing auth.

**Container agent fails:** Ensure container runtime is running. Check `groups/main/logs/`.

**No response to messages:** Check trigger pattern. Check DB with verify step. Check logs.
