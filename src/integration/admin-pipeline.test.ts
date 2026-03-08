// src/integration/admin-pipeline.test.ts
// 管理员命令 × 消息管线集成测试 — 完整 E2E 流程验证
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMessagePipeline } from './message-pipeline';
import { AdminCommandHandler } from '../admin/command-handler';
import { SecureClawDB } from '../db/db';
import { LocalAuditBackend } from '../audit/backend/local-audit';
import { RateLimiter } from '../trust/rate-limiter';
import { TaskBuilder } from '../routing/task-builder';
import { GroupQueue } from '../routing/group-queue';
import { TrustLevel, type RawMessage, type OutboundMessage } from '../core/types';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-admin-pipeline-test-' + Date.now());
let db: SecureClawDB;
let audit: LocalAuditBackend;
let adminHandler: AdminCommandHandler;
let responses: OutboundMessage[];

function makeRaw(content: string, overrides?: Partial<RawMessage>): RawMessage {
  return {
    channelType: 'whatsapp',
    rawPayload: {
      key: { remoteJid: '120363@g.us', participant: 'admin-1@s.whatsapp.net', id: 'wamid-001' },
      pushName: 'Admin',
      message: { conversation: content },
    },
    receivedAt: Date.now(),
    ...overrides,
  };
}

function makeRawFrom(content: string, participant: string): RawMessage {
  return {
    channelType: 'whatsapp',
    rawPayload: {
      key: { remoteJid: '120363@g.us', participant, id: 'wamid-' + Date.now() },
      pushName: 'User',
      message: { conversation: content },
    },
    receivedAt: Date.now(),
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  audit = new LocalAuditBackend(db.getDatabase());
  adminHandler = new AdminCommandHandler(db, audit);
  responses = [];

  // 创建管理员群组
  db.createGroup({
    id: 'admin-grp',
    name: 'Admin Group',
    channel_type: 'whatsapp',
    channel_id: '120363@g.us',
    trust_level: TrustLevel.ADMIN,
    network_policy: 'claude_only',
    is_admin_group: 1,
  });

  // 设置管理员信任
  db.setMemberTrust('admin-grp', 'admin-1@s.whatsapp.net', TrustLevel.ADMIN, 'system', 'bootstrap');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Admin commands through pipeline', () => {
  it('should execute admin command and send response', async () => {
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    const result = await pipeline.process(makeRaw('@Bot !admin status'));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('admin_command_executed');

    // 应该收到状态回复
    expect(responses).toHaveLength(1);
    expect(responses[0].content).toContain('SecureClaw Status');
    expect(responses[0].groupId).toBe('admin-grp');
    expect(responses[0].channelType).toBe('whatsapp');
  });

  it('should reject admin command from non-admin user in trusted group', async () => {
    // 创建一个 TRUSTED 级别的群组
    db.createGroup({
      id: 'trusted-grp',
      name: 'Trusted Group',
      channel_type: 'whatsapp',
      channel_id: '55555@g.us',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      is_admin_group: 0,
    });

    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    // 在 TRUSTED 群组中的用户尝试执行管理员命令
    const raw: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: {
        key: { remoteJid: '55555@g.us', participant: 'user-99@s.whatsapp.net', id: 'wamid-x' },
        pushName: 'User',
        message: { conversation: '@Bot !admin group list' },
      },
      receivedAt: Date.now(),
    };
    const result = await pipeline.process(raw);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('admin_command_unauthorized');

    // 不应发送任何响应
    expect(responses).toHaveLength(0);
  });

  it('should audit unauthorized admin command attempt', async () => {
    // 创建 TRUSTED 群组
    db.createGroup({
      id: 'audit-grp',
      name: 'Audit Group',
      channel_type: 'whatsapp',
      channel_id: '77777@g.us',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      is_admin_group: 0,
    });

    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    const raw: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: {
        key: { remoteJid: '77777@g.us', participant: 'user-99@s.whatsapp.net', id: 'wamid-audit' },
        pushName: 'User',
        message: { conversation: '@Bot !admin help' },
      },
      receivedAt: Date.now(),
    };
    await pipeline.process(raw);

    // 应有安全告警审计日志
    const entries = await audit.query({ eventType: 'security_alert', limit: 10 });
    const alert = entries.find(
      (e) => e.payload && (e.payload as any).alert === 'admin_command_unauthorized',
    );
    expect(alert).toBeDefined();
    expect(alert!.actorId).toBe('user-99@s.whatsapp.net');
  });

  it('should execute group add via pipeline', async () => {
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    const result = await pipeline.process(
      makeRaw('@Bot !admin group add new-grp whatsapp 99999@g.us New Group'),
    );
    expect(result.accepted).toBe(true);

    expect(responses).toHaveLength(1);
    expect(responses[0].content).toContain('已创建');

    // 验证 DB
    const group = db.getGroup('new-grp');
    expect(group).not.toBeNull();
    expect(group!.name).toBe('New Group');
  });

  it('should execute trust set via pipeline', async () => {
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    const result = await pipeline.process(
      makeRaw('@Bot !admin trust set admin-grp user-42 2'),
    );
    expect(result.accepted).toBe(true);
    expect(responses[0].content).toContain('TRUSTED');

    const level = db.getMemberTrust('admin-grp', 'user-42');
    expect(level).toBe(TrustLevel.TRUSTED);
  });

  it('should pass non-admin messages through normally', async () => {
    const enqueued: string[] = [];
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async (task) => { enqueued.push(task.taskId); }),
    );

    // 非 !admin 命令 — 正常管线处理
    const result = await pipeline.process(makeRaw('@Bot 帮我查天气'));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined(); // 不是 admin_command_executed
    expect(result.taskId).toBeDefined();

    // 不应发送管理员回复
    expect(responses).toHaveLength(0);
  });

  it('should reject admin command from sender without explicit ADMIN trust (even in admin group)', async () => {
    // 安全加固：admin 命令不再回退到群组默认信任，必须有显式 ADMIN 权限
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    // unknown-admin 未设置个人信任，即使群组默认是 ADMIN 也应被拒绝
    const raw = makeRawFrom('@Bot !admin status', 'unknown-admin@s.whatsapp.net');
    const result = await pipeline.process(raw);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('admin_command_unauthorized');
  });

  it('should reject admin command from BLOCKED user even in admin group', async () => {
    db.setMemberTrust('admin-grp', 'blocked-user@s.whatsapp.net', TrustLevel.BLOCKED, 'admin-1', 'test');

    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    const raw = makeRawFrom('@Bot !admin status', 'blocked-user@s.whatsapp.net');
    const result = await pipeline.process(raw);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('admin_command_unauthorized');
  });

  it('should reject admin command from TRUSTED user (needs ADMIN)', async () => {
    db.setMemberTrust('admin-grp', 'trusted-user@s.whatsapp.net', TrustLevel.TRUSTED, 'admin-1', 'test');

    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    const raw = makeRawFrom('@Bot !admin group list', 'trusted-user@s.whatsapp.net');
    const result = await pipeline.process(raw);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('admin_command_unauthorized');
  });

  it('should work without adminHandler (backward compatible)', async () => {
    const enqueued: string[] = [];
    const pipeline = createMessagePipeline(
      { triggerWord: '@Bot' }, // 没有 adminHandler
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async (task) => { enqueued.push(task.taskId); }),
    );

    // !admin 消息被当作普通消息处理
    const result = await pipeline.process(makeRaw('@Bot !admin status'));
    expect(result.accepted).toBe(true);
    // 应该作为普通任务入队
    expect(result.taskId).toBeDefined();
  });

  it('should include replyToId in admin response', async () => {
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    await pipeline.process(makeRaw('@Bot !admin help'));

    expect(responses).toHaveLength(1);
    // replyToId 应为消息的 normalized id
    expect(responses[0].replyToId).toBeDefined();
  });

  it('should handle admin command even without sendResponse callback', async () => {
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        // 故意不提供 sendResponse
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    // 不应抛出
    const result = await pipeline.process(makeRaw('@Bot !admin status'));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('admin_command_executed');
  });

  // ── BUG-FIX 回归：消息不重复插入 ──────────────────────────────

  it('should not create duplicate messages after trust evaluation', async () => {
    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    // 发送普通消息（非管理员命令）
    await pipeline.process(makeRaw('@Bot 帮我查天气'));

    // 检查消息表 — 应该只有 1 条记录，不应有 _eval 后缀的重复
    const messages = db.getMessagesSince('admin-grp', 0);
    const evalDuplicates = messages.filter(m => m.id.endsWith('_eval'));
    expect(evalDuplicates).toHaveLength(0);
  });

  // ── BUG-FIX 回归：管理员命令需要显式信任 ─────────────────────

  it('should require explicit ADMIN trust for admin commands (security hardening)', async () => {
    // 创建 ADMIN 级别群组但不设置个人信任
    db.createGroup({
      id: 'admin2',
      name: 'Admin2',
      channel_type: 'whatsapp',
      channel_id: '88888@g.us',
      trust_level: TrustLevel.ADMIN,
      network_policy: 'claude_only',
      is_admin_group: 1,
    });

    const pipeline = createMessagePipeline(
      {
        triggerWord: '@Bot',
        adminHandler,
        sendResponse: async (msg) => { responses.push(msg); },
      },
      db, audit, new RateLimiter(), new TaskBuilder({ projectRoot: tmpDir }),
      new GroupQueue(5, async () => {}),
    );

    const raw: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: {
        key: { remoteJid: '88888@g.us', participant: 'newcomer@s.whatsapp.net', id: 'wamid-new' },
        pushName: 'NewUser',
        message: { conversation: '@Bot !admin group list' },
      },
      receivedAt: Date.now(),
    };

    const result = await pipeline.process(raw);
    // 即使群组是 ADMIN 级别，没有显式个人信任的用户也不能执行管理员命令
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('admin_command_unauthorized');
  });
});
