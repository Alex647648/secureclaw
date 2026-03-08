// src/core/utils.ts
import { createHash, createHmac, randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

/** 生成唯一 ID（requestId、taskId、sessionId 等） */
export function generateId(): string {
  return randomBytes(16).toString('hex');
}

/** 生成安全随机字符串（用于 sessionToken） */
export function generateSecureRandom(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** SHA-256 哈希 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** HMAC-SHA256 签名 */
export function hmacSha256(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

/**
 * Canonical JSON 序列化（key 按字典序排序，递归处理嵌套对象和数组）
 * 用于哈希链的序列化，保证不同运行环境序列化结果一致。
 * undefined 值的属性被跳过，与 JSON.stringify 行为一致。
 */
export function canonicalSerialize(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'number' || typeof obj === 'boolean') return JSON.stringify(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalSerialize(item)).join(',') + ']';
  }
  // Object: sort keys, skip undefined values, recurse
  const record = obj as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => JSON.stringify(key) + ':' + canonicalSerialize(record[key]));
  return '{' + entries.join(',') + '}';
}

/** 时序安全的字符串比较（防止时序攻击，先 hash 到固定长度避免泄漏长度信息） */
export function timingSafeEqual(a: string, b: string): boolean {
  const aHash = createHash('sha256').update(a, 'utf8').digest();
  const bHash = createHash('sha256').update(b, 'utf8').digest();
  return cryptoTimingSafeEqual(aHash, bHash);
}

/** 计算两个字符串的简单 diff 摘要（用于记忆写入审计） */
export function computeDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n').length;
  const newLines = newContent.split('\n').length;
  const delta = newLines - oldLines;
  return `lines: ${oldLines}→${newLines} (${delta >= 0 ? '+' : ''}${delta}), chars: ${oldContent.length}→${newContent.length}`;
}
