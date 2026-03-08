// src/integration/message-pipeline.ts
// 消息处理管线 — RawMessage → normalize → trust → rate limit → build → validate → enqueue
import type { RawMessage, TrustedMessage, OutboundMessage } from '../core/types';
import { TrustLevel } from '../core/types';
import type { SecureClawDB } from '../db/db';
import type { AuditBackend } from '../audit/backend/interface';
import type { RateLimiter } from '../trust/rate-limiter';
import type { TaskBuilder } from '../routing/task-builder';
import type { GroupQueue } from '../routing/group-queue';
import { normalize, extractChannelId } from '../ingress/normalizer';
import { evaluate } from '../trust/trust-engine';
import { validateTask } from '../security/sandbox-validator';
import { generateId } from '../core/utils';
import { AdminCommandHandler, isAdminCommand } from '../admin/command-handler';

// ── 管线配置 ───────────────────────────────────────────────────────

export interface MessagePipelineConfig {
  triggerWord: string;
  /** 管理员命令处理器（可选，启用后支持 !admin 命令） */
  adminHandler?: AdminCommandHandler;
  /** 发送响应回调（用于管理员命令回复） */
  sendResponse?: (msg: OutboundMessage) => Promise<void>;
}

// ── 管线结果 ───────────────────────────────────────────────────────

export interface PipelineResult {
  /** 消息是否成功入队 */
  accepted: boolean;
  /** 拒绝原因（调试用，不暴露给用户） */
  reason?: string;
  /** 任务 ID（入队成功时返回） */
  taskId?: string;
}

// ── 管线实例 ───────────────────────────────────────────────────────

export interface MessagePipeline {
  /**
   * 处理原始消息，返回管线结果。
   * 此方法不会抛出异常 — 所有错误被捕获并以 PipelineResult 返回。
   */
  process(raw: RawMessage): Promise<PipelineResult>;
}

/**
 * 创建消息处理管线。
 *
 * 处理流程：
 * 1. normalize — 标准化 + 触发词过滤
 * 2. group resolution — 通过 channel_type + channel_id 查找 group
 * 3. rate limit — 检查发送者速率
 * 4. insert message — 持久化到 sc_messages
 * 5. trust evaluate — 信任评估 + 注入检测
 * 6. build task — 组装 AgentTask
 * 7. validate task — 沙箱安全验证
 * 8. enqueue — 入队等待执行
 */
