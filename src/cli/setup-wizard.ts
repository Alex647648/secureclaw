// src/cli/setup-wizard.ts
// 交互式安装向导 — 首次运行配置生成器
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { SAFE_ID_PATTERN } from '../core/types';

// ── 配置结构 ───────────────────────────────────────────────────

export interface WizardAnswers {
  appName: string;
  triggerWord: string;
  timezone: string;
  runtime: 'apple' | 'docker';
  maxConcurrent: number;
  enableWhatsApp: boolean;
  enableTelegram: boolean;
  enableSlack: boolean;
  enableDiscord: boolean;
  adminGroupId: string;
  adminChannelId: string;
  adminSenderIds: string[];
  anthropicApiKey: string;
  telegramBotToken: string;
  slackBotToken: string;
  slackAppToken: string;
  discordBotToken: string;
}

// ── 默认值 ─────────────────────────────────────────────────────

const DEFAULTS: WizardAnswers = {
  appName: 'SecureClaw',
  triggerWord: '@SecureClaw',
  timezone: 'Asia/Shanghai',
  runtime: 'apple',
  maxConcurrent: 5,
  enableWhatsApp: true,
  enableTelegram: false,
  enableSlack: false,
  enableDiscord: false,
  adminGroupId: 'main',
  adminChannelId: '',
  adminSenderIds: [],
  anthropicApiKey: '',
  telegramBotToken: '',
  slackBotToken: '',
  slackAppToken: '',
  discordBotToken: '',
};

// ── 交互式输入 ─────────────────────────────────────────────────

export function createPrompter(): {
  ask: (question: string, defaultVal?: string) => Promise<string>;
  confirm: (question: string, defaultVal?: boolean) => Promise<boolean>;
  close: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    async ask(question: string, defaultVal?: string): Promise<string> {
      const suffix = defaultVal ? ` [${defaultVal}]` : '';
      return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || defaultVal || '');
        });
      });
    },

    async confirm(question: string, defaultVal = false): Promise<boolean> {
      const suffix = defaultVal ? ' [Y/n]' : ' [y/N]';
      return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
          const a = answer.trim().toLowerCase();
          if (!a) {
            resolve(defaultVal);
          } else {
            resolve(a === 'y' || a === 'yes');
          }
        });
      });
    },

    close() {
      rl.close();
    },
  };
}

// ── YAML 生成 ──────────────────────────────────────────────────

export function generateYaml(answers: WizardAnswers): string {
  const lines: string[] = [
    '# SecureClaw 配置文件',
    '# 由 setup wizard 自动生成',
    '',
    'app:',
    `  name: "${answers.appName}"`,
    `  trigger_word: "${answers.triggerWord}"`,
    `  timezone: "${answers.timezone}"`,
    '',
    'bootstrap:',
    `  admin_group_id: "${answers.adminGroupId}"`,
    `  admin_channel_id: "${answers.adminChannelId}"`,
    `  admin_sender_ids:`,
  ];

  if (answers.adminSenderIds.length === 0) {
    lines.push('    []');
  } else {
    for (const id of answers.adminSenderIds) {
      lines.push(`    - "${id}"`);
    }
  }

  lines.push(
    '',
    'container:',
    `  runtime: "${answers.runtime}"`,
    '  image: "secureclaw-agent:latest"',
    '  timeout_ms: 1800000',
    `  max_concurrent: ${answers.maxConcurrent}`,
    '',
    'channels:',
    '  whatsapp:',
    `    enabled: ${answers.enableWhatsApp}`,
    '    auth_dir: "scdata/whatsapp-auth"',
    '  telegram:',
    `    enabled: ${answers.enableTelegram}`,
    '    bot_token: ""',
    '  slack:',
    `    enabled: ${answers.enableSlack}`,
    '    bot_token: ""',
    '    app_token: ""',
    '  discord:',
    `    enabled: ${answers.enableDiscord}`,
    '    bot_token: ""',
    '',
    'security:',
    '  max_injection_score: 0.75',
    '  credential_proxy:',
    '    socket_dir: "/tmp/secureclaw-creds"',
    '    max_requests_per_session: 3',
    '',
    'db:',
    '  path: "scdata/secureclaw.db"',
    '',
    'logging:',
    '  level: "info"',
    '',
  );

  return lines.join('\n');
}

