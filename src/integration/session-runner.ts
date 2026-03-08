// src/integration/session-runner.ts
// 会话运行器 — 11 步容器执行生命周期编排
import type { AgentTask, ExecutionPolicy, OutboundMessage } from '../core/types';
import { TrustLevel } from '../core/types';
import type { ExecutionBackend } from '../execution/interface';
import type { AuditBackend } from '../audit/backend/interface';
import type { SecureClawDB } from '../db/db';
import type { CredentialProxy } from '../security/credential-proxy';
import * as path from 'node:path';
import { validateTask } from '../security/sandbox-validator';
import { validateMounts } from '../security/mount-controller';
import { createSessionDir, cleanSessionDir } from '../memory/session-memory';
import { generateId } from '../core/utils';
import type { HostBackendWithProgress } from '../execution/host-backend';
import type { NewConversationTurn } from '../core/types';

// ── 配置 ───────────────────────────────────────────────────────

export interface SessionRunnerConfig {
  projectRoot: string;
  timeoutMs: number;
  memoryMb: number;
  cpuCount: number;
}

// ── 消息发送回调 ─────────────────────────────────────────────────

export type SendMessageFn = (msg: OutboundMessage) => Promise<void>;

// ── 创建 TaskHandler ─────────────────────────────────────────────

/**
 * 创建 GroupQueue 的 TaskHandler。
 * 封装完整的容器执行生命周期：
 *
 * 1.  validateTask
 * 2.  credProxy.createSession
 * 3.  createSessionDir
 * 4.  db.createSession
 * 5.  audit: container_spawned
 * 6.  executionBackend.run
 * 7.  发送响应
 * 8.  db.updateSessionStatus
 * 9.  db.markMessageProcessed
 * 10. credProxy.destroySession
 * 11. cleanSessionDir
 * 12. audit: task_completed
 */
