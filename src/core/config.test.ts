// src/core/config.test.ts
// 测试：配置加载、env 解析、通道验证、默认值
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from './config';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-config-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  // 设置必需的环境变量（测试用 dummy 值）
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy';
  // 清除可能影响的通道 token
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
});

describe('loadConfig', () => {
  it('should load with defaults when no config file exists', () => {
    const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
    expect(config.app.name).toBe('SecureClaw');
    expect(config.app.triggerWord).toBe('@SecureClaw');
    expect(config.container.runtime).toBe('apple');
    expect(config.security.maxInjectionScore).toBe(0.75);
    expect(config.db.path).toBe('scdata/secureclaw.db');
  });

  it('should load from YAML file', () => {
    const yamlPath = path.join(tmpDir, 'test.yaml');
    fs.writeFileSync(yamlPath, `
app:
  name: "TestClaw"
  trigger_word: "@Bot"
container:
  runtime: "docker"
  max_concurrent: 3
`);
    const config = loadConfig(yamlPath);
    expect(config.app.name).toBe('TestClaw');
    expect(config.app.triggerWord).toBe('@Bot');
    expect(config.container.runtime).toBe('docker');
    expect(config.container.maxConcurrent).toBe(3);
  });

  it('should override channel tokens from env vars', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:ABC';
    const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
    expect(config.channels.telegram.botToken).toBe('123:ABC');
  });

  it('should read ANTHROPIC_API_KEY from env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
    expect(config.anthropicApiKey).toBe('sk-ant-test');
  });

  it('should throw when ANTHROPIC_API_KEY is not set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => loadConfig(path.join(tmpDir, 'nonexistent.yaml'))).toThrow('ANTHROPIC_API_KEY is required');
  });

  it('should throw when telegram is enabled without token', () => {
    const yamlPath = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(yamlPath, `
channels:
  telegram:
    enabled: true
`);
    expect(() => loadConfig(yamlPath)).toThrow('TELEGRAM_BOT_TOKEN');
  });

  it('should throw when slack is enabled without tokens', () => {
    const yamlPath = path.join(tmpDir, 'bad-slack.yaml');
    fs.writeFileSync(yamlPath, `
channels:
  slack:
    enabled: true
`);
    expect(() => loadConfig(yamlPath)).toThrow('SLACK_BOT_TOKEN');
  });

  it('should throw when discord is enabled without token', () => {
    const yamlPath = path.join(tmpDir, 'bad-dc.yaml');
    fs.writeFileSync(yamlPath, `
channels:
  discord:
    enabled: true
`);
    expect(() => loadConfig(yamlPath)).toThrow('DISCORD_BOT_TOKEN');
  });

  it('should allow enabled channels with env token set', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:TOKEN';
    const yamlPath = path.join(tmpDir, 'tg.yaml');
    fs.writeFileSync(yamlPath, `
channels:
  telegram:
    enabled: true
`);
    const config = loadConfig(yamlPath);
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.botToken).toBe('123:TOKEN');
  });
});

describe('env file parsing', () => {
  it('should strip surrounding quotes from values', () => {
    const envPath = path.join(tmpDir, 'secureclaw.env');
    fs.writeFileSync(envPath, 'ANTHROPIC_API_KEY="sk-ant-quoted"\n');

    // Need to change cwd temporarily
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      delete process.env.ANTHROPIC_API_KEY;
      const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
      expect(config.anthropicApiKey).toBe('sk-ant-quoted');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('should strip single quotes', () => {
    const envPath = path.join(tmpDir, 'secureclaw.env');
    fs.writeFileSync(envPath, "ANTHROPIC_API_KEY='sk-ant-single'\n");

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      delete process.env.ANTHROPIC_API_KEY;
      const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
      expect(config.anthropicApiKey).toBe('sk-ant-single');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('should skip comments and blank lines', () => {
    const envPath = path.join(tmpDir, 'secureclaw.env');
    fs.writeFileSync(envPath, '# comment\n\nANTHROPIC_API_KEY=sk-ant-val\n');

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      delete process.env.ANTHROPIC_API_KEY;
      const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
      expect(config.anthropicApiKey).toBe('sk-ant-val');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('should handle values containing equals signs', () => {
    const envPath = path.join(tmpDir, 'secureclaw.env');
    fs.writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-ant-base64=encoded==\n');

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      delete process.env.ANTHROPIC_API_KEY;
      const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
      expect(config.anthropicApiKey).toBe('sk-ant-base64=encoded==');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('should not override existing env vars', () => {
    process.env.ANTHROPIC_API_KEY = 'existing-key';
    const envPath = path.join(tmpDir, 'secureclaw.env');
    fs.writeFileSync(envPath, 'ANTHROPIC_API_KEY=file-key\n');

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const config = loadConfig(path.join(tmpDir, 'nonexistent.yaml'));
      expect(config.anthropicApiKey).toBe('existing-key');
    } finally {
      process.chdir(origCwd);
    }
  });
});
