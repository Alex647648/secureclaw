// src/core/types.ts
// SecureClaw 全部核心类型定义

// ── 安全 ID 验证 ──────────────────────────────────────────────────

export const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// ── 信任模型 ──────────────────────────────────────────────────────

export enum TrustLevel {
  BLOCKED   = 0,  // 静默丢弃，写安全日志
  UNTRUSTED = 1,  // Phase 1 保留结构，不激活
  TRUSTED   = 2,  // 业务任务，白名单网络，本 group 文件读写
  ADMIN     = 3,  // 完整权限，包括 bash
}

// ── 能力集 ──────────────────────────────────────────────────────

export interface CapabilitySet {
  bash: boolean;           // bash 直接执行（仅 ADMIN）
  fileRead: boolean;       // 文件读取
  fileWrite: boolean;      // 文件写入
  networkAccess: boolean;  // 网络访问（受 networkPolicy 约束）
  memoryWrite: boolean;    // 写入 groups/{groupId}/CLAUDE.md
  spawnSubAgent: boolean;  // 派生子 Agent（Phase 2）
}

// 预定义能力集
export const CAPABILITY_PRESETS: Record<TrustLevel, CapabilitySet> = {
  [TrustLevel.BLOCKED]: {
    bash: false, fileRead: false, fileWrite: false,
    networkAccess: false, memoryWrite: false, spawnSubAgent: false,
  },
  [TrustLevel.UNTRUSTED]: {
    bash: false, fileRead: true, fileWrite: false,
    networkAccess: false, memoryWrite: false, spawnSubAgent: false,
  },
  [TrustLevel.TRUSTED]: {
    bash: false, fileRead: true, fileWrite: true,
    networkAccess: true, memoryWrite: true, spawnSubAgent: false,
  },
  [TrustLevel.ADMIN]: {
    bash: true, fileRead: true, fileWrite: true,
    networkAccess: true, memoryWrite: true, spawnSubAgent: true,
  },
};

// ── 消息模型 ──────────────────────────────────────────────────────

export interface RawMessage {
  channelType: 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'api';
  rawPayload: unknown;
  receivedAt: number;
}

export interface NormalizedMessage {
  id: string;
  groupId: string;        // 内部 ID，满足 SAFE_ID_PATTERN
  senderId: string;
  senderName: string;
  content: string;        // 已去掉触发词前缀
  contentType: 'text' | 'image' | 'document' | 'audio';
  timestamp: number;      // Unix ms
  channelType: string;
  replyToId?: string;     // 原始消息 ID，用于回复
  platformMessageId?: string; // 平台原始消息 ID（Discord snowflake 等），用于回复定位
}

export interface TrustedMessage extends NormalizedMessage {
  trustLevel: TrustLevel;
  capabilitySet: CapabilitySet;
  injectionScore: number;   // 0.0（安全）~ 1.0（高度可疑）
  injectionFlags: string[]; // 触发的注入模式
}

// ── 执行模型 ──────────────────────────────────────────────────────

export interface AgentTask {
  taskId: string;
  groupId: string;
  sessionId: string;
  prompt: string;           // 已包含系统上下文 + 历史注入
  trustLevel: TrustLevel;
  capabilitySet: CapabilitySet;
  networkPolicy: NetworkPolicy;
  sourceMessageId?: string; // 触发此任务的原始消息 ID（定时任务为 undefined）
  source: 'message' | 'scheduled';
  createdAt: number;
  scheduledFor?: number;
}

export interface AgentResult {
  taskId: string;
  sessionId: string;
  success: boolean;
  output?: string;      // stdout 标记区内容，undefined 表示未找到标记
  error?: string;
  durationMs: number;
  toolCallCount: number;
}

// ── 网络策略 ──────────────────────────────────────────────────────

export interface NetworkPolicy {
  preset: 'isolated' | 'claude_only' | 'trusted' | 'open';
}

export const NETWORK_POLICY_PRESETS: Record<string, NetworkPolicy> = {
  isolated:    { preset: 'isolated' },
  claude_only: { preset: 'claude_only' },
  trusted:     { preset: 'trusted' },
  open:        { preset: 'open' },
};

// ── 记忆模型 ──────────────────────────────────────────────────────

export type MemoryType = 'group' | 'system';

export interface MemoryKey {
  type: MemoryType;
  groupId?: string;   // group memory 必填
  key: string;
}

