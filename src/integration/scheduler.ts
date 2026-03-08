// src/integration/scheduler.ts
// 定时任务调度器 — 轮询 sc_scheduled_tasks，到期任务入队执行
import { CronExpressionParser } from 'cron-parser';
import type { SecureClawDB } from '../db/db';
import type { AuditBackend } from '../audit/backend/interface';
import type { TaskBuilder } from '../routing/task-builder';
import type { GroupQueue } from '../routing/group-queue';
import { generateId } from '../core/utils';

// ── 配置 ───────────────────────────────────────────────────────

export interface SchedulerConfig {
  /** 轮询间隔（毫秒），默认 30_000（30 秒） */
  pollIntervalMs: number;
  /** 时区（用于 cron 解析），默认 Asia/Shanghai */
  timezone: string;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  pollIntervalMs: 30_000,
  timezone: 'Asia/Shanghai',
};

// ── Scheduler 类 ─────────────────────────────────────────────────

export class Scheduler {
  private config: SchedulerConfig;
  private db: SecureClawDB;
  private audit: AuditBackend;
  private taskBuilder: TaskBuilder;
  private groupQueue: GroupQueue;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  constructor(
    config: Partial<SchedulerConfig>,
    db: SecureClawDB,
    audit: AuditBackend,
    taskBuilder: TaskBuilder,
    groupQueue: GroupQueue,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db;
    this.audit = audit;
    this.taskBuilder = taskBuilder;
    this.groupQueue = groupQueue;
  }

  /**
   * 启动调度器（定期轮询到期任务）。
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // 立即执行一次
    this.poll().catch(() => {});

    // 定时轮询
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.config.pollIntervalMs);
  }

  /**
   * 停止调度器。
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 单次轮询：查询到期任务并入队。
   * 此方法公开以便测试调用。
   */
  async poll(): Promise<number> {
    const dueTasks = this.db.getDueTasks();
    let enqueued = 0;

    for (const scheduled of dueTasks) {
      try {
        // 构建 AgentTask
        const task = this.taskBuilder.buildFromScheduled(
          scheduled.group_id,
          scheduled.prompt,
          scheduled.trust_level,
          scheduled.network_policy,
          this.db,
        );

        // 入队
        this.groupQueue.enqueue(task);
        enqueued++;

        // 计算下次运行时间
        const now = Date.now();
        const nextRunAt = this.computeNextRun(scheduled.cron_expression, now);
        this.db.updateTaskLastRun(scheduled.id, now, nextRunAt);

        // 写审计日志
        await this.audit.append({
          entryId: generateId(),
          timestamp: now,
          eventType: 'task_queued',
          groupId: scheduled.group_id,
          actorId: 'scheduler',
          payload: {
            action: 'scheduled_task_triggered',
            scheduledTaskId: scheduled.id,
            taskName: scheduled.name,
            taskId: task.taskId,
            nextRunAt,
          },
        });
      } catch (err: any) {
        // 单个任务调度失败不影响其他任务
        try {
          await this.audit.append({
            entryId: generateId(),
            timestamp: Date.now(),
            eventType: 'security_alert',
            groupId: scheduled.group_id,
            actorId: 'scheduler',
            payload: {
              alert: 'scheduled_task_error',
              scheduledTaskId: scheduled.id,
              error: err.message || 'Unknown scheduler error',
            },
          });
        } catch {
          // 审计写入失败，静默处理
        }
      }
    }

    return enqueued;
  }

  /**
   * 根据 cron 表达式计算下次运行时间。
   */
  computeNextRun(cronExpression: string, afterMs: number): number {
    const expr = CronExpressionParser.parse(cronExpression, {
      tz: this.config.timezone,
      currentDate: new Date(afterMs),
    });
    return expr.next().getTime();
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.running;
  }
}
