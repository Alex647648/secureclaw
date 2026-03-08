/**
 * 步骤：channel-auth — 多通道认证引导
 * 支持 WhatsApp QR / Telegram BotFather / Slack OAuth / Discord Bot Token
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { emitStatus } from './status.js';

interface ChannelAuthArgs {
  channel: 'whatsapp' | 'telegram' | 'slack' | 'discord';
  method?: string;       // whatsapp: qr-browser | pairing-code | qr-terminal
  phone?: string;        // whatsapp pairing-code 需要
  token?: string;        // telegram/discord bot token
  botToken?: string;     // slack bot token
  appToken?: string;     // slack app token
}

function parseArgs(args: string[]): ChannelAuthArgs {
  const result: ChannelAuthArgs = { channel: 'whatsapp' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--channel':
        result.channel = args[++i] as ChannelAuthArgs['channel'];
        break;
      case '--method':
        result.method = args[++i];
        break;
      case '--phone':
        result.phone = args[++i];
        break;
      case '--token':
        result.token = args[++i];
        break;
      case '--bot-token':
        result.botToken = args[++i];
        break;
      case '--app-token':
        result.appToken = args[++i];
        break;
    }
  }

  return result;
}

async function authWhatsApp(
  projectRoot: string,
  method: string,
  phone?: string,
): Promise<void> {
  const authDir = path.join(projectRoot, 'scdata', 'whatsapp-auth');
  fs.mkdirSync(authDir, { recursive: true });

  // WhatsApp 认证需要运行主程序的认证流程
  // 这里发射状态让 Skill 引导用户
  if (method === 'pairing-code' && !phone) {
    emitStatus('CHANNEL_AUTH', {
      CHANNEL: 'whatsapp',
      METHOD: method,
      STATUS: 'failed',
      ERROR: 'phone_required',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  emitStatus('CHANNEL_AUTH', {
    CHANNEL: 'whatsapp',
    METHOD: method,
    AUTH_DIR: authDir,
    ...(phone ? { PHONE: phone } : {}),
    STATUS: 'pending_user_action',
    INSTRUCTION: method === 'pairing-code'
      ? 'Use the pairing code displayed to link your device'
      : 'Scan the QR code with WhatsApp to authenticate',
    LOG: 'logs/setup.log',
  });
}

async function authTelegram(
  projectRoot: string,
  token: string,
): Promise<void> {
  if (!token) {
    emitStatus('CHANNEL_AUTH', {
      CHANNEL: 'telegram',
      STATUS: 'failed',
      ERROR: 'token_required',
      INSTRUCTION: 'Create a bot via @BotFather on Telegram and provide the token',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // 验证 token 格式（数字:字母数字）
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    emitStatus('CHANNEL_AUTH', {
      CHANNEL: 'telegram',
      STATUS: 'failed',
      ERROR: 'invalid_token_format',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // 写入环境变量文件
  updateEnvVar(projectRoot, 'TELEGRAM_BOT_TOKEN', token);

  emitStatus('CHANNEL_AUTH', {
    CHANNEL: 'telegram',
    TOKEN_SET: true,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function authSlack(
  projectRoot: string,
  botToken: string,
  appToken: string,
): Promise<void> {
  if (!botToken || !appToken) {
    emitStatus('CHANNEL_AUTH', {
      CHANNEL: 'slack',
      STATUS: 'failed',
      ERROR: 'tokens_required',
      INSTRUCTION: 'Slack requires both SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-)',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  if (!botToken.startsWith('xoxb-')) {
    emitStatus('CHANNEL_AUTH', {
      CHANNEL: 'slack',
      STATUS: 'failed',
      ERROR: 'invalid_bot_token',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  if (!appToken.startsWith('xapp-')) {
    emitStatus('CHANNEL_AUTH', {
      CHANNEL: 'slack',
      STATUS: 'failed',
      ERROR: 'invalid_app_token',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  updateEnvVar(projectRoot, 'SLACK_BOT_TOKEN', botToken);
  updateEnvVar(projectRoot, 'SLACK_APP_TOKEN', appToken);

  emitStatus('CHANNEL_AUTH', {
    CHANNEL: 'slack',
    BOT_TOKEN_SET: true,
    APP_TOKEN_SET: true,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function authDiscord(
  projectRoot: string,
  token: string,
): Promise<void> {
  if (!token) {
    emitStatus('CHANNEL_AUTH', {
      CHANNEL: 'discord',
      STATUS: 'failed',
      ERROR: 'token_required',
      INSTRUCTION: 'Create a bot at https://discord.com/developers/applications and provide the token',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  updateEnvVar(projectRoot, 'DISCORD_BOT_TOKEN', token);

  emitStatus('CHANNEL_AUTH', {
    CHANNEL: 'discord',
    TOKEN_SET: true,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// ── 工具函数 ────────────────────────────────────────────────────

function updateEnvVar(projectRoot: string, key: string, value: string): void {
  const envPath = path.join(projectRoot, 'secureclaw.env');

  if (fs.existsSync(envPath)) {
    let content = fs.readFileSync(envPath, 'utf-8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, content);
  } else {
    fs.writeFileSync(envPath, `${key}=${value}\n`);
  }
}

// ── 入口 ────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  switch (parsed.channel) {
    case 'whatsapp':
      await authWhatsApp(projectRoot, parsed.method || 'qr-browser', parsed.phone);
      break;
    case 'telegram':
      await authTelegram(projectRoot, parsed.token || '');
      break;
    case 'slack':
      await authSlack(projectRoot, parsed.botToken || '', parsed.appToken || '');
      break;
    case 'discord':
      await authDiscord(projectRoot, parsed.token || '');
      break;
    default:
      emitStatus('CHANNEL_AUTH', {
        STATUS: 'failed',
        ERROR: `unsupported_channel: ${parsed.channel}`,
        LOG: 'logs/setup.log',
      });
      process.exit(1);
  }
}
