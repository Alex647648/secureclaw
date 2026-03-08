// src/routing/group-queue.ts
// 每 group FIFO 队列 + 全局信号量并发控制
import type { AgentTask } from '../core/types';

// ── 信号量（Promise 队列实现，无外部依赖） ──────────────────

export class Semaphore {
  private current: number = 0;
  private readonly max: number;
  private waiting: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore max must be a positive integer, got ${max}`);
    }
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    } else if (this.current > 0) {
      this.current--;
    }
  }

  /** 当前活跃数 */
  get active(): number {
    return this.current;
  }

  /** 等待队列长度 */
  get pendingCount(): number {
    return this.waiting.length;
  }
}

// ── 任务处理器类型 ─────────────────────────────────────────────

export type TaskHandler = (task: AgentTask) => Promise<void>;

// ── GroupQueue ─────────────────────────────────────────────────

/** 每个 group 的默认最大队列深度 */
const DEFAULT_MAX_QUEUE_DEPTH = 20;

export class GroupQueue {
  private queues: Map<string, AgentTask[]> = new Map();
  private activeHandlers: Map<string, Promise<void>> = new Map();
  private pendingTaskIds: Set<string> = new Set();
  private semaphore: Semaphore;
  private handler: TaskHandler;
  private stopped: boolean = false;
  private maxQueueDepth: number;

  constructor(maxConcurrent: number, handler: TaskHandler, maxQueueDepth?: number) {
    this.semaphore = new Semaphore(maxConcurrent);
    this.handler = handler;
    this.maxQueueDepth = maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  }

  /**
   * 将任务加入指定 group 的队列。
   * 如果该 group 没有活跃处理器，自动启动。
   */
  enqueue(task: AgentTask): void {
    if (this.stopped) {
      throw new Error('GroupQueue is stopped, cannot enqueue');
    }

    const groupId = task.groupId;
    let queue = this.queues.get(groupId);
    if (!queue) {
      queue = [];
      this.queues.set(groupId, queue);
    }

    // 防重复提交（同 taskId，含正在处理的）
    if (this.pendingTaskIds.has(task.taskId)) {
      return;
    }

    // 队列深度限制（防止内存耗尽 DoS）
    if (queue.length >= this.maxQueueDepth) {
      throw new Error(
        `Queue depth exceeded for group "${groupId}": ${queue.length} >= ${this.maxQueueDepth}`
      );
    }

    this.pendingTaskIds.add(task.taskId);
    queue.push(task);

    // 如果该 group 没有活跃处理器，启动
    if (!this.activeHandlers.has(groupId)) {
      const processing = this.processGroupQueue(groupId);
      this.activeHandlers.set(groupId, processing);
      // 处理完成后清理
      processing.finally(() => {
        this.activeHandlers.delete(groupId);
      });
    }
  }

  /**
   * 处理指定 group 的队列（顺序执行）。
   */
  private async processGroupQueue(groupId: string): Promise<void> {
    while (true) {
      const queue = this.queues.get(groupId);
      if (!queue || queue.length === 0) break;

      const task = queue.shift()!;

      // 全局信号量控制并发
      await this.semaphore.acquire();
      try {
        await this.handler(task);
      } catch {
        // 错误由 handler 内部处理，队列继续
      } finally {
        this.semaphore.release();
        this.pendingTaskIds.delete(task.taskId);
      }
    }

    // 清理空队列
    const queue = this.queues.get(groupId);
    if (queue && queue.length === 0) {
      this.queues.delete(groupId);
    }
  }

  /**
   * 获取指定 group 的队列长度。
   */
  getQueueLength(groupId: string): number {
    return this.queues.get(groupId)?.length ?? 0;
  }

  /**
   * 获取所有 group 的总排队数。
   */
  getTotalPending(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * 获取活跃并发数。
   */
  getActiveCount(): number {
    return this.semaphore.active;
  }

  /**
   * 优雅关闭：等待所有活跃 handler 完成或超时。
   */
  async drain(timeoutMs: number): Promise<void> {
    this.stopped = true;
    const handlers = Array.from(this.activeHandlers.values());
    if (handlers.length === 0) return;

    await Promise.race([
      Promise.all(handlers),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /**
   * 强制清空所有队列（不等待活跃任务）。
   */
  clear(): void {
    this.stopped = true;
    this.queues.clear();
    this.pendingTaskIds.clear();
  }

  /** 是否已停止 */
  get isStopped(): boolean {
    return this.stopped;
  }
}