// ── ENV 文件生成 ────────────────────────────────────────────────

export function generateEnv(answers: WizardAnswers): string {
  const lines: string[] = [
    '# SecureClaw 环境变量',
    '# 由 setup wizard 自动生成',
    '# 敏感凭证存储在此文件中，请勿提交到版本控制',
    '',
  ];

  if (answers.anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY="${answers.anthropicApiKey}"`);
  } else {
    lines.push('# ANTHROPIC_API_KEY=""');
  }

  if (answers.enableTelegram && answers.telegramBotToken) {
    lines.push(`TELEGRAM_BOT_TOKEN="${answers.telegramBotToken}"`);
  }

  if (answers.enableSlack) {
    if (answers.slackBotToken) {
      lines.push(`SLACK_BOT_TOKEN="${answers.slackBotToken}"`);
    }
    if (answers.slackAppToken) {
      lines.push(`SLACK_APP_TOKEN="${answers.slackAppToken}"`);
    }
  }

  if (answers.enableDiscord && answers.discordBotToken) {
    lines.push(`DISCORD_BOT_TOKEN="${answers.discordBotToken}"`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── 验证 ───────────────────────────────────────────────────────

export function validateAnswers(answers: WizardAnswers): string[] {
  const errors: string[] = [];

  if (!SAFE_ID_PATTERN.test(answers.adminGroupId)) {
    errors.push(`admin_group_id "${answers.adminGroupId}" 不符合 SAFE_ID_PATTERN`);
  }

  if (!answers.adminChannelId) {
    errors.push('admin_channel_id 不能为空');
  }

  if (answers.adminSenderIds.length === 0) {
    errors.push('至少需要一个管理员 sender ID');
  }

  if (!answers.anthropicApiKey) {
    errors.push('ANTHROPIC_API_KEY 未设置（容器执行需要此密钥）');
  }

  if (answers.enableTelegram && !answers.telegramBotToken) {
    errors.push('Telegram 已启用但 bot token 未设置');
  }

  if (answers.enableSlack && (!answers.slackBotToken || !answers.slackAppToken)) {
    errors.push('Slack 已启用但 bot token 或 app token 未设置');
  }

  if (answers.enableDiscord && !answers.discordBotToken) {
    errors.push('Discord 已启用但 bot token 未设置');
  }

  const enabledChannels = [
    answers.enableWhatsApp,
    answers.enableTelegram,
    answers.enableSlack,
    answers.enableDiscord,
  ].filter(Boolean);

  if (enabledChannels.length === 0) {
    errors.push('至少需要启用一个通道');
  }

  return errors;
}

// ── 写入文件 ───────────────────────────────────────────────────

export function writeConfigFiles(
  projectRoot: string,
  answers: WizardAnswers,
): { yamlPath: string; envPath: string } {
  const yamlPath = path.join(projectRoot, 'secureclaw.yaml');
  const envPath = path.join(projectRoot, 'secureclaw.env');

  // 创建数据目录
  fs.mkdirSync(path.join(projectRoot, 'scdata'), { recursive: true, mode: 0o700 });

  // 写入 YAML（可公开的配置）
  fs.writeFileSync(yamlPath, generateYaml(answers), 'utf8');

  // 写入 ENV（敏感凭证，限制权限）
  fs.writeFileSync(envPath, generateEnv(answers), { encoding: 'utf8', mode: 0o600 });

  return { yamlPath, envPath };
}

// ── 向导主流程 ─────────────────────────────────────────────────

export async function runWizard(projectRoot: string): Promise<WizardAnswers> {
  const prompter = createPrompter();

  try {
    console.log('\n=== SecureClaw Setup Wizard ===\n');

    // 基本配置
    const appName = await prompter.ask('应用名称', DEFAULTS.appName);
    const triggerWord = await prompter.ask('触发词（消息前缀）', DEFAULTS.triggerWord);
    const timezone = await prompter.ask('时区', DEFAULTS.timezone);

    // 容器运行时
    const runtimeStr = await prompter.ask('容器运行时 (apple/docker)', DEFAULTS.runtime);
    const runtime = runtimeStr === 'docker' ? 'docker' : 'apple';
    const maxConcurrentStr = await prompter.ask('最大并发容器数', String(DEFAULTS.maxConcurrent));
    const maxConcurrent = parseInt(maxConcurrentStr, 10) || DEFAULTS.maxConcurrent;

    // 通道选择
    console.log('\n--- 通道配置 ---');
    const enableWhatsApp = await prompter.confirm('启用 WhatsApp?', true);
    const enableTelegram = await prompter.confirm('启用 Telegram?', false);
    const enableSlack = await prompter.confirm('启用 Slack?', false);
    const enableDiscord = await prompter.confirm('启用 Discord?', false);

    // 通道 Token
    let telegramBotToken = '';
    let slackBotToken = '';
    let slackAppToken = '';
    let discordBotToken = '';

    if (enableTelegram) {
      telegramBotToken = await prompter.ask('Telegram Bot Token');
    }
    if (enableSlack) {
      slackBotToken = await prompter.ask('Slack Bot Token (xoxb-...)');
      slackAppToken = await prompter.ask('Slack App Token (xapp-...)');
    }
    if (enableDiscord) {
      discordBotToken = await prompter.ask('Discord Bot Token');
    }

    // 管理员配置
    console.log('\n--- 管理员配置 ---');
    const adminGroupId = await prompter.ask('管理员 Group ID', DEFAULTS.adminGroupId);

    let channelHint = '';
    if (enableWhatsApp) channelHint = '（WhatsApp JID，如 120363027788@g.us）';
    else if (enableTelegram) channelHint = '（Telegram Chat ID，如 -1001234567890）';
    else if (enableSlack) channelHint = '（Slack Channel ID，如 C01ABCDEF）';
    else if (enableDiscord) channelHint = '（Discord Channel ID）';

    const adminChannelId = await prompter.ask(`管理员通道 ID${channelHint}`);
    const adminSenderIdsStr = await prompter.ask('管理员 Sender IDs（逗号分隔）');
    const adminSenderIds = adminSenderIdsStr
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // API Key
    console.log('\n--- API 密钥 ---');
    const anthropicApiKey = await prompter.ask('Anthropic API Key (sk-ant-...)');

    const answers: WizardAnswers = {
      appName, triggerWord, timezone,
      runtime, maxConcurrent,
      enableWhatsApp, enableTelegram, enableSlack, enableDiscord,
      adminGroupId, adminChannelId, adminSenderIds,
      anthropicApiKey,
      telegramBotToken, slackBotToken, slackAppToken, discordBotToken,
    };

    // 验证
    const errors = validateAnswers(answers);
    if (errors.length > 0) {
      console.log('\n[!] 配置警告:');
      for (const err of errors) {
        console.log(`  - ${err}`);
      }
      const proceed = await prompter.confirm('\n是否继续生成配置?', false);
      if (!proceed) {
        console.log('已取消。');
        process.exit(1);
      }
    }

    // 写入文件
    const { yamlPath, envPath } = writeConfigFiles(projectRoot, answers);

    console.log('\n[OK] 配置文件已生成:');
    console.log(`  ${yamlPath}`);
    console.log(`  ${envPath}`);
    console.log('\n提示: secureclaw.env 包含敏感凭证，已设置 0600 权限，请勿提交到 Git。');
    console.log('运行 `npm start` 启动 SecureClaw。\n');

    return answers;
  } finally {
    prompter.close();
  }
}

// ── CLI 入口 ──────────────────────────────────────────────────

export async function main(): Promise<void> {
  const projectRoot = process.cwd();

  // 检查是否已配置
  const yamlPath = path.join(projectRoot, 'secureclaw.yaml');
  if (fs.existsSync(yamlPath)) {
    const prompter = createPrompter();
    const overwrite = await prompter.confirm('secureclaw.yaml 已存在，是否覆盖?', false);
    prompter.close();
    if (!overwrite) {
      console.log('已取消。');
      return;
    }
  }

  await runWizard(projectRoot);
}

// 直接运行时执行
if (require.main === module) {
  main().catch((err) => {
    console.error('Setup error:', err.message);
    process.exit(1);
  });
}
