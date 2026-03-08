// src/security/sandbox-validator.ts
// 容器配置验证 — 启动前最后安全关卡
import {
  type AgentTask,
  TrustLevel,
  SAFE_ID_PATTERN,
  SecurityError,
} from '../core/types';

// ── 常量 ───────────────────────────────────────────────────────

/** Prompt 最大字符数（50K） */
const MAX_PROMPT_LENGTH = 50_000;

// ── 辅助断言 ───────────────────────────────────────────────────

/**
 * 验证 ID 格式是否安全（仅允许 [a-zA-Z0-9_-]{1,64}）。
 * @throws SecurityError 不合法时
 */
export function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new SecurityError(`Invalid ${label}: must match ${SAFE_ID_PATTERN}`);
  }
}

// ── 任务验证 ──────────────────────────────────────────────────

/**
 * 容器启动前验证 AgentTask 的安全约束：
 * 1. groupId / sessionId / taskId 格式安全
 * 2. bash 能力只能分配给 ADMIN
 * 3. open 网络策略只能分配给 ADMIN
 * 4. prompt 长度不超过 50,000 字符
 *
 * 任何违规 → 抛出 SecurityError，阻止容器启动。
 */
export function validateTask(task: AgentTask): void {
  // 1. ID 格式验证
  assertSafeId(task.groupId, 'groupId');
  assertSafeId(task.sessionId, 'sessionId');
  assertSafeId(task.taskId, 'taskId');

  // 2. bash 能力 → 要求 ADMIN
  if (task.capabilitySet.bash && task.trustLevel !== TrustLevel.ADMIN) {
    throw new SecurityError(
      `bash capability requires ADMIN trust level, got ${TrustLevel[task.trustLevel]}`
    );
  }

  // 3. open 网络策略 → 要求 ADMIN
  if (task.networkPolicy.preset === 'open' && task.trustLevel !== TrustLevel.ADMIN) {
    throw new SecurityError(
      `open network policy requires ADMIN trust level, got ${TrustLevel[task.trustLevel]}`
    );
  }

  // 4. prompt 长度限制
  if (task.prompt.length > MAX_PROMPT_LENGTH) {
    throw new SecurityError(
      `Prompt too long: ${task.prompt.length} chars exceeds limit of ${MAX_PROMPT_LENGTH}`
    );
  }
}

/** 暴露限制常量（测试用） */
export const LIMITS = {
  MAX_PROMPT_LENGTH,
} as const;
