// src/trust/trust-engine.ts
// 信任评估引擎 — 决定消息的信任级别、能力集、注入评分
import {
  type NormalizedMessage,
  type TrustedMessage,
  type AuditEntry,
  TrustLevel,
  CAPABILITY_PRESETS,
} from '../core/types';
import type { SecureClawDB } from '../db/db';
import type { AuditBackend } from '../audit/backend/interface';
import { generateId } from '../core/utils';
import { analyze } from './injection-guard';

// ── 信任级别决策 ───────────────────────────────────────────────

/**
 * 信任级别优先级：BLOCKED 检查 > 成员覆盖 > group 默认值
 * 未注册的 group → BLOCKED（静默丢弃）
 */
export function determineTrustLevel(
  groupId: string,
  senderId: string,
  db: SecureClawDB,
): TrustLevel {
  // 1. 检查发送者是否被 BLOCKED
  if (db.isBlocked(groupId, senderId)) {
    return TrustLevel.BLOCKED;
  }

  // 2. 检查成员级别覆盖
  const memberOverride = db.getMemberTrust(groupId, senderId);
  if (memberOverride !== null) {
    return memberOverride;
  }

  // 3. 查找 group 默认级别
  const group = db.getGroup(groupId);
  if (!group) {
    return TrustLevel.BLOCKED; // 未注册 group → 静默丢弃
  }

  return group.trust_level;
}

// ── 完整信任评估 ───────────────────────────────────────────────

/**
 * 核心评估流程：
 * 1. determineTrustLevel → 获取信任级别
 * 2. injectionGuard.analyze → 注入评分 + flags
 * 3. CAPABILITY_PRESETS → 能力集映射
 * 4. 写审计日志
 * 5. 返回 TrustedMessage
 */
export async function evaluate(
  msg: NormalizedMessage,
  db: SecureClawDB,
  audit: AuditBackend,
): Promise<TrustedMessage> {
  const trustLevel = determineTrustLevel(msg.groupId, msg.senderId, db);

  // 注入分析
  const injection = analyze(msg.content, trustLevel);

  // 能力集映射
  const capabilitySet = CAPABILITY_PRESETS[trustLevel];

  // 写信任评估审计日志
  await audit.append({
    entryId: generateId(),
    timestamp: Date.now(),
    eventType: 'trust_evaluated',
    groupId: msg.groupId,
    actorId: msg.senderId,
    payload: {
      senderId: msg.senderId,
      trustLevel,
      injectionScore: injection.score,
      injectionFlags: injection.flags,
      injectionAction: injection.action,
    },
  });

  // 注入分数超过阈值 → 额外写安全警告
  if (injection.score >= 0.75) {
    await audit.append({
      entryId: generateId(),
      timestamp: Date.now(),
      eventType: 'injection_detected',
      groupId: msg.groupId,
      actorId: msg.senderId,
      payload: {
        score: injection.score,
        flags: injection.flags,
        contentPreview: msg.content.substring(0, 200),
        action: injection.action,
      },
    });
  }

  return {
    ...msg,
    trustLevel,
    capabilitySet,
    injectionScore: injection.score,
    injectionFlags: injection.flags,
  };
}
