---
name: add-gmail
description: Add Gmail integration to SecureClaw. Can be configured as a tool (agent reads/sends emails when triggered) or as a full channel (emails trigger the agent). Phase 2 placeholder.
---

# Add Gmail to SecureClaw

> **Status:** Phase 2 placeholder. This skill will be fully implemented in a future release.

## Overview

Gmail integration can work in two modes:

1. **Tool mode**: The agent can read/send emails when triggered from another channel (WhatsApp, Telegram, etc.)
2. **Channel mode**: Incoming emails trigger the agent directly, and replies are sent as emails

## Prerequisites

- Google Cloud Platform project with Gmail API enabled
- OAuth 2.0 credentials (client ID + secret)
- User consent for Gmail scopes

## Implementation Plan

When this skill is activated, it will:

1. Guide through GCP OAuth setup
2. Create `src/channels/gmail-adapter.ts` implementing the `ChannelAdapter` interface
3. Add Gmail OAuth token refresh logic
4. Wire into `channel-manager.ts`
5. Add Gmail-specific configuration to `secureclaw.yaml`

## Current Status

This skill is a placeholder. The SecureClaw channel adapter interface (`src/channels/interface.ts`) is ready to support Gmail as a new adapter.
