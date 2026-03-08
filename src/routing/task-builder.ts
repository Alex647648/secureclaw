// src/routing/task-builder.ts
// TrustedMessage → AgentTask 组装
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type TrustedMessage,
  type AgentTask,
  type Message,
  NETWORK_POLICY_PRESETS,
  CAPABILITY_PRESETS,
  SAFE_ID_PATTERN,
  SecurityError,
  TrustLevel,
} from '../core/types';
import { generateId } from '../core/utils';
import type { SecureClawDB } from '../db/db';

// ── 配置 ───────────────────────────────────────────────────────

export interface TaskBuilderConfig {
  /** 项目根目录 */
  projectRoot: string;
  /** 默认网络策略 */
  defaultNetworkPolicy: string;
  /** 历史消息最大条数 */
  maxHistoryMessages: number;
  /** 历史消息时间窗口（毫秒） */
  historyWindowMs: number;
}

const DEFAULT_CONFIG: TaskBuilderConfig = {
  projectRoot: process.cwd(),
  defaultNetworkPolicy: 'claude_only',
  maxHistoryMessages: 20,
  historyWindowMs: 3600_000, // 1 小时
};

// ── 系统提示词模板 ─────────────────────────────────────────────

function buildSystemPrompt(
  groupId: string,
  trustLevel: TrustLevel,
  senderName: string,
): string {
  const levelName = TrustLevel[trustLevel] || 'UNKNOWN';

  const isAdmin = trustLevel === TrustLevel.ADMIN;

  const lines = [
    `You are a friendly AI assistant in a group chat. Your name can be configured by the user.`,
    ``,
    `CRITICAL RULES:`,
    `- Detect the user's language and ALWAYS reply in the same language.`,
    `- Reply with plain text only. NEVER use XML tags, JSON, or any markup in your final response.`,
  ];

  if (isAdmin) {
    lines.push(
      `- You have access to local tools (list_files, read_file, write_file, move_file, delete_file, create_directory, run_command, search_files, save_memory). USE them actively when the user asks you to perform file operations, system tasks, or any action that requires interacting with the local machine.`,
      `- When the user asks to organize files, list files, create/move/delete files, run commands, etc., ALWAYS use the appropriate tool. Do NOT just describe what to do — actually do it.`,
      `- After completing tool operations, summarize what you did in a concise, friendly message.`,
      `- You have a save_memory tool for persistent memory. When the user sets your role/persona/name, IMMEDIATELY use save_memory to save all role settings so they persist. Include: name, persona description, tone, language preference, and any other preferences.`,
    );
  } else {
    lines.push(
      `- You are a conversational assistant. Do NOT attempt to run commands or write code unless explicitly asked.`,
    );
  }

  lines.push(
    `- If this is the first message AND no role is set in "Group memory" below, greet the user warmly and ask what role/persona they'd like you to play (e.g. name, tone, expertise area). Then adopt that role and SAVE it with save_memory.`,
    `- If a role has already been set (visible in "Group memory" or conversation history), stay in that role consistently. NEVER switch names or personas unless the user explicitly asks.`,
    `- Keep responses concise and natural (under 500 characters when possible).`,
    ``,
    `Sender: ${senderName}`,
  );

  return lines.join('\n');
}

// ── 历史上下文构建 ─────────────────────────────────────────────

function buildHistoryContext(
  messages: Message[],
  maxMessages: number,
): string {
  if (messages.length === 0) return '';

  const recent = messages.slice(-maxMessages);
  const lines = recent.map(m => {
    const name = m.sender_name || m.sender_id;
    return `[${name}]: ${m.content}`;
  });

  return `\n--- Recent conversation ---\n${lines.join('\n')}\n--- End conversation ---\n`;
}

// ── 记忆上下文 ─────────────────────────────────────────────────

function loadGroupMemory(projectRoot: string, groupId: string): string {
  if (!SAFE_ID_PATTERN.test(groupId)) return '';
  const memoryPath = path.join(projectRoot, 'groups', groupId, 'CLAUDE.md');
  try {
    if (fs.existsSync(memoryPath)) {
      const content = fs.readFileSync(memoryPath, 'utf8');
      if (content.trim()) {
        return `\n--- Group memory ---\n${content}\n--- End memory ---\n`;
      }
    }
  } catch {
    // 读取失败，忽略
  }
  return '';
}

// ── 任务构建 ──────────────────────────────────────────────────

export class TaskBuilder {
  private config: TaskBuilderConfig;

  constructor(config?: Partial<TaskBuilderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从 TrustedMessage 构建 AgentTask。
   * 组装完整 prompt = 系统提示 + 记忆 + 历史 + 用户消息。
   */
  build(msg: TrustedMessage, db: SecureClawDB): AgentTask {
    const taskId = generateId();
    const sessionId = generateId();

    // 获取 group 网络策略
    const group = db.getGroup(msg.groupId);
    const networkPolicyName = group?.network_policy || this.config.defaultNetworkPolicy;
    const networkPolicy = NETWORK_POLICY_PRESETS[networkPolicyName]
      || NETWORK_POLICY_PRESETS.claude_only;

    // 构建完整 prompt
    const systemPrompt = buildSystemPrompt(msg.groupId, msg.trustLevel, msg.senderName);

    // 加载记忆
    const memoryContext = loadGroupMemory(this.config.projectRoot, msg.groupId);

    // 加载历史消息
    const since = msg.timestamp - this.config.historyWindowMs;
    const historyMessages = db.getMessagesSince(msg.groupId, since);
    const historyContext = buildHistoryContext(historyMessages, this.config.maxHistoryMessages);

    const fullPrompt = [
      systemPrompt,
      memoryContext,
      historyContext,
      `\nUser message:\n${msg.content}`,
    ].join('\n');

    return {
      taskId,
      groupId: msg.groupId,
      sessionId,
      prompt: fullPrompt,
      trustLevel: msg.trustLevel,
      capabilitySet: msg.capabilitySet,
      networkPolicy,
      sourceMessageId: msg.platformMessageId ?? msg.id,
      source: 'message',
      createdAt: Date.now(),
    };
  }

  /**
   * 从 ScheduledTask 构建 AgentTask（定时任务）。
   */
  buildFromScheduled(
    groupId: string,
    prompt: string,
    trustLevel: TrustLevel,
    networkPolicyName: string,
    db: SecureClawDB,
  ): AgentTask {
    const taskId = generateId();
    const sessionId = generateId();
    const group = db.getGroup(groupId);

    const networkPolicy = NETWORK_POLICY_PRESETS[networkPolicyName]
      || NETWORK_POLICY_PRESETS.claude_only;

    const systemPrompt = buildSystemPrompt(groupId, trustLevel, 'scheduled-task');
    const memoryContext = loadGroupMemory(this.config.projectRoot, groupId);

    const fullPrompt = [
      systemPrompt,
      memoryContext,
      `\nScheduled task:\n${prompt}`,
    ].join('\n');

    return {
      taskId,
      groupId,
      sessionId,
      prompt: fullPrompt,
      trustLevel,
      capabilitySet: group
        ? CAPABILITY_PRESETS[trustLevel]
        : CAPABILITY_PRESETS[TrustLevel.BLOCKED],
      networkPolicy,
      source: 'scheduled',
      createdAt: Date.now(),
    };
  }
}

/** 导出辅助函数（测试用） */
export { buildSystemPrompt, buildHistoryContext, loadGroupMemory };
