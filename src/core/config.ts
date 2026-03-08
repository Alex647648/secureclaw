// src/core/config.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ── AppConfig 接口 ──────────────────────────────────────────────

export interface AppConfig {
  app: {
    name: string;
    triggerWord: string;
    timezone: string;
  };
  bootstrap: {
    adminGroupId: string;
    adminChannelId: string;
    adminSenderIds: string[];
  };
  container: {
    runtime: 'apple' | 'docker';
    image: string;
    timeoutMs: number;
    maxConcurrent: number;
  };
  channels: {
    whatsapp: {
      enabled: boolean;
      authDir: string;
    };
    telegram: {
      enabled: boolean;
      botToken: string;
    };
    slack: {
      enabled: boolean;
      botToken: string;
      appToken: string;
    };
    discord: {
      enabled: boolean;
      botToken: string;
    };
  };
  security: {
    maxInjectionScore: number;
    credProxy: {
      socketDir: string;
      maxRequestsPerSession: number;
    };
  };
  db: {
    path: string;
  };
  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
    prettyPrint: boolean;
  };
  anthropicApiKey: string;
}

// ── Zod Schema ──────────────────────────────────────────────────

const configSchema = z.object({
  app: z.object({
    name: z.string().default('SecureClaw'),
    trigger_word: z.string().default('@SecureClaw'),
    timezone: z.string().default('Asia/Shanghai'),
  }).default({}),
  bootstrap: z.object({
    admin_group_id: z.string().default('main'),
    admin_channel_id: z.string().default(''),
    admin_sender_ids: z.array(z.string()).default([]),
  }).default({}),
  container: z.object({
    runtime: z.enum(['apple', 'docker']).default('apple'),
    image: z.string().default('secureclaw-agent:latest'),
    timeout_ms: z.number().positive().default(1800000),
    max_concurrent: z.number().int().positive().default(5),
  }).default({}),
  channels: z.object({
    whatsapp: z.object({
      enabled: z.boolean().default(true),
      auth_dir: z.string().default('scdata/whatsapp-auth'),
    }).default({}),
    telegram: z.object({
      enabled: z.boolean().default(false),
      bot_token: z.string().default(''),
    }).default({}),
    slack: z.object({
      enabled: z.boolean().default(false),
      bot_token: z.string().default(''),
      app_token: z.string().default(''),
    }).default({}),
    discord: z.object({
      enabled: z.boolean().default(false),
      bot_token: z.string().default(''),
    }).default({}),
  }).default({}),
  security: z.object({
    max_injection_score: z.number().min(0).max(1).default(0.75),
    credential_proxy: z.object({
      socket_dir: z.string().default('/tmp/secureclaw-creds'),
      max_requests_per_session: z.number().int().positive().default(3),
    }).default({}),
  }).default({}),
  db: z.object({
    path: z.string().default('scdata/secureclaw.db'),
  }).default({}),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    audit_file: z.string().default('scdata/audit.log'),
  }).default({}),
});

// ── 加载逻辑 ────────────────────────────────────────────────────

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 去除引号包裹
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(configPath?: string): AppConfig {
  const projectRoot = path.resolve(process.cwd());

  // 加载 secureclaw.env（不覆盖已有环境变量）
  loadEnvFile(path.join(projectRoot, 'secureclaw.env'));

  // 加载 YAML 配置
  const yamlPath = configPath ?? path.join(projectRoot, 'secureclaw.yaml');
  let rawConfig: Record<string, unknown> = {};
  if (fs.existsSync(yamlPath)) {
    const yamlContent = fs.readFileSync(yamlPath, 'utf8');
    rawConfig = parseYaml(yamlContent) ?? {};
  }

  // 验证并应用默认值
  const parsed = configSchema.parse(rawConfig);

  // 环境变量覆盖通道 token
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN || parsed.channels.telegram.bot_token;
  const slackBotToken = process.env.SLACK_BOT_TOKEN || parsed.channels.slack.bot_token;
  const slackAppToken = process.env.SLACK_APP_TOKEN || parsed.channels.slack.app_token;
  const discordToken = process.env.DISCORD_BOT_TOKEN || parsed.channels.discord.bot_token;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';

  // ANTHROPIC_API_KEY 必须设置（容器内 Agent 运行必需）
  if (!anthropicApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required but not set.\n' +
      'Set it in secureclaw.env or as an environment variable.'
    );
  }

  // 通道 token 验证：启用的通道必须有对应 token
  if (parsed.channels.telegram.enabled && !telegramToken) {
    throw new Error('telegram.enabled is true but TELEGRAM_BOT_TOKEN is not set');
  }
  if (parsed.channels.slack.enabled && (!slackBotToken || !slackAppToken)) {
    throw new Error('slack.enabled is true but SLACK_BOT_TOKEN or SLACK_APP_TOKEN is not set');
  }
  if (parsed.channels.discord.enabled && !discordToken) {
    throw new Error('discord.enabled is true but DISCORD_BOT_TOKEN is not set');
  }

  return {
    app: {
      name: parsed.app.name,
      triggerWord: parsed.app.trigger_word,
      timezone: parsed.app.timezone,
    },
    bootstrap: {
      adminGroupId: parsed.bootstrap.admin_group_id,
      adminChannelId: parsed.bootstrap.admin_channel_id,
      adminSenderIds: parsed.bootstrap.admin_sender_ids,
    },
    container: {
      runtime: parsed.container.runtime,
      image: parsed.container.image,
      timeoutMs: parsed.container.timeout_ms,
      maxConcurrent: parsed.container.max_concurrent,
    },
    channels: {
      whatsapp: {
        enabled: parsed.channels.whatsapp.enabled,
        authDir: parsed.channels.whatsapp.auth_dir,
      },
      telegram: {
        enabled: parsed.channels.telegram.enabled,
        botToken: telegramToken,
      },
      slack: {
        enabled: parsed.channels.slack.enabled,
        botToken: slackBotToken,
        appToken: slackAppToken,
      },
      discord: {
        enabled: parsed.channels.discord.enabled,
        botToken: discordToken,
      },
    },
    security: {
      maxInjectionScore: parsed.security.max_injection_score,
      credProxy: {
        socketDir: parsed.security.credential_proxy.socket_dir,
        maxRequestsPerSession: parsed.security.credential_proxy.max_requests_per_session,
      },
    },
    db: {
      path: parsed.db.path,
    },
    log: {
      level: parsed.logging.level,
      prettyPrint: process.env.NODE_ENV !== 'production',
    },
    anthropicApiKey,
  };
}