export function createMessagePipeline(
  config: MessagePipelineConfig,
  db: SecureClawDB,
  audit: AuditBackend,
  rateLimiter: RateLimiter,
  taskBuilder: TaskBuilder,
  groupQueue: GroupQueue,
): MessagePipeline {

  return {
    async process(raw: RawMessage): Promise<PipelineResult> {
      try {
        // Step 1: 标准化消息
        const normalized = normalize(raw, config.triggerWord);
        if (!normalized) {
          return { accepted: false, reason: 'trigger_word_not_matched' };
        }

        // Step 2: Group 解析
        const channelId = extractChannelId(raw);
        const group = db.getGroupByChannelId(normalized.channelType, channelId);
        if (!group) {
          return { accepted: false, reason: 'group_not_registered' };
        }
        // 设置 groupId（normalizer 输出的 channelId 需要映射到内部 groupId）
        normalized.groupId = group.id;

        // Step 2.5a: 检查待确认交互（确认式交互的回复）
        const pendingConfirm = db.getPendingConfirmation(group.id, normalized.senderId);
        if (pendingConfirm) {
          // 将用户回复作为确认结果处理
          db.deletePendingConfirmation(pendingConfirm.id);
          // 把确认结果追加到原始上下文中，作为新任务重新入队
          const confirmContent = `[User confirmed: "${normalized.content}" in response to: "${pendingConfirm.question}"]\n\nOriginal context: ${pendingConfirm.context}\n\nUser's confirmation response: ${normalized.content}\n\nContinue the task based on the user's response.`;
          normalized.content = confirmContent;
        }

        // Step 2.5b: 管理员命令拦截
        if (config.adminHandler && isAdminCommand(normalized.content)) {
          // 检查发送者是否具有显式 ADMIN 信任级别
          // 安全关键：必须有显式的 per-member ADMIN 信任，不允许回退到群组默认级别
          const senderTrust = db.getMemberTrust(group.id, normalized.senderId);

          if (senderTrust !== TrustLevel.ADMIN) {
            await audit.append({
              entryId: generateId(),
              timestamp: Date.now(),
              eventType: 'security_alert',
              groupId: group.id,
              actorId: normalized.senderId,
              payload: {
                alert: 'admin_command_unauthorized',
                content: normalized.content.slice(0, 100),
              },
            });
            return { accepted: false, reason: 'admin_command_unauthorized' };
          }

          // 执行管理员命令
          const cmdResult = await config.adminHandler.execute(
            normalized.content,
            group.id,
            normalized.senderId,
          );

          // 发送响应
          if (config.sendResponse) {
            await config.sendResponse({
              groupId: group.id,
              content: cmdResult.message,
              channelType: normalized.channelType,
              replyToId: normalized.platformMessageId ?? normalized.id,
            });
          }

          return { accepted: true, reason: 'admin_command_executed' };
        }

        // Step 3: 速率限制（复合 key 防止跨 group 共享限额）
        const rateLimitKey = `${group.id}:${normalized.senderId}`;
        const rateResult = rateLimiter.check(rateLimitKey);
        if (!rateResult.allowed) {
          await audit.append({
            entryId: generateId(),
            timestamp: Date.now(),
            eventType: 'security_alert',
            groupId: group.id,
            actorId: normalized.senderId,
            payload: {
              alert: 'rate_limited',
              senderId: normalized.senderId,
              currentCount: rateResult.currentCount,
              retryAfterMs: rateResult.retryAfterMs,
            },
          });
          return { accepted: false, reason: 'rate_limited' };
        }

        // Step 4: 持久化消息
        db.insertMessage({
          id: normalized.id,
          group_id: group.id,
          sender_id: normalized.senderId,
          sender_name: normalized.senderName,
          content: normalized.content,
          content_type: normalized.contentType,
          trust_level: null,       // 尚未评估
          injection_score: null,
          timestamp: normalized.timestamp,
        });

        // Step 5: 信任评估
        const trusted: TrustedMessage = await evaluate(normalized, db, audit);

        // 更新消息的信任级别和注入分数（原地更新，避免重复记录）
        try {
          db.updateMessageTrustLevel(normalized.id, trusted.trustLevel, trusted.injectionScore);
        } catch {
          // 更新失败不影响流程
        }

        // BLOCKED → 静默丢弃
        if (trusted.trustLevel === TrustLevel.BLOCKED) {
          return { accepted: false, reason: 'trust_blocked' };
        }

        // 注入被阻断
        if (trusted.injectionScore >= 0.75 && trusted.trustLevel < TrustLevel.ADMIN) {
          return { accepted: false, reason: 'injection_blocked' };
        }

        // Step 6: 构建任务
        const task = taskBuilder.build(trusted, db);

        // Step 7: 沙箱验证
        validateTask(task);

        // Step 8: 入队
        groupQueue.enqueue(task);

        return { accepted: true, taskId: task.taskId };

      } catch (err: any) {
        // 管线异常 — 记录审计日志但不向外抛出
        try {
          await audit.append({
            entryId: generateId(),
            timestamp: Date.now(),
            eventType: 'security_alert',
            actorId: 'system',
            payload: {
              alert: 'pipeline_error',
              error: err.message || 'Unknown pipeline error',
            },
          });
        } catch {
          // 审计写入也失败，静默处理
        }
        return { accepted: false, reason: `pipeline_error: ${err.message}` };
      }
    },
  };
}
