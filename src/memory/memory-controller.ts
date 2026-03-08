// src/memory/memory-controller.ts
// Group 记忆管理 — 读写 CLAUDE.md，注入检测，大小限制
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentIdentity, AuditEntry } from '../core/types';
import { SecurityError, SAFE_ID_PATTERN, TrustLevel } from '../core/types';
import type { AuditBackend } from '../audit/backend/interface';
import { analyzeForMemoryWrite } from '../trust/injection-guard';
import { generateId, sha256, computeDiff } from '../core/utils';

// ── 常量 ───────────────────────────────────────────────────────

/** 记忆文件最大字节数（512KB） */
const MAX_MEMORY_SIZE = 512 * 1024;

/** 记忆文件名 */
const MEMORY_FILENAME = 'CLAUDE.md';

// ── 辅助 ───────────────────────────────────────────────────────

function validateGroupId(groupId: string): void {
  if (!SAFE_ID_PATTERN.test(groupId)) {
    throw new SecurityError(`Invalid groupId: "${groupId}" — must match ${SAFE_ID_PATTERN}`);
  }
}

function getMemoryPath(projectRoot: string, groupId: string): string {
  validateGroupId(groupId);
  return path.join(projectRoot, 'groups', groupId, MEMORY_FILENAME);
}

function ensureGroupDir(projectRoot: string, groupId: string): void {
  const dir = path.join(projectRoot, 'groups', groupId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── 读取 ───────────────────────────────────────────────────────

/**
 * 读取指定 group 的记忆内容。
 * 返回 null 表示记忆文件不存在。
 */
export function readGroupMemory(
  projectRoot: string,
  groupId: string,
): string | null {
  const memoryPath = getMemoryPath(projectRoot, groupId);
  try {
    if (fs.existsSync(memoryPath)) {
      return fs.readFileSync(memoryPath, 'utf8');
    }
  } catch {
    // 读取失败
  }
  return null;
}

// ── 写入（带安全检查）────────────────────────────────────────

/**
 * 安全写入 group 记忆。
 *
 * 安全流程：
 * 1. 大小检查（512KB 限制）
 * 2. 注入检测（阈值 0.5，严于消息阈值 0.75）
 * 3. 计算 diff 摘要
 * 4. 写入文件
 * 5. 写审计日志
 *
 * @throws SecurityError 大小超限或注入检测触发时
 */
export async function writeGroupMemory(
  projectRoot: string,
  content: string,
  writer: AgentIdentity,
  audit: AuditBackend,
): Promise<void> {
  // 1. 大小检查
  const byteSize = Buffer.byteLength(content, 'utf8');
  if (byteSize > MAX_MEMORY_SIZE) {
    throw new SecurityError(
      `Memory write rejected: content size ${byteSize} bytes exceeds limit of ${MAX_MEMORY_SIZE} bytes`
    );
  }

  // 2. 注入检测（阈值 0.5）
  const analysis = analyzeForMemoryWrite(content);
  if (analysis.action === 'block') {
    await audit.append({
      entryId: generateId(),
      timestamp: Date.now(),
      eventType: 'security_alert',
      groupId: writer.groupId,
      sessionId: writer.sessionId,
      actorId: writer.sessionId,
      payload: {
        alert: 'memory_poisoning_attempt',
        contentPreview: content.substring(0, 200),
        score: analysis.score,
        flags: analysis.flags,
      },
    });
    throw new SecurityError('Memory write rejected: injection pattern detected');
  }

  // 3. 计算 diff 摘要
  const memoryPath = getMemoryPath(projectRoot, writer.groupId);
  const existingContent = readGroupMemory(projectRoot, writer.groupId) ?? '';
  const diff = computeDiff(existingContent, content);

  // 4. 写入文件
  ensureGroupDir(projectRoot, writer.groupId);
  fs.writeFileSync(memoryPath, content, 'utf8');

  // 5. 写审计日志
  await audit.append({
    entryId: generateId(),
    timestamp: Date.now(),
    eventType: 'memory_write',
    groupId: writer.groupId,
    sessionId: writer.sessionId,
    actorId: writer.sessionId,
    payload: {
      diff,
      contentHash: sha256(content),
    },
  });
}

// ── 追加 ───────────────────────────────────────────────────────

/**
 * 追加内容到 group 记忆（在现有内容后追加）。
 */
export async function appendGroupMemory(
  projectRoot: string,
  content: string,
  writer: AgentIdentity,
  audit: AuditBackend,
): Promise<void> {
  const existing = readGroupMemory(projectRoot, writer.groupId) ?? '';
  const newContent = existing ? `${existing}\n${content}` : content;
  await writeGroupMemory(projectRoot, newContent, writer, audit);
}

// ── 清除（仅 ADMIN）──────────────────────────────────────────

/**
 * 清除 group 记忆（需要 ADMIN 权限）。
 */
export async function clearGroupMemory(
  projectRoot: string,
  writer: AgentIdentity,
  audit: AuditBackend,
): Promise<void> {
  if (writer.trustLevel < TrustLevel.ADMIN) {
    throw new SecurityError('Memory clear requires ADMIN trust level');
  }
  const memoryPath = getMemoryPath(projectRoot, writer.groupId);
  const existingContent = readGroupMemory(projectRoot, writer.groupId) ?? '';

  if (fs.existsSync(memoryPath)) {
    fs.unlinkSync(memoryPath);
  }

  await audit.append({
    entryId: generateId(),
    timestamp: Date.now(),
    eventType: 'memory_write',
    groupId: writer.groupId,
    sessionId: writer.sessionId,
    actorId: writer.sessionId,
    payload: {
      diff: computeDiff(existingContent, ''),
      contentHash: sha256(''),
      action: 'clear',
    },
  });
}

/** 暴露常量（测试用） */
export const LIMITS = {
  MAX_MEMORY_SIZE,
} as const;