export interface Memory {
  content: string;
  contentHash: string;
  writtenBy: string;
  writtenAt: number;
  trustLevel: TrustLevel;
}

export type MemoryKeyPrefix = Pick<MemoryKey, 'type' | 'groupId'>;

// ── 审计模型 ──────────────────────────────────────────────────────

export type AuditEventType =
  | 'message_received'
  | 'trust_evaluated'
  | 'injection_detected'
  | 'task_queued'
  | 'container_spawned'
  | 'credential_issued'
  | 'memory_read'
  | 'memory_write'
  | 'task_completed'
  | 'security_alert';

export interface AuditEntry {
  entryId: string;
  timestamp: number;
  eventType: AuditEventType;
  groupId?: string;
  sessionId?: string;
  actorId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

export interface AuditFilter {
  groupId?: string;
  sessionId?: string;
  eventType?: AuditEventType;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
}

export interface IntegrityReport {
  valid: boolean;
  totalEntries: number;
  firstBrokenAt?: string;
  checkedAt: number;
}

// ── 身份模型 ──────────────────────────────────────────────────────

export interface AgentIdentity {
  sessionId: string;
  groupId: string;
  trustLevel: TrustLevel;
  capabilitySet: CapabilitySet;
  issuedAt: number;
  expiresAt: number;
}

// ── 消息通道类型 ──────────────────────────────────────────────────

export interface OutboundMessage {
  groupId: string;
  content: string;
  replyToId?: string;
  channelType: string;
}

// ── 执行后端类型 ──────────────────────────────────────────────────

export interface ExecutionPolicy {
  networkPolicy: NetworkPolicy;
  capabilitySet: CapabilitySet;
  timeoutMs: number;
  memoryMb: number;
  cpuCount: number;
}

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'unknown';

// ── 注入防护类型 ──────────────────────────────────────────────────

export interface InjectionRule {
  pattern: RegExp;
  score: number;
  flag: string;
}

export interface InjectionAnalysis {
  score: number;
  flags: string[];
  action: 'allow' | 'warn' | 'block';
}

// ── 安全异常 ──────────────────────────────────────────────────────

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

// ── 数据库类型（插入用）──────────────────────────────────────────

export interface Group {
  id: string;
  name: string;
  channel_type: string;
  channel_id: string;
  trust_level: TrustLevel;
  network_policy: string;
  is_admin_group: number;    // 0 | 1
  created_at: number;
  updated_at: number;
}

export type NewGroup = Omit<Group, 'created_at' | 'updated_at'>;

export interface Message {
  id: string;
  group_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  content_type: string;
  trust_level: number | null;
  injection_score: number | null;
  timestamp: number;
  processed: number;  // 0 | 1
}

export type NewMessage = Omit<Message, 'processed'>;

export interface Session {
  session_id: string;
  group_id: string;
  task_id: string | null;
  trust_level: TrustLevel;
  started_at: number;
  ended_at: number | null;
  status: 'running' | 'completed' | 'failed' | 'killed';
}

export type NewSession = Omit<Session, 'ended_at' | 'status'>;

export interface ScheduledTask {
  id: string;
  group_id: string;
  name: string;
  cron_expression: string;
  prompt: string;
  trust_level: TrustLevel;
  network_policy: string;
  enabled: number;          // 0 | 1
  last_run_at: number | null;
  next_run_at: number;
  created_at: number;
  created_by: string;
}

export type NewScheduledTask = Omit<ScheduledTask, 'last_run_at'> & {
  last_run_at?: number | null;
};

// ── 对话轮次（多轮上下文）──────────────────────────────────────

export interface ConversationTurn {
  id: string;
  group_id: string;
  sender_id: string;         // 用户 sender_id 或 'assistant'
  sender_name: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  source_message_id: string; // 关联 sc_messages.id 或 task_id
}

export type NewConversationTurn = ConversationTurn;

// ── 能力合并工具（per-group 覆盖用）─────────────────────────────

/**
 * 在 preset 基础上做 per-group 能力覆盖。
 * 覆盖只能降低权限（true → false），不能提升（false → true）。
 */
export function mergeCapabilities(
  base: CapabilitySet,
  overrides: Partial<CapabilitySet>
): CapabilitySet {
  const result = { ...base };
  for (const [k, v] of Object.entries(overrides) as Array<[keyof CapabilitySet, boolean]>) {
    if (v === false) {
      result[k] = false; // 只允许降级
    }
    // 忽略试图提升权限的 true 值
  }
  return result;
}
