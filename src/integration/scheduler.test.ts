// src/integration/scheduler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Scheduler } from './scheduler';
import { SecureClawDB } from '../db/db';
import { LocalAuditBackend } from '../audit/backend/local-audit';
import { TaskBuilder } from '../routing/task-builder';
import { GroupQueue } from '../routing/group-queue';
import { TrustLevel } from '../core/types';
import { generateId } from '../core/utils';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-scheduler-test-' + Date.now());
let db: SecureClawDB;
let audit: LocalAuditBackend;
let taskBuilder: TaskBuilder;
let groupQueue: GroupQueue;
let enqueued: string[];

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  audit = new LocalAuditBackend(db.getDatabase());
  taskBuilder = new TaskBuilder({ projectRoot: tmpDir });
  enqueued = [];
  groupQueue = new GroupQueue(5, async (task) => {
    enqueued.push(task.taskId);
  });

  db.createGroup({
    id: 'sched-group',
    name: 'Scheduled Group',
    channel_type: 'whatsapp',
    channel_id: 'sched@g.us',
    trust_level: TrustLevel.TRUSTED,
    network_policy: 'claude_only',
    is_admin_group: 0,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Scheduler', () => {
  it('should poll and enqueue due tasks', async () => {
    // 创建一个已到期的定时任务
    db.createTask({
      id: generateId(),
      group_id: 'sched-group',
      name: 'daily-check',
      cron_expression: '*/5 * * * *',
      prompt: 'Run daily check',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      enabled: 1,
      last_run_at: null,
      next_run_at: Date.now() - 1000, // 已到期
      created_at: Date.now(),
      created_by: 'admin',
    });

    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    const count = await scheduler.poll();
    expect(count).toBe(1);

    // 等待入队处理
    await groupQueue.drain(5000);
    expect(enqueued).toHaveLength(1);
  });

  it('should not enqueue tasks that are not due', async () => {
    db.createTask({
      id: generateId(),
      group_id: 'sched-group',
      name: 'future-task',
      cron_expression: '0 0 * * *',
      prompt: 'Future task',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      enabled: 1,
      last_run_at: null,
      next_run_at: Date.now() + 86400_000, // 明天
      created_at: Date.now(),
      created_by: 'admin',
    });

    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    const count = await scheduler.poll();
    expect(count).toBe(0);
  });

  it('should not enqueue disabled tasks', async () => {
    db.createTask({
      id: generateId(),
      group_id: 'sched-group',
      name: 'disabled-task',
      cron_expression: '* * * * *',
      prompt: 'Disabled',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      enabled: 0, // 已禁用
      last_run_at: null,
      next_run_at: Date.now() - 1000,
      created_at: Date.now(),
      created_by: 'admin',
    });

    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    const count = await scheduler.poll();
    expect(count).toBe(0);
  });

  it('should update last_run_at and next_run_at after execution', async () => {
    const taskId = generateId();
    db.createTask({
      id: taskId,
      group_id: 'sched-group',
      name: 'update-test',
      cron_expression: '0 * * * *', // 每小时
      prompt: 'test',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      enabled: 1,
      last_run_at: null,
      next_run_at: Date.now() - 1000,
      created_at: Date.now(),
      created_by: 'admin',
    });

    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    await scheduler.poll();

    // 验证更新
    const tasks = db.listTasks('sched-group');
    const updated = tasks.find(t => t.id === taskId);
    expect(updated).toBeDefined();
    expect(updated!.last_run_at).not.toBeNull();
    expect(updated!.next_run_at).toBeGreaterThan(Date.now());
  });

  it('should compute next run time correctly', () => {
    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    const now = new Date('2026-03-01T12:00:00Z').getTime();
    const nextRun = scheduler.computeNextRun('0 13 * * *', now); // 每天 13:00 UTC
    const nextDate = new Date(nextRun);
    expect(nextDate.getUTCHours()).toBe(13);
    expect(nextDate.getUTCMinutes()).toBe(0);
  });

  it('should start and stop correctly', async () => {
    const scheduler = new Scheduler(
      { pollIntervalMs: 100, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    scheduler.start();
    expect(scheduler.isRunning).toBe(true);

    // 等一小段时间让至少一次 poll 执行
    await new Promise(r => setTimeout(r, 50));

    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('should handle multiple due tasks', async () => {
    for (let i = 0; i < 3; i++) {
      db.createTask({
        id: generateId(),
        group_id: 'sched-group',
        name: `task-${i}`,
        cron_expression: '* * * * *',
        prompt: `Task ${i}`,
        trust_level: TrustLevel.TRUSTED,
        network_policy: 'claude_only',
        enabled: 1,
        last_run_at: null,
        next_run_at: Date.now() - 1000,
        created_at: Date.now(),
        created_by: 'admin',
      });
    }

    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    const count = await scheduler.poll();
    expect(count).toBe(3);
  });

  it('should write audit log for triggered tasks', async () => {
    db.createTask({
      id: generateId(),
      group_id: 'sched-group',
      name: 'audit-test',
      cron_expression: '* * * * *',
      prompt: 'test',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      enabled: 1,
      last_run_at: null,
      next_run_at: Date.now() - 1000,
      created_at: Date.now(),
      created_by: 'admin',
    });

    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    await scheduler.poll();

    const entries = await audit.query({ eventType: 'task_queued', limit: 10 });
    const schedEntry = entries.find(e =>
      (e.payload as any).action === 'scheduled_task_triggered'
    );
    expect(schedEntry).toBeDefined();
  });

  it('should allow direct poll without start', async () => {
    const scheduler = new Scheduler(
      { pollIntervalMs: 60_000, timezone: 'UTC' },
      db, audit, taskBuilder, groupQueue,
    );

    // 无到期任务时 poll 返回 0
    const count = await scheduler.poll();
    expect(count).toBe(0);
  });
});
