/**
 * 步骤：register — 管理员群组创建（直接使用 better-sqlite3）
 * 不导入 src/db/db.ts，因为 setup/ 通过 tsx 运行而 src/ 编译为 CommonJS
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { emitStatus } from './status.js';

// SAFE_ID_PATTERN 与 src/core/utils.ts 保持一致
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

interface RegisterArgs {
  groupId: string;
  channelId: string;
  channelType: 'whatsapp' | 'telegram' | 'slack' | 'discord';
  adminSenderIds: string[];
  triggerWord: string;
  assistantName: string;
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    groupId: 'main',
    channelId: '',
    channelType: 'whatsapp',
    adminSenderIds: [],
    triggerWord: '@SecureClaw',
    assistantName: 'SecureClaw',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--group-id':
        result.groupId = args[++i] || 'main';
        break;
      case '--channel-id':
        result.channelId = args[++i] || '';
        break;
      case '--channel-type':
        result.channelType = args[++i] as RegisterArgs['channelType'];
        break;
      case '--admin-sender':
        result.adminSenderIds.push(args[++i] || '');
        break;
      case '--trigger':
        result.triggerWord = args[++i] || '@SecureClaw';
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'SecureClaw';
        break;
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  // 验证 groupId
  if (!SAFE_ID_PATTERN.test(parsed.groupId)) {
    emitStatus('REGISTER', {
      STATUS: 'failed',
      ERROR: 'invalid_group_id',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  if (!parsed.channelId) {
    emitStatus('REGISTER', {
      STATUS: 'failed',
      ERROR: 'missing_channel_id',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // 确保 scdata 目录存在
  const scdata = path.join(projectRoot, 'scdata');
  fs.mkdirSync(scdata, { recursive: true });

  // 打开/创建数据库
  const dbPath = path.join(scdata, 'secureclaw.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 确保 sc_groups 表存在
  db.exec(`CREATE TABLE IF NOT EXISTS sc_groups (
    group_id TEXT PRIMARY KEY,
    channel_type TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    trigger_word TEXT NOT NULL DEFAULT '@SecureClaw',
    admin_sender_ids TEXT NOT NULL DEFAULT '[]',
    assistant_name TEXT NOT NULL DEFAULT 'SecureClaw',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  // 插入/更新群组
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO sc_groups
      (group_id, channel_type, channel_id, trigger_word, admin_sender_ids, assistant_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parsed.groupId,
    parsed.channelType,
    parsed.channelId,
    parsed.triggerWord,
    JSON.stringify(parsed.adminSenderIds.filter(Boolean)),
    parsed.assistantName,
    now,
    now,
  );

  db.close();

  // 创建群组目录
  const groupDir = path.join(projectRoot, 'groups', parsed.groupId);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // 创建 CLAUDE.md（如果不存在）
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const template = [
      `# ${parsed.assistantName}`,
      '',
      `You are ${parsed.assistantName}, a helpful assistant for this group.`,
      '',
      '## Group Rules',
      '',
      '- Follow all instructions carefully',
      '- Be concise and helpful',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, template);
  }

  emitStatus('REGISTER', {
    GROUP_ID: parsed.groupId,
    CHANNEL_TYPE: parsed.channelType,
    CHANNEL_ID: parsed.channelId,
    TRIGGER: parsed.triggerWord,
    ASSISTANT_NAME: parsed.assistantName,
    ADMIN_COUNT: parsed.adminSenderIds.filter(Boolean).length,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
