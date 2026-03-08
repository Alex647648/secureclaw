// src/memory/session-memory.ts
// 会话目录管理 — .claude 目录创建/清理（无持久化）
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SAFE_ID_PATTERN } from '../core/types';

// ── 常量 ───────────────────────────────────────────────────────

const SESSIONS_DIR = 'scdata/sessions';
const CLAUDE_DIR = '.claude';

// ── 目录管理 ──────────────────────────────────────────────────

/**
 * 获取会话目录路径。
 */
export function getSessionDir(projectRoot: string, groupId: string): string {
  if (!SAFE_ID_PATTERN.test(groupId)) {
    throw new Error(`Invalid groupId for session dir: "${groupId}"`);
  }
  return path.join(projectRoot, SESSIONS_DIR, groupId);
}

/**
 * 获取 .claude 目录路径。
 */
export function getClaudeDir(projectRoot: string, groupId: string): string {
  return path.join(projectRoot, SESSIONS_DIR, groupId, CLAUDE_DIR);
}

/**
 * 创建会话目录（包括 .claude 子目录）。
 * 返回 .claude 目录的绝对路径。
 */
export function createSessionDir(projectRoot: string, groupId: string): string {
  const claudeDir = getClaudeDir(projectRoot, groupId);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  return claudeDir;
}

/**
 * 清理会话 .claude 目录。
 * ⚠️ 每次任务结束后必须调用（容器运行器 step 11）。
 * 确保无跨任务历史残留。
 */
export function cleanSessionDir(projectRoot: string, groupId: string): void {
  const claudeDir = getClaudeDir(projectRoot, groupId);
  if (fs.existsSync(claudeDir)) {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}

/**
 * 清理所有会话目录（进程启动时调用）。
 */
export function cleanAllSessionDirs(projectRoot: string): void {
  const sessionsDir = path.join(projectRoot, SESSIONS_DIR);
  if (!fs.existsSync(sessionsDir)) return;

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 安全验证：防止路径穿越攻击
    if (!SAFE_ID_PATTERN.test(entry.name)) continue;
    try {
      cleanSessionDir(projectRoot, entry.name);
    } catch {
      // 忽略清理失败
    }
  }
}

/**
 * 检查 .claude 目录是否存在（调试用）。
 */
export function sessionDirExists(projectRoot: string, groupId: string): boolean {
  return fs.existsSync(getClaudeDir(projectRoot, groupId));
}
