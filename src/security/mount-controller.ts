// src/security/mount-controller.ts
// 挂载安全控制 — 禁止模式匹配、符号链接解析、路径穿越检查
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecurityError } from '../core/types';

// ── 禁止挂载模式 ──────────────────────────────────────────────

const FORBIDDEN_MOUNT_PATTERNS: RegExp[] = [
  /\.config\/claude/,      // Anthropic 凭证目录
  /\.ssh/,
  /\.gnupg/,
  /\.aws/,
  /\.azure/,
  /\.gcloud/,
  /\.kube/,
  /\.docker/,
  /credentials/i,
  /\.env$/,
  /\.netrc/,
  /private_key/i,
  /id_rsa/,
  /id_ed25519/,
  /\.secret/i,
  /src\//,                  // 项目源码（防止 Agent 自我修改）
  /dist\//,
  /node_modules\//,
];

// ── 允许的绝对路径前缀 ────────────────────────────────────────

const ALLOWED_ABSOLUTE_PATHS: string[] = [
  '/tmp/secureclaw-creds',         // 凭证代理 socket 目录
  '/private/tmp/secureclaw-creds', // macOS 上 /tmp → /private/tmp
];

// ── 验证函数 ──────────────────────────────────────────────────

/**
 * 验证宿主路径是否允许挂载到容器中。
 *
 * 安全检查：
 * 1. 路径穿越检查（禁止 '..'）
 * 2. 符号链接解析（realpathSync → 攻击者可能创建 symlink 绕过）
 * 3. 绝对路径白名单检查
 * 4. 禁止模式匹配
 *
 * @throws SecurityError 当挂载路径不安全时
 */
export function validateMount(hostPath: string): void {
  // 1. 路径穿越检查
  if (hostPath.includes('..')) {
    throw new SecurityError(`Path traversal in mount: ${hostPath}`);
  }

  // 2. 符号链接解析（路径不存在 → realpathSync 抛错 → 拒绝挂载）
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(hostPath);
  } catch {
    throw new SecurityError(`Mount path does not exist or cannot be resolved: ${hostPath}`);
  }

  // 3. 禁止模式匹配（先于白名单检查，确保危险路径无论如何被拒绝）
  for (const pattern of FORBIDDEN_MOUNT_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      throw new SecurityError(`Forbidden mount path: ${resolvedPath}`);
    }
  }

  // 4. 绝对路径白名单检查
  if (path.isAbsolute(resolvedPath)) {
    const isAllowed = ALLOWED_ABSOLUTE_PATHS.some(
      allowedPrefix => resolvedPath === allowedPrefix ||
                       resolvedPath.startsWith(allowedPrefix + path.sep)
    );
    if (!isAllowed) {
      const projectRoot = process.cwd();
      if (!resolvedPath.startsWith(projectRoot)) {
        throw new SecurityError(`Absolute mount path not allowed: ${resolvedPath}`);
      }
    }
  }
}

/**
 * 批量验证多个挂载路径。
 * 任何一个不通过都抛出 SecurityError。
 */
export function validateMounts(hostPaths: string[]): void {
  for (const p of hostPaths) {
    validateMount(p);
  }
}

/** 暴露禁止模式（测试用） */
export function getForbiddenPatterns(): readonly RegExp[] {
  return FORBIDDEN_MOUNT_PATTERNS;
}

/** 暴露允许路径（测试用） */
export function getAllowedAbsolutePaths(): readonly string[] {
  return ALLOWED_ABSOLUTE_PATHS;
}
