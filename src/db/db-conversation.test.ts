// src/db/db-conversation.test.ts
// 多轮对话上下文 — sc_conversation_turns 数据库层单元测试
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SecureClawDB } from './db';
import { TrustLevel } from '../core/types';

let tmpDir: string;
let db: SecureClawDB;
const GROUP_ID = 'conv-test-group';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-conv-test-'));
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  db.createGroup({
    id: GROUP_ID,
    name: 'Conv Test Group',
    channel_type: 'discord',
    channel_id: 'ch-conv',
    trust_level: TrustLevel.ADMIN,
    network_policy: 'trusted',
    is_admin_group: 1,
  });
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 清理辅助 ────────────────────────────────────────────────────

let turnCounter = 0;
function nextId(): string {
  return `turn-test-${++turnCounter}`;
}

// ══════════════════════════════════════════════════════════════════
// insertTurn
// ══════════════════════════════════════════════════════════════════

describe('insertTurn', () => {
  it('应插入用户轮次', () => {
    const id = nextId();
    db.insertTurn({
      id,
      group_id: GROUP_ID,
      sender_id: 'user-001',
      sender_name: 'Alice',
      role: 'user',
      content: '你好',
      timestamp: 1000,
      source_message_id: 'msg-001',
    });
    const turns = db.getRecentTurns(GROUP_ID, 0, 100);
    const found = turns.find(t => t.id === id);
    expect(found).toBeDefined();
    expect(found!.role).toBe('user');
    expect(found!.content).toBe('你好');
    expect(found!.sender_name).toBe('Alice');
  });

  it('应插入助手轮次', () => {
    const id = nextId();
    db.insertTurn({
      id,
      group_id: GROUP_ID,
      sender_id: 'assistant',
      sender_name: 'assistant',
      role: 'assistant',
      content: '你好！有什么可以帮你的吗？',
      timestamp: 2000,
      source_message_id: 'task-001',
    });
    const turns = db.getRecentTurns(GROUP_ID, 0, 100);
    const found = turns.find(t => t.id === id);
    expect(found).toBeDefined();
    expect(found!.role).toBe('assistant');
  });

  it('重复 ID 应抛出错误', () => {
    const id = nextId();
    db.insertTurn({
      id,
      group_id: GROUP_ID,
      sender_id: 'user-001',
      sender_name: 'Alice',
      role: 'user',
      content: 'first',
      timestamp: 3000,
      source_message_id: 'msg-dup',
    });
    expect(() => db.insertTurn({
      id,
      group_id: GROUP_ID,
      sender_id: 'user-001',
      sender_name: 'Alice',
      role: 'user',
      content: 'duplicate',
      timestamp: 3001,
      source_message_id: 'msg-dup2',
    })).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// getRecentTurns
// ══════════════════════════════════════════════════════════════════

describe('getRecentTurns', () => {
  const OTHER_GROUP = 'conv-other-group';

  beforeAll(() => {
    db.createGroup({
      id: OTHER_GROUP,
      name: 'Other',
      channel_type: 'discord',
      channel_id: 'ch-other',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      is_admin_group: 0,
    });
  });

  it('应按时间正序返回', () => {
    // 插入乱序数据
    db.insertTurn({
      id: nextId(), group_id: GROUP_ID,
      sender_id: 'user-001', sender_name: 'Alice', role: 'user',
      content: 'third', timestamp: 30000, source_message_id: 'o3',
    });
    db.insertTurn({
      id: nextId(), group_id: GROUP_ID,
      sender_id: 'user-001', sender_name: 'Alice', role: 'user',
      content: 'first', timestamp: 10000, source_message_id: 'o1',
    });
    db.insertTurn({
      id: nextId(), group_id: GROUP_ID,
      sender_id: 'assistant', sender_name: 'assistant', role: 'assistant',
      content: 'second', timestamp: 20000, source_message_id: 'o2',
    });

    const turns = db.getRecentTurns(GROUP_ID, 10000, 100);
    // 验证正序
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i].timestamp).toBeGreaterThanOrEqual(turns[i - 1].timestamp);
    }
  });

  it('应遵守 since 时间过滤', () => {
    const turns = db.getRecentTurns(GROUP_ID, 25000, 100);
    for (const t of turns) {
      expect(t.timestamp).toBeGreaterThanOrEqual(25000);
    }
  });

  it('应遵守 limit 限制', () => {
    const turns = db.getRecentTurns(GROUP_ID, 0, 2);
    expect(turns.length).toBeLessThanOrEqual(2);
  });

  it('limit 应取最新的 N 条（而非最旧）', () => {
    const turns = db.getRecentTurns(GROUP_ID, 0, 2);
    // 取最新 2 条，应包含 timestamp 最大的
    if (turns.length === 2) {
      const allTurns = db.getRecentTurns(GROUP_ID, 0, 100);
      const maxTs = Math.max(...allTurns.map(t => t.timestamp));
      expect(turns[turns.length - 1].timestamp).toBe(maxTs);
    }
  });

  it('不同 group 的轮次应隔离', () => {
    db.insertTurn({
      id: nextId(), group_id: OTHER_GROUP,
      sender_id: 'user-002', sender_name: 'Bob', role: 'user',
      content: 'isolated message', timestamp: 50000, source_message_id: 'iso-1',
    });

    const mainTurns = db.getRecentTurns(GROUP_ID, 0, 100);
    const otherTurns = db.getRecentTurns(OTHER_GROUP, 0, 100);

    expect(mainTurns.every(t => t.group_id === GROUP_ID)).toBe(true);
    expect(otherTurns.every(t => t.group_id === OTHER_GROUP)).toBe(true);
    expect(otherTurns.some(t => t.content === 'isolated message')).toBe(true);
  });

  it('空 group 应返回空数组', () => {
    const turns = db.getRecentTurns('nonexistent-group', 0, 100);
    expect(turns).toHaveLength(0);
  });

  it('应包含 user 和 assistant 双方轮次', () => {
    const turns = db.getRecentTurns(GROUP_ID, 0, 100);
    const roles = new Set(turns.map(t => t.role));
    expect(roles.has('user')).toBe(true);
    expect(roles.has('assistant')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 多轮对话完整流程
// ══════════════════════════════════════════════════════════════════

describe('多轮对话流程', () => {
  const FLOW_GROUP = 'conv-flow-group';

  beforeAll(() => {
    db.createGroup({
      id: FLOW_GROUP,
      name: 'Flow Test',
      channel_type: 'discord',
      channel_id: 'ch-flow',
      trust_level: TrustLevel.ADMIN,
      network_policy: 'trusted',
      is_admin_group: 1,
    });
  });

  it('应正确保存和检索 user-assistant 对话对', () => {
    // 模拟 3 轮对话
    const baseTs = 100000;

    db.insertTurn({
      id: nextId(), group_id: FLOW_GROUP,
      sender_id: 'user-A', sender_name: 'Alice', role: 'user',
      content: '帮我列出桌面文件', timestamp: baseTs, source_message_id: 'f1',
    });
    db.insertTurn({
      id: nextId(), group_id: FLOW_GROUP,
      sender_id: 'assistant', sender_name: 'assistant', role: 'assistant',
      content: '桌面上有 3 个文件：hello.txt, data.csv, notes.md', timestamp: baseTs + 1000, source_message_id: 'f2',
    });
    db.insertTurn({
      id: nextId(), group_id: FLOW_GROUP,
      sender_id: 'user-A', sender_name: 'Alice', role: 'user',
      content: '把 hello.txt 重命名为 greeting.txt', timestamp: baseTs + 2000, source_message_id: 'f3',
    });
    db.insertTurn({
      id: nextId(), group_id: FLOW_GROUP,
      sender_id: 'assistant', sender_name: 'assistant', role: 'assistant',
      content: '已将 hello.txt 重命名为 greeting.txt', timestamp: baseTs + 3000, source_message_id: 'f4',
    });
    db.insertTurn({
      id: nextId(), group_id: FLOW_GROUP,
      sender_id: 'user-A', sender_name: 'Alice', role: 'user',
      content: '现在桌面有几个文件？', timestamp: baseTs + 4000, source_message_id: 'f5',
    });

    // 获取最近 10 条
    const turns = db.getRecentTurns(FLOW_GROUP, baseTs, 10);

    expect(turns).toHaveLength(5);
    // 验证交替出现 user/assistant
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    expect(turns[2].role).toBe('user');
    expect(turns[3].role).toBe('assistant');
    expect(turns[4].role).toBe('user');
    // 验证内容保留
    expect(turns[0].content).toContain('列出桌面文件');
    expect(turns[1].content).toContain('3 个文件');
    expect(turns[4].content).toContain('几个文件');
  });

  it('window 过滤应只返回窗口内的对话', () => {
    const baseTs = 100000;
    // 只取最后 2 秒的对话
    const turns = db.getRecentTurns(FLOW_GROUP, baseTs + 3000, 10);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.every(t => t.timestamp >= baseTs + 3000)).toBe(true);
  });
});
