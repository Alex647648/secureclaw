// src/cli/setup-wizard.test.ts
// Setup Wizard 配置生成器测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateYaml,
  generateEnv,
  validateAnswers,
  writeConfigFiles,
  type WizardAnswers,
} from './setup-wizard';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-wizard-test-' + Date.now());

function makeAnswers(overrides?: Partial<WizardAnswers>): WizardAnswers {
  return {
    appName: 'TestClaw',
    triggerWord: '@Bot',
    timezone: 'UTC',
    runtime: 'apple',
    maxConcurrent: 3,
    enableWhatsApp: true,
    enableTelegram: false,
    enableSlack: false,
    enableDiscord: false,
    adminGroupId: 'main',
    adminChannelId: '12345@g.us',
    adminSenderIds: ['admin-1@s.whatsapp.net'],
    anthropicApiKey: 'sk-ant-test-key',
    telegramBotToken: '',
    slackBotToken: '',
    slackAppToken: '',
    discordBotToken: '',
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── YAML 生成 ─────────────────────────────────────────────────────

describe('generateYaml', () => {
  it('should generate valid YAML structure', () => {
    const yaml = generateYaml(makeAnswers());
    expect(yaml).toContain('app:');
    expect(yaml).toContain('name: "TestClaw"');
    expect(yaml).toContain('trigger_word: "@Bot"');
    expect(yaml).toContain('timezone: "UTC"');
    expect(yaml).toContain('bootstrap:');
    expect(yaml).toContain('admin_group_id: "main"');
    expect(yaml).toContain('admin_channel_id: "12345@g.us"');
    expect(yaml).toContain('container:');
    expect(yaml).toContain('runtime: "apple"');
    expect(yaml).toContain('max_concurrent: 3');
    expect(yaml).toContain('channels:');
    expect(yaml).toContain('whatsapp:');
    expect(yaml).toContain('enabled: true');
    expect(yaml).toContain('security:');
    expect(yaml).toContain('db:');
  });

  it('should list admin sender IDs', () => {
    const yaml = generateYaml(makeAnswers({
      adminSenderIds: ['user-1', 'user-2'],
    }));
    expect(yaml).toContain('- "user-1"');
    expect(yaml).toContain('- "user-2"');
  });

  it('should handle empty admin sender IDs', () => {
    const yaml = generateYaml(makeAnswers({ adminSenderIds: [] }));
    expect(yaml).toContain('[]');
  });

  it('should set channel enabled flags', () => {
    const yaml = generateYaml(makeAnswers({
      enableWhatsApp: false,
      enableTelegram: true,
      enableSlack: true,
      enableDiscord: false,
    }));
    // whatsapp disabled
    expect(yaml).toMatch(/whatsapp:\s*\n\s*enabled: false/);
    // telegram enabled
    expect(yaml).toMatch(/telegram:\s*\n\s*enabled: true/);
    // slack enabled
    expect(yaml).toMatch(/slack:\s*\n\s*enabled: true/);
    // discord disabled
    expect(yaml).toMatch(/discord:\s*\n\s*enabled: false/);
  });

  it('should use docker runtime when specified', () => {
    const yaml = generateYaml(makeAnswers({ runtime: 'docker' }));
    expect(yaml).toContain('runtime: "docker"');
  });
});

// ── ENV 生成 ──────────────────────────────────────────────────────

describe('generateEnv', () => {
  it('should include API key', () => {
    const env = generateEnv(makeAnswers());
    expect(env).toContain('ANTHROPIC_API_KEY="sk-ant-test-key"');
  });

  it('should comment out missing API key', () => {
    const env = generateEnv(makeAnswers({ anthropicApiKey: '' }));
    expect(env).toContain('# ANTHROPIC_API_KEY=""');
  });

  it('should include Telegram token when enabled', () => {
    const env = generateEnv(makeAnswers({
      enableTelegram: true,
      telegramBotToken: 'tg-token-123',
    }));
    expect(env).toContain('TELEGRAM_BOT_TOKEN="tg-token-123"');
  });

  it('should not include Telegram token when disabled', () => {
    const env = generateEnv(makeAnswers({
      enableTelegram: false,
      telegramBotToken: 'tg-token-123',
    }));
    expect(env).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('should include Slack tokens when enabled', () => {
    const env = generateEnv(makeAnswers({
      enableSlack: true,
      slackBotToken: 'xoxb-123',
      slackAppToken: 'xapp-456',
    }));
    expect(env).toContain('SLACK_BOT_TOKEN="xoxb-123"');
    expect(env).toContain('SLACK_APP_TOKEN="xapp-456"');
  });

  it('should include Discord token when enabled', () => {
    const env = generateEnv(makeAnswers({
      enableDiscord: true,
      discordBotToken: 'dc-token-789',
    }));
    expect(env).toContain('DISCORD_BOT_TOKEN="dc-token-789"');
  });

  it('should not include disabled channel tokens', () => {
    const env = generateEnv(makeAnswers({
      enableSlack: false,
      slackBotToken: 'xoxb-123',
      slackAppToken: 'xapp-456',
      enableDiscord: false,
      discordBotToken: 'dc-token',
    }));
    expect(env).not.toContain('SLACK_BOT_TOKEN');
    expect(env).not.toContain('SLACK_APP_TOKEN');
    expect(env).not.toContain('DISCORD_BOT_TOKEN');
  });
});

// ── 验证 ──────────────────────────────────────────────────────────

describe('validateAnswers', () => {
  it('should pass valid answers', () => {
    const errors = validateAnswers(makeAnswers());
    expect(errors).toHaveLength(0);
  });

  it('should reject invalid admin group id', () => {
    const errors = validateAnswers(makeAnswers({ adminGroupId: 'bad id!' }));
    expect(errors.some(e => e.includes('SAFE_ID_PATTERN'))).toBe(true);
  });

  it('should reject empty admin channel id', () => {
    const errors = validateAnswers(makeAnswers({ adminChannelId: '' }));
    expect(errors.some(e => e.includes('admin_channel_id'))).toBe(true);
  });

  it('should reject empty admin sender ids', () => {
    const errors = validateAnswers(makeAnswers({ adminSenderIds: [] }));
    expect(errors.some(e => e.includes('管理员 sender ID'))).toBe(true);
  });

  it('should warn about missing API key', () => {
    const errors = validateAnswers(makeAnswers({ anthropicApiKey: '' }));
    expect(errors.some(e => e.includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('should warn about Telegram enabled without token', () => {
    const errors = validateAnswers(makeAnswers({
      enableTelegram: true,
      telegramBotToken: '',
    }));
    expect(errors.some(e => e.includes('Telegram'))).toBe(true);
  });

  it('should warn about Slack enabled without tokens', () => {
    const errors = validateAnswers(makeAnswers({
      enableSlack: true,
      slackBotToken: '',
      slackAppToken: '',
    }));
    expect(errors.some(e => e.includes('Slack'))).toBe(true);
  });

  it('should warn about Discord enabled without token', () => {
    const errors = validateAnswers(makeAnswers({
      enableDiscord: true,
      discordBotToken: '',
    }));
    expect(errors.some(e => e.includes('Discord'))).toBe(true);
  });

  it('should warn about no enabled channels', () => {
    const errors = validateAnswers(makeAnswers({
      enableWhatsApp: false,
      enableTelegram: false,
      enableSlack: false,
      enableDiscord: false,
    }));
    expect(errors.some(e => e.includes('至少需要启用一个通道'))).toBe(true);
  });

  it('should allow multiple errors', () => {
    const errors = validateAnswers(makeAnswers({
      adminGroupId: 'bad id!',
      adminChannelId: '',
      adminSenderIds: [],
      anthropicApiKey: '',
    }));
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ── 文件写入 ──────────────────────────────────────────────────────

describe('writeConfigFiles', () => {
  it('should create yaml and env files', () => {
    const answers = makeAnswers();
    const { yamlPath, envPath } = writeConfigFiles(tmpDir, answers);

    expect(fs.existsSync(yamlPath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);

    const yamlContent = fs.readFileSync(yamlPath, 'utf8');
    expect(yamlContent).toContain('name: "TestClaw"');

    const envContent = fs.readFileSync(envPath, 'utf8');
    expect(envContent).toContain('ANTHROPIC_API_KEY');
  });

  it('should create scdata directory', () => {
    writeConfigFiles(tmpDir, makeAnswers());
    const scdata = path.join(tmpDir, 'scdata');
    expect(fs.existsSync(scdata)).toBe(true);
  });

  it('should set env file permissions to 0600', () => {
    const { envPath } = writeConfigFiles(tmpDir, makeAnswers());
    const stat = fs.statSync(envPath);
    // 检查权限（octal mode，忽略文件类型位）
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('should overwrite existing files', () => {
    // 第一次写入
    writeConfigFiles(tmpDir, makeAnswers({ appName: 'First' }));
    // 第二次覆盖
    const { yamlPath } = writeConfigFiles(tmpDir, makeAnswers({ appName: 'Second' }));

    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('name: "Second"');
    expect(content).not.toContain('name: "First"');
  });
});
