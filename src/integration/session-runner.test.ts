// src/integration/session-runner.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionRunner } from './session-runner';
import { SecureClawDB } from '../db/db';
import { LocalAuditBackend } from '../audit/backend/local-audit';
import { CredentialProxy } from '../security/credential-proxy';
import { TrustLevel, CAPABILITY_PRESETS, NETWORK_POLICY_PRESETS, type AgentTask, type AgentResult, type ExecutionPolicy } from '../core/types';
import type { ExecutionBackend } from '../execution/interface';
import { generateId } from '../core/utils';

// mount-controller 有独立测试；此处 mock 避免 tmpDir 路径校验失败
vi.mock('../security/mount-controller', () => ({
  validateMounts: vi.fn(),
}));

const tmpDir = path.join(os.tmpdir(), 'secureclaw-sessrun-test-' + Date.now());
let db: SecureClawDB;
let audit: LocalAuditBackend;
let credProxy: CredentialProxy;

function makeTask(overrides?: Partial<AgentTask>): AgentTask {
  return {
    taskId: generateId(),
    groupId: 'test-group',
    sessionId: generateId(),
    prompt: 'test prompt',
    trustLevel: TrustLevel.TRUSTED,
    capabilitySet: CAPABILITY_PRESETS[TrustLevel.TRUSTED],
    networkPolicy: NETWORK_POLICY_PRESETS.claude_only,
    source: 'message',
    sourceMessageId: 'msg-001',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMockBackend(result?: Partial<AgentResult>): ExecutionBackend {
  return {
    async run(task: AgentTask): Promise<AgentResult> {
      return {
        taskId: task.taskId,
        sessionId: task.sessionId,
        success: true,
        output: 'Hello from container',
        durationMs: 100,
        toolCallCount: 0,
        ...result,
      };
    },
    async kill() {},
    async status() { return 'unknown'; },
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  audit = new LocalAuditBackend(db.getDatabase());

  db.createGroup({
    id: 'test-group',
    name: 'Test Group',
    channel_type: 'whatsapp',
    channel_id: '12345@g.us',
    trust_level: TrustLevel.TRUSTED,
    network_policy: 'claude_only',
    is_admin_group: 0,
  });

  // 创建 group 工作目录（mount-controller 验证需要路径存在）
  fs.mkdirSync(path.join(tmpDir, 'groups', 'test-group'), { recursive: true });

  const credDir = path.join(tmpDir, 'creds');
  fs.mkdirSync(credDir, { recursive: true });
  credProxy = new CredentialProxy('sk-test-key', {
    socketDir: credDir,
    maxRequestsPerSession: 3,
  });
});

afterEach(async () => {
  await credProxy.stop();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSessionRunner', () => {
  it('should execute full lifecycle successfully', async () => {
    const sent: any[] = [];
    const runner = createSessionRunner(
      { projectRoot: tmpDir, timeoutMs: 30000, memoryMb: 512, cpuCount: 1 },
      makeMockBackend(),
      credProxy,
      db,
      audit,
      async (msg) => { sent.push(msg); },
    );

    const task = makeTask();
    await runner(task);

    // 检查会话已创建并完成
    const session = db.getSession(task.sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('completed');

    // 检查消息已发送
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe('Hello from container');

    // 检查审计日志
    const entries = await audit.query({ eventType: 'container_spawned', limit: 1 });
    expect(entries).toHaveLength(1);
    const completed = await audit.query({ eventType: 'task_completed', limit: 1 });
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toHaveProperty('success', true);
  });

  it('should handle container failure gracefully', async () => {
    const runner = createSessionRunner(
      { projectRoot: tmpDir, timeoutMs: 30000, memoryMb: 512, cpuCount: 1 },
      makeMockBackend({ success: false, output: undefined, error: 'Container timed out' }),
      credProxy,
      db,
      audit,
      async () => {},
    );

    const task = makeTask();
    await runner(task);

    const session = db.getSession(task.sessionId);
    expect(session!.status).toBe('failed');
  });

  it('should not send message when container has no output', async () => {
    const sent: any[] = [];
    const runner = createSessionRunner(
      { projectRoot: tmpDir, timeoutMs: 30000, memoryMb: 512, cpuCount: 1 },
      makeMockBackend({ success: false, output: undefined }),
      credProxy,
      db,
      audit,
      async (msg) => { sent.push(msg); },
    );

    await runner(makeTask());
    expect(sent).toHaveLength(0);
  });

  it('should cleanup credential session even on error', async () => {
    const errorBackend: ExecutionBackend = {
      async run() { throw new Error('Container crash'); },
      async kill() {},
      async status() { return 'unknown'; },
    };

    const runner = createSessionRunner(
      { projectRoot: tmpDir, timeoutMs: 30000, memoryMb: 512, cpuCount: 1 },
      errorBackend,
      credProxy,
      db,
      audit,
      async () => {},
    );

    const task = makeTask();
    await runner(task);

    // 凭证会话已被销毁
    expect(credProxy.getActiveSessionCount()).toBe(0);
  });

  it('should mark source message as processed', async () => {
    // 先插入消息
    db.insertMessage({
      id: 'msg-proc-001',
      group_id: 'test-group',
      sender_id: 'user-1',
      sender_name: 'Alice',
      content: 'test',
      content_type: 'text',
      trust_level: TrustLevel.TRUSTED,
      injection_score: 0,
      timestamp: Date.now(),
    });

    const runner = createSessionRunner(
      { projectRoot: tmpDir, timeoutMs: 30000, memoryMb: 512, cpuCount: 1 },
      makeMockBackend(),
      credProxy,
      db,
      audit,
      async () => {},
    );

    await runner(makeTask({ sourceMessageId: 'msg-proc-001' }));

    // 检查消息标记为已处理
    const allMessages = db.getMessagesSince('test-group', 0);
    const msg = allMessages.find(m => m.id === 'msg-proc-001');
    expect(msg).toBeDefined();
    expect(msg!.processed).toBe(1);
  });

  it('should pass CredentialContext to execution backend', async () => {
    let capturedCredentials: { sessionToken: string; socketPath: string } | undefined;
    const captureBackend: ExecutionBackend = {
      async run(task, _policy, credentials) {
        capturedCredentials = credentials;
        return { taskId: task.taskId, sessionId: task.sessionId, success: true, output: 'ok', durationMs: 1, toolCallCount: 0 };
      },
      async kill() {},
      async status() { return 'unknown'; },
    };

    const runner = createSessionRunner(
      { projectRoot: tmpDir, timeoutMs: 30000, memoryMb: 512, cpuCount: 1 },
      captureBackend,
      credProxy,
      db,
      audit,
      async () => {},
    );

    await runner(makeTask());
    expect(capturedCredentials).toBeDefined();
    expect(capturedCredentials!.sessionToken).toBeTruthy();
    expect(capturedCredentials!.socketPath).toBeTruthy();
  });
});
