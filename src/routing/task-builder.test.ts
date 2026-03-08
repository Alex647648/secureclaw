// src/routing/task-builder.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskBuilder, buildSystemPrompt, buildHistoryContext, loadGroupMemory } from './task-builder';
import { SecureClawDB } from '../db/db';
import { TrustLevel, CAPABILITY_PRESETS, NETWORK_POLICY_PRESETS, type TrustedMessage, type Message } from '../core/types';
import { generateId } from '../core/utils';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-taskbuilder-test-' + Date.now());
let db: SecureClawDB;

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));

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

function makeMsg(overrides?: Partial<TrustedMessage>): TrustedMessage {
  return {
    id: generateId(),
    groupId: 'test-group',
    senderId: 'user-1',
    senderName: 'Alice',
    content: '帮我查天气',
    contentType: 'text',
    timestamp: Date.now(),
    channelType: 'whatsapp',
    trustLevel: TrustLevel.TRUSTED,
    capabilitySet: CAPABILITY_PRESETS[TrustLevel.TRUSTED],
    injectionScore: 0,
    injectionFlags: [],
    ...overrides,
  };
}

// ── buildSystemPrompt ─────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('should include sender info and language rules', () => {
    const prompt = buildSystemPrompt('my-group', TrustLevel.TRUSTED, 'Alice');
    expect(prompt).toContain('Alice');
    expect(prompt).toContain('Sender: Alice');
    expect(prompt).toContain('CRITICAL RULES');
  });

  it('should include tool instructions for ADMIN', () => {
    const prompt = buildSystemPrompt('admin-group', TrustLevel.ADMIN, 'Bob');
    expect(prompt).toContain('18 local tools');
    expect(prompt).toContain('run_applescript');
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('remember');
    expect(prompt).toContain('ask_confirmation');
  });

  it('should be conversational-only for non-ADMIN', () => {
    const prompt = buildSystemPrompt('g', TrustLevel.TRUSTED, 's');
    expect(prompt).toContain('conversational assistant');
    expect(prompt).not.toContain('18 local tools');
  });

  it('should include role persistence instructions', () => {
    const prompt = buildSystemPrompt('g', TrustLevel.TRUSTED, 's');
    expect(prompt).toContain('save_memory');
    expect(prompt).toContain('role/persona');
  });
});

// ── buildHistoryContext ──────────────────────────────────────

describe('buildHistoryContext', () => {
  it('should return empty string for no messages', () => {
    expect(buildHistoryContext([], 20)).toBe('');
  });

  it('should format messages with sender name', () => {
    const messages: Message[] = [
      { id: '1', group_id: 'g', sender_id: 'u1', sender_name: 'Alice', content: 'hello', content_type: 'text', trust_level: 2, injection_score: 0, timestamp: 1000, processed: 0 },
      { id: '2', group_id: 'g', sender_id: 'u2', sender_name: 'Bob', content: 'hi', content_type: 'text', trust_level: 2, injection_score: 0, timestamp: 2000, processed: 0 },
    ];
    const result = buildHistoryContext(messages, 20);
    expect(result).toContain('[Alice]: hello');
    expect(result).toContain('[Bob]: hi');
  });

  it('should limit to maxMessages (most recent)', () => {
    const messages: Message[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i), group_id: 'g', sender_id: 'u', sender_name: `User${i}`,
      content: `msg${i}`, content_type: 'text', trust_level: 2,
      injection_score: 0, timestamp: i * 1000, processed: 0,
    }));
    const result = buildHistoryContext(messages, 5);
    expect(result).toContain('User25');
    expect(result).toContain('User29');
    expect(result).not.toContain('User0');
  });

  it('should use sender_id when sender_name is empty', () => {
    const messages: Message[] = [
      { id: '1', group_id: 'g', sender_id: 'uid-123', sender_name: '', content: 'hello', content_type: 'text', trust_level: 2, injection_score: 0, timestamp: 1000, processed: 0 },
    ];
    const result = buildHistoryContext(messages, 20);
    expect(result).toContain('[uid-123]: hello');
  });
});

// ── loadGroupMemory ──────────────────────────────────────────

