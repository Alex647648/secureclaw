/**
 * 步骤：credentials — ANTHROPIC_API_KEY 配置
 */
import fs from 'node:fs';
import path from 'node:path';

import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const envPath = path.join(projectRoot, 'secureclaw.env');

  // 检查 --verify 模式（只检查不写入）
  const verifyOnly = args.includes('--verify');

  // 检查当前状态
  let hasKey = false;
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    hasKey = /^ANTHROPIC_API_KEY=sk-ant-.+/m.test(content);
  }

  if (verifyOnly) {
    emitStatus('CREDENTIALS', {
      HAS_KEY: hasKey,
      ENV_PATH: envPath,
      STATUS: hasKey ? 'success' : 'failed',
      LOG: 'logs/setup.log',
    });
    if (!hasKey) process.exit(1);
    return;
  }

  // 从参数读取 key
  let apiKey = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key') {
      apiKey = args[++i] || '';
    }
  }

  if (!apiKey) {
    // 从环境变量读取
    apiKey = process.env.ANTHROPIC_API_KEY || '';
  }

  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    emitStatus('CREDENTIALS', {
      HAS_KEY: false,
      STATUS: 'failed',
      ERROR: 'invalid_or_missing_key',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // 写入或更新 .env
  if (fs.existsSync(envPath)) {
    let content = fs.readFileSync(envPath, 'utf-8');
    if (content.includes('ANTHROPIC_API_KEY=')) {
      content = content.replace(
        /^ANTHROPIC_API_KEY=.*$/m,
        `ANTHROPIC_API_KEY=${apiKey}`,
      );
    } else {
      content += `\nANTHROPIC_API_KEY=${apiKey}\n`;
    }
    fs.writeFileSync(envPath, content);
  } else {
    // 从模板创建
    const templatePath = path.join(projectRoot, 'secureclaw.env.example');
    if (fs.existsSync(templatePath)) {
      let content = fs.readFileSync(templatePath, 'utf-8');
      content = content.replace(
        /^ANTHROPIC_API_KEY=.*$/m,
        `ANTHROPIC_API_KEY=${apiKey}`,
      );
      fs.writeFileSync(envPath, content);
    } else {
      fs.writeFileSync(envPath, `ANTHROPIC_API_KEY=${apiKey}\n`);
    }
  }

  emitStatus('CREDENTIALS', {
    HAS_KEY: true,
    ENV_PATH: envPath,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
