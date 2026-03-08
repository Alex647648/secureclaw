// src/routing/group-queue.test.ts
import { describe, it, expect } from 'vitest';
import { GroupQueue, Semaphore } from './group-queue';
import { TrustLevel, CAPABILITY_PRESETS, NETWORK_POLICY_PRESETS, type AgentTask } from '../core/types';
import { generateId } from '../core/utils';

function makeTask(groupId: string, taskId?: string): AgentTask {
  return {
    taskId: taskId ?? generateId(),
    groupId,
    sessionId: generateId(),
    prompt: 'test prompt',
    trustLevel: TrustLevel.TRUSTED,
    capabilitySet: CAPABILITY_PRESETS[TrustLevel.TRUSTED],
    networkPolicy: NETWORK_POLICY_PRESETS.claude_only,
    source: 'message',
    createdAt: Date.now(),
  };
}

// ── Semaphore ─────────────────────────────────────────────────

describe('Semaphore', () => {
  it('should allow up to max concurrent acquires', async () => {
    const sem = new Semaphore(2);
    await sem.acquire(); // 1
    await sem.acquire(); // 2
    expect(sem.active).toBe(2);

    // 第 3 个应该排队
    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });

    // 给 microtask 机会执行
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);
    expect(sem.pendingCount).toBe(1);

    // 释放一个
    sem.release();
    await p;
    expect(resolved).toBe(true);
    expect(sem.active).toBe(2); // 仍然是 2（一个释放了，一个新进入了）
  });

  it('should handle release without pending (underflow guard)', () => {
    const sem = new Semaphore(3);
    // 没有 acquire 也 release — 不应降至负数
    sem.release();
    expect(sem.active).toBe(0);
  });

  it('should handle multiple waiters in order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release();
    await p1;
    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });
});

// ── GroupQueue ─────────────────────────────────────────────────

describe('GroupQueue', () => {
  it('should process tasks in FIFO order within a group', async () => {
    const processed: string[] = [];
    const queue = new GroupQueue(5, async (task) => {
      processed.push(task.taskId);
    });

    queue.enqueue(makeTask('group-A', 'task-1'));
    queue.enqueue(makeTask('group-A', 'task-2'));
    queue.enqueue(makeTask('group-A', 'task-3'));

    // 等待处理完
    await queue.drain(5000);
    expect(processed).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('should process different groups concurrently', async () => {
    const active: Set<string> = new Set();
    let maxConcurrent = 0;

    const queue = new GroupQueue(5, async (task) => {
      active.add(task.groupId);
      maxConcurrent = Math.max(maxConcurrent, active.size);
      await new Promise(r => setTimeout(r, 50));
      active.delete(task.groupId);
    });

    queue.enqueue(makeTask('group-A'));
    queue.enqueue(makeTask('group-B'));
    queue.enqueue(makeTask('group-C'));

    await queue.drain(5000);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('should respect maxConcurrent limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const queue = new GroupQueue(2, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
    });

    // 4 个不同 group 的任务，但并发限制为 2
    queue.enqueue(makeTask('g1'));
    queue.enqueue(makeTask('g2'));
    queue.enqueue(makeTask('g3'));
    queue.enqueue(makeTask('g4'));

    await queue.drain(5000);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('should deduplicate tasks with same taskId', async () => {
    const processed: string[] = [];
    const queue = new GroupQueue(5, async (task) => {
      processed.push(task.taskId);
    });

    queue.enqueue(makeTask('group-A', 'dup-task'));
    queue.enqueue(makeTask('group-A', 'dup-task')); // 重复
    queue.enqueue(makeTask('group-A', 'other-task'));

    await queue.drain(5000);
    expect(processed).toEqual(['dup-task', 'other-task']);
  });

  it('should handle handler errors without stopping queue', async () => {
    const processed: string[] = [];
    let callCount = 0;

    const queue = new GroupQueue(5, async (task) => {
      callCount++;
      if (task.taskId === 'fail-task') {
        throw new Error('handler error');
      }
      processed.push(task.taskId);
    });

    queue.enqueue(makeTask('group-A', 'fail-task'));
    queue.enqueue(makeTask('group-A', 'ok-task'));

    await queue.drain(5000);
    expect(callCount).toBe(2);
    expect(processed).toEqual(['ok-task']);
  });

  it('should reject enqueue after stop', async () => {
    const queue = new GroupQueue(5, async () => {});
    queue.clear();
    expect(() => queue.enqueue(makeTask('g1'))).toThrow('stopped');
  });

  it('should track queue length and active count', () => {
    const queue = new GroupQueue(5, async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    queue.enqueue(makeTask('g1', 't1'));
    queue.enqueue(makeTask('g1', 't2'));

    // t1 可能已经开始处理，t2 在队列中
    expect(queue.getQueueLength('g1')).toBeLessThanOrEqual(2);
    expect(queue.getTotalPending()).toBeLessThanOrEqual(2);
  });

  it('should drain with timeout', async () => {
    const queue = new GroupQueue(1, async () => {
      await new Promise(r => setTimeout(r, 5000)); // 长任务
    });

    queue.enqueue(makeTask('g1'));

    const start = Date.now();
    await queue.drain(100); // 100ms 超时
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  it('should reject enqueue after drain', async () => {
    const queue = new GroupQueue(5, async () => {});
    await queue.drain(100);
    expect(() => queue.enqueue(makeTask('g1'))).toThrow('stopped');
  });

  it('should deduplicate taskId across different groups', async () => {
    const processed: string[] = [];
    const queue = new GroupQueue(5, async (task) => {
      processed.push(`${task.groupId}:${task.taskId}`);
    });

    queue.enqueue(makeTask('group-A', 'shared-id'));
    queue.enqueue(makeTask('group-B', 'shared-id')); // 应被去重

    await queue.drain(5000);
    expect(processed).toEqual(['group-A:shared-id']);
  });
});

// ── Semaphore 边界测试 ──────────────────────────────────────────

describe('Semaphore constructor validation', () => {
  it('should reject max=0', () => {
    expect(() => new Semaphore(0)).toThrow('positive integer');
  });

  it('should reject negative max', () => {
    expect(() => new Semaphore(-1)).toThrow('positive integer');
  });

  it('should reject non-integer max', () => {
    expect(() => new Semaphore(1.5)).toThrow('positive integer');
  });

  it('should reject NaN', () => {
    expect(() => new Semaphore(NaN)).toThrow('positive integer');
  });

  it('should accept max=1', () => {
    expect(() => new Semaphore(1)).not.toThrow();
  });
});