describe('loadGroupMemory', () => {
  it('should return empty string when no memory file', () => {
    expect(loadGroupMemory(tmpDir, 'nonexistent')).toBe('');
  });

  it('should load CLAUDE.md content', () => {
    const groupDir = path.join(tmpDir, 'groups', 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), 'Memory content here');

    const result = loadGroupMemory(tmpDir, 'test-group');
    expect(result).toContain('Memory content here');
    expect(result).toContain('Group memory');
  });

  it('should return empty string for empty CLAUDE.md', () => {
    const groupDir = path.join(tmpDir, 'groups', 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '');

    expect(loadGroupMemory(tmpDir, 'test-group')).toBe('');
  });
});

// ── TaskBuilder.build ────────────────────────────────────────

describe('TaskBuilder.build', () => {
  it('should create a valid AgentTask', () => {
    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const msg = makeMsg();
    const task = builder.build(msg, db);

    expect(task.taskId).toMatch(/^[0-9a-f]{32}$/);
    expect(task.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(task.groupId).toBe('test-group');
    expect(task.trustLevel).toBe(TrustLevel.TRUSTED);
    expect(task.capabilitySet).toEqual(CAPABILITY_PRESETS[TrustLevel.TRUSTED]);
    expect(task.source).toBe('message');
    expect(task.sourceMessageId).toBe(msg.id);
  });

  it('should include user message in prompt', () => {
    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const task = builder.build(makeMsg({ content: '特定内容测试' }), db);
    expect(task.prompt).toContain('特定内容测试');
  });

  it('should use group network policy', () => {
    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const task = builder.build(makeMsg(), db);
    expect(task.networkPolicy.preset).toBe('claude_only');
  });

  it('should include history messages in prompt', () => {
    // 插入一条历史消息
    db.insertMessage({
      id: 'hist-1',
      group_id: 'test-group',
      sender_id: 'user-1',
      sender_name: 'Alice',
      content: '之前说的话',
      content_type: 'text',
      trust_level: TrustLevel.TRUSTED,
      injection_score: 0,
      timestamp: Date.now() - 10000,
    });

    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const task = builder.build(makeMsg(), db);
    expect(task.prompt).toContain('之前说的话');
  });

  it('should include group memory in prompt', () => {
    const groupDir = path.join(tmpDir, 'groups', 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '项目要求：使用 TypeScript');

    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const task = builder.build(makeMsg(), db);
    expect(task.prompt).toContain('项目要求：使用 TypeScript');
  });

  it('should generate unique taskId and sessionId', () => {
    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const t1 = builder.build(makeMsg(), db);
    const t2 = builder.build(makeMsg(), db);
    expect(t1.taskId).not.toBe(t2.taskId);
    expect(t1.sessionId).not.toBe(t2.sessionId);
  });
});

// ── loadGroupMemory path traversal guard ─────────────────────

describe('loadGroupMemory path safety', () => {
  it('should return empty for path traversal groupId', () => {
    expect(loadGroupMemory(tmpDir, '../etc')).toBe('');
    expect(loadGroupMemory(tmpDir, 'has space')).toBe('');
    expect(loadGroupMemory(tmpDir, '')).toBe('');
  });
});

// ── TaskBuilder.buildFromScheduled ───────────────────────────

describe('TaskBuilder.buildFromScheduled', () => {
  it('should create a valid scheduled AgentTask', () => {
    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const task = builder.buildFromScheduled(
      'test-group', 'Run daily check', TrustLevel.TRUSTED, 'claude_only', db,
    );
    expect(task.source).toBe('scheduled');
    expect(task.prompt).toContain('Run daily check');
    expect(task.prompt).toContain('scheduled-task');
    expect(task.groupId).toBe('test-group');
    expect(task.trustLevel).toBe(TrustLevel.TRUSTED);
    expect(task.capabilitySet).toEqual(CAPABILITY_PRESETS[TrustLevel.TRUSTED]);
  });

  it('should use BLOCKED capabilities for non-existent group', () => {
    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const task = builder.buildFromScheduled(
      'nonexistent-group', 'test', TrustLevel.TRUSTED, 'claude_only', db,
    );
    expect(task.capabilitySet).toEqual(CAPABILITY_PRESETS[TrustLevel.BLOCKED]);
  });

  it('should fall back to claude_only for unknown network policy', () => {
    const builder = new TaskBuilder({ projectRoot: tmpDir });
    const task = builder.buildFromScheduled(
      'test-group', 'test', TrustLevel.TRUSTED, 'nonexistent_policy', db,
    );
    expect(task.networkPolicy).toEqual(NETWORK_POLICY_PRESETS.claude_only);
  });
});
