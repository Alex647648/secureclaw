// src/integration/message-pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMessagePipeline } from './message-pipeline';
import { SecureClawDB } from '../db/db';
import { LocalAuditBackend } from '../audit/backend/local-audit';
import { RateLimiter } from '../trust/rate-limiter';
import { TaskBuilder } from '../routing/task-builder';
import { GroupQueue } from '../routing/group-queue';
import { TrustLevel, type RawMessage } from '../core/types';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-pipeline-test-' + Date.now());
let db: SecureClawDB;
let audit: LocalAuditBackend;
let rateLimiter: RateLimiter;
let taskBuilder: TaskBuilder;
let groupQueue: GroupQueue;
let enqueued: string[];

function makeRaw(content: string, overrides?: Partial<RawMessage>): RawMessage {
  return {
    channelType: 'whatsapp',
    rawPayload: {
      key: { remoteJid: '12345@g.us', participant: 'user-1@s.whatsapp.net', id: 'wamid-123' },
      pushName: 'Alice',
      message: { conversation: content },
    },
    receivedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  audit = new LocalAuditBackend(db.getDatabase());
  rateLimiter = new RateLimiter();
  taskBuilder = new TaskBuilder({ projectRoot: tmpDir });
  enqueued = [];
  groupQueue = new GroupQueue(5, async (task) => {
    enqueued.push(task.taskId);
  });

  db.createGroup({
    id: 'test-group',
    name: 'Test Group',
    channel_type: 'whatsapp',
    channel_id: '12345@g.us',
    trust_level: TrustLevel.TRUSTED,
    network_policy: 'claude_only',
    is_admin_group: 0,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createMessagePipeline', () => {
  it('should process a valid message end-to-end', async () => {
    const pipeline = createMessagePipeline(
      { triggerWord: '@Andy' },
      db, audit, rateLimiter, taskBuilder, groupQueue,
    );

    const result = await pipeline.process(makeRaw('@Andy 帮我查天气'));
    expect(result.accepted).toBe(true);
    expect(result.taskId).toBeDefined();

    // 等待入队处理
    await groupQueue.drain(5000);
    expect(enqueued).toHaveLength(1);
  });

  it('should reject message without trigger word', async () => {
    const pipeline = createMessagePipeline(
      { triggerWord: '@Andy' },
      db, audit, rateLimiter, taskBuilder, groupQueue,
    );

    const result = await pipeline.process(makeRaw('Hello everyone'));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('trigger_word_not_matched');
  });

  it('should accept all messages when trigger word is empty', async () => {
    const pipeline = createMessagePipeline(
      { triggerWord: '' },
      db, audit, rateLimiter, taskBuilder, groupQueue,
    );

    const result = await pipeline.process(makeRaw('随便说什么'));
    expect(result.accepted).toBe(true);
  });

  it('should reject message from unregistered group', async () => {
    const pipeline = createMessagePipeline(
      { triggerWord: '' },
      db, audit, rateLimiter, taskBuilder, groupQueue,
    );

    const raw = makeRaw('test', {
      rawPayload: {
        key: { remoteJid: 'unknown@g.us', participant: 'user-1', id: 'wamid-456' },
        message: { conversation: 'test' },
      },
    });
    const result = await pipeline.process(raw);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('group_not_registered');
  });

  it('should reject rate-limited messages', async () => {
    const strictLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const pipeline = createMessagePipeline(
      { triggerWord: '' },
      db, audit, strictLimiter, taskBuilder, groupQueue,
    );

    // 第 1 条通过
    const r1 = await pipeline.process(makeRaw('first'));
    expect(r1.accepted).toBe(true);

    // 第 2 条被限流
    const r2 = await pipeline.process(makeRaw('second'));
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe('rate_limited');
  });

  it('should reject BLOCKED trust level messages', async () => {
    // 设置 sender 为 BLOCKED
    db.setMemberTrust('test-group', 'user-1@s.whatsapp.net', TrustLevel.BLOCKED, 'admin', 'test');

    const pipeline = createMessagePipeline(
      { triggerWord: '' },
      db, audit, rateLimiter, taskBuilder, groupQueue,
    );

    const result = await pipeline.process(makeRaw('test message'));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('trust_blocked');
  });

  it('should write audit entries during processing', async () => {
    const pipeline = createMessagePipeline(
      { triggerWord: '' },
      db, audit, rateLimiter, taskBuilder, groupQueue,
    );

    await pipeline.process(makeRaw('normal message'));

    // 应有 trust_evaluated 审计条目
    const entries = await audit.query({ eventType: 'trust_evaluated', limit: 1 });
    expect(entries).toHaveLength(1);
  });

  it('should persist message to database', async () => {
    const pipeline = createMessagePipeline(
      { triggerWord: '' },
      db, audit, rateLimiter, taskBuilder, groupQueue,
    );

    await pipeline.process(makeRaw('persist test'));

    const messages = db.getMessagesSince('test-group', 0);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some(m => m.content === 'persist test')).toBe(true);
  });

  it('should handle pipeline errors gracefully', async () => {
    // 关闭 DB 以制造错误
    const badDb = new SecureClawDB(path.join(tmpDir, 'bad.db'));
    const badAudit = new LocalAuditBackend(badDb.getDatabase());
    badDb.close(); // 关闭后所有操作都会报错

    const pipeline = createMessagePipeline(
      { triggerWord: '' },
      badDb, badAudit, rateLimiter, taskBuilder, groupQueue,
    );

    const result = await pipeline.process(makeRaw('test'));
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('pipeline_error');
  });
});