export function createSessionRunner(
  config: SessionRunnerConfig,
  executionBackend: ExecutionBackend,
  credProxy: CredentialProxy,
  db: SecureClawDB,
  audit: AuditBackend,
  sendMessage: SendMessageFn,
  /** ADMIN 宿主执行后端（可选，未提供时所有任务走容器） */
  hostBackend?: ExecutionBackend,
): (task: AgentTask) => Promise<void> {

  return async function sessionRunner(task: AgentTask): Promise<void> {
    // ── ADMIN 宿主执行路径（跳过容器、凭证代理、挂载验证）──
    const useHost = hostBackend && task.trustLevel === TrustLevel.ADMIN;

    let sessionCreated = false;
    let sessionToken = '';
    let socketPath = '';

    try {
      // Step 1: 沙箱验证（ADMIN 宿主路径也需要基本 ID 验证）
      validateTask(task);

      // Step 4: 记录会话到数据库（两条路径共用）
      db.createSession({
        session_id: task.sessionId,
        group_id: task.groupId,
        task_id: task.taskId,
        trust_level: task.trustLevel,
        started_at: Date.now(),
      });

      // Step 5: 写审计日志
      await audit.append({
        entryId: generateId(),
        timestamp: Date.now(),
        eventType: 'container_spawned',
        groupId: task.groupId,
        sessionId: task.sessionId,
        actorId: 'system',
        payload: {
          taskId: task.taskId,
          trustLevel: task.trustLevel,
          source: task.source,
          executionMode: useHost ? 'host' : 'container',
        },
      });

      // Step 6: 构建执行策略
      const policy: ExecutionPolicy = {
        networkPolicy: task.networkPolicy,
        capabilitySet: task.capabilitySet,
        timeoutMs: config.timeoutMs,
        memoryMb: config.memoryMb,
        cpuCount: config.cpuCount,
      };

      let result;

      if (useHost) {
        // ── ADMIN 宿主执行：直接调用 Claude API，无需凭证代理 ──
        // 设置进度回调：通过通道发送中间状态
        const hb = hostBackend as HostBackendWithProgress;
        if (hb.setProgressCallback) {
          const group = db.getGroup(task.groupId);
          hb.setProgressCallback(async (msg: string) => {
            try {
              await sendMessage({
                groupId: task.groupId,
                content: msg,
                channelType: group?.channel_type ?? 'unknown',
              });
            } catch { /* 进度推送失败不影响主流程 */ }
          });
        }

        result = await hostBackend.run(task, policy);
      } else {
        // ── 容器执行：凭证代理 + 挂载验证 + Docker 容器 ──
        const creds = await credProxy.createSession(task.sessionId, task.groupId);
        sessionCreated = true;
        sessionToken = creds.sessionToken;
        socketPath = creds.socketPath;

        createSessionDir(config.projectRoot, task.groupId);

        const groupDir = path.resolve(config.projectRoot, 'groups', task.groupId);
        validateMounts([groupDir, socketPath]);

        result = await executionBackend.run(task, policy, {
          sessionToken,
          socketPath,
          tcpPort: creds.tcpPort,
        });
      }

      // Step 7: 发送响应（清洗输出中的标记和 JSON 残留）
      if (result.success && result.output) {
        let content = result.output;
        // 安全网：剥离容器输出标记和 JSON 包装
        content = content.replace(/SECURECLAW_OUTPUT_START\n?/g, '');
        content = content.replace(/\n?SECURECLAW_OUTPUT_END\n?/g, '');
        content = content.replace(/\\n/g, '\n');
        // 检测并提取 JSON 包装
        if (content.startsWith('{') && content.includes('"result"')) {
          try {
            const parsed = JSON.parse(content);
            if (parsed.result) content = String(parsed.result)
              .replace(/SECURECLAW_OUTPUT_START\n?/g, '')
              .replace(/\n?SECURECLAW_OUTPUT_END\n?/g, '')
              .replace(/\\n/g, '\n');
          } catch { /* 不是 JSON */ }
        }
        content = content.trim();

        if (content) {
          const group = db.getGroup(task.groupId);
          await sendMessage({
            groupId: task.groupId,
            content,
            replyToId: task.sourceMessageId,
            channelType: group?.channel_type ?? 'unknown',
          });

          // Step 7.5: 记录助手对话轮次（多轮上下文）
          try {
            db.insertTurn({
              id: `turn-${task.taskId}`,
              group_id: task.groupId,
              sender_id: 'assistant',
              sender_name: 'assistant',
              role: 'assistant',
              content: content.length > 2000 ? content.slice(0, 2000) + '...' : content,
              timestamp: Date.now(),
              source_message_id: task.taskId,
            });
          } catch {
            // 对话轮次写入失败不影响主流程
          }
        }
      }

      // Step 8: 更新会话状态
      db.updateSessionStatus(
        task.sessionId,
        result.success ? 'completed' : 'failed',
      );

      // Step 9: 标记消息已处理
      if (task.sourceMessageId) {
        db.markMessageProcessed(task.sourceMessageId);
      }

      // Step 12: 写审计日志 — task_completed
      await audit.append({
        entryId: generateId(),
        timestamp: Date.now(),
        eventType: 'task_completed',
        groupId: task.groupId,
        sessionId: task.sessionId,
        actorId: 'system',
        payload: {
          taskId: task.taskId,
          success: result.success,
          durationMs: result.durationMs,
          error: result.error,
        },
      });

    } catch (err: any) {
      // 异常处理：更新会话状态为 failed
      try {
        db.updateSessionStatus(task.sessionId, 'failed');
      } catch {
        // DB 更新失败也要继续清理
      }

      // 写错误审计日志
      try {
        await audit.append({
          entryId: generateId(),
          timestamp: Date.now(),
          eventType: 'task_completed',
          groupId: task.groupId,
          sessionId: task.sessionId,
          actorId: 'system',
          payload: {
            taskId: task.taskId,
            success: false,
            error: err.message || 'Unknown error',
          },
        });
      } catch {
        // 审计写入失败，不影响清理
      }
    } finally {
      // Step 10: 销毁凭证会话（始终执行）
      if (sessionCreated) {
        try {
          await credProxy.destroySession(task.sessionId);
        } catch {
          // 忽略销毁失败
        }
      }

      // Step 11: 清理会话目录（始终执行）
      try {
        cleanSessionDir(config.projectRoot, task.groupId);
      } catch {
        // 忽略清理失败
      }
    }
  };
}

