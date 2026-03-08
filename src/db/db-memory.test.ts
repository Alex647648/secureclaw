// src/db/db-memory.test.ts
// Agent Memory + Pending Confirmations 数据库层单元测试
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SecureClawDB } from './db';
import { TrustLevel } from '../core/types';

let tmpDir: string;
let db: SecureClawDB;
const GROUP_ID = 'mem-test-group';
const SENDER_ID = 'sender-001';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mem-test-'));
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  db.createGroup({
    id: GROUP_ID,
    name: 'Memory Test Group',
    channel_type: 'discord',
    channel_id: 'ch-mem',
    trust_level: TrustLevel.ADMIN,
    network_policy: 'trusted',
    is_admin_group: 1,
  });
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// Agent Memory (sc_agent_memory)
// ══════════════════════════════════════════════════════════════════

describe('Agent Memory - saveMemoryEntry', () => {
  beforeEach(() => {
    // 清理
    for (const m of db.listMemory(GROUP_ID)) {
      db.deleteMemoryEntry(GROUP_ID, m.key);
    }
  });

  it('应存储新条目', () => {
    db.saveMemoryEntry(GROUP_ID, 'color', 'blue');
    const list = db.listMemory(GROUP_ID);
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('color');
    expect(list[0].value).toBe('blue');
  });

  it('应带 tags 存储', () => {
    db.saveMemoryEntry(GROUP_ID, 'name', 'Alice', 'user,profile');
    const list = db.listMemory(GROUP_ID);
    expect(list[0].tags).toBe('user,profile');
  });

  it('UPSERT: 重复 key 应更新 value', () => {
    db.saveMemoryEntry(GROUP_ID, 'color', 'blue');
    db.saveMemoryEntry(GROUP_ID, 'color', 'red');
    const list = db.listMemory(GROUP_ID);
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe('red');
  });

  it('UPSERT: 更新时应更新 tags', () => {
    db.saveMemoryEntry(GROUP_ID, 'color', 'blue', 'old');
    db.saveMemoryEntry(GROUP_ID, 'color', 'red', 'new');
    const list = db.listMemory(GROUP_ID);
    expect(list[0].tags).toBe('new');
  });

  it('UPSERT: 更新时 updated_at 应变化', () => {
    db.saveMemoryEntry(GROUP_ID, 'ts-test', 'v1');
    const ts1 = db.listMemory(GROUP_ID).find(m => m.key === 'ts-test')!.updated_at;
    // 等一毫秒确保时间戳不同
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }
    db.saveMemoryEntry(GROUP_ID, 'ts-test', 'v2');
    const ts2 = db.listMemory(GROUP_ID).find(m => m.key === 'ts-test')!.updated_at;
    expect(ts2).toBeGreaterThan(ts1);
  });

  it('不同 group 的记忆应隔离', () => {
    const OTHER_GROUP = 'other-group';
    db.createGroup({
      id: OTHER_GROUP,
      name: 'Other',
      channel_type: 'discord',
      channel_id: 'ch-other',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      is_admin_group: 0,
    });
    db.saveMemoryEntry(GROUP_ID, 'shared-key', 'value-A');
    db.saveMemoryEntry(OTHER_GROUP, 'shared-key', 'value-B');
    const listA = db.listMemory(GROUP_ID);
    const listB = db.listMemory(OTHER_GROUP);
    expect(listA.find(m => m.key === 'shared-key')?.value).toBe('value-A');
    expect(listB.find(m => m.key === 'shared-key')?.value).toBe('value-B');
    // 清理
    db.deleteMemoryEntry(OTHER_GROUP, 'shared-key');
  });
});

describe('Agent Memory - searchMemory', () => {
  beforeEach(() => {
    for (const m of db.listMemory(GROUP_ID)) {
      db.deleteMemoryEntry(GROUP_ID, m.key);
    }
    db.saveMemoryEntry(GROUP_ID, 'favorite-color', 'deep blue', 'pref');
    db.saveMemoryEntry(GROUP_ID, 'pet-name', 'golden retriever', 'animal');
    db.saveMemoryEntry(GROUP_ID, 'project', 'SecureClaw framework', 'work,code');
  });

  it('应按 key 搜索', () => {
    const results = db.searchMemory(GROUP_ID, 'favorite');
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('favorite-color');
  });

  it('应按 value 搜索', () => {
    const results = db.searchMemory(GROUP_ID, 'golden');
    expect(results).toHaveLength(1);
    expect(results[0].value).toContain('golden');
  });

  it('应按 tags 搜索', () => {
    const results = db.searchMemory(GROUP_ID, 'animal');
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('pet-name');
  });

  it('无匹配应返回空数组', () => {
    const results = db.searchMemory(GROUP_ID, 'zzz_impossible');
    expect(results).toHaveLength(0);
  });

  it('应按 updated_at 降序排列', () => {
    const results = db.searchMemory(GROUP_ID, '');
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].updated_at).toBeGreaterThanOrEqual(results[i].updated_at);
    }
  });
});

describe('Agent Memory - deleteMemoryEntry', () => {
  it('删除存在的 key 应返回 true', () => {
    db.saveMemoryEntry(GROUP_ID, 'to-delete', 'bye');
    expect(db.deleteMemoryEntry(GROUP_ID, 'to-delete')).toBe(true);
  });

  it('删除不存在的 key 应返回 false', () => {
    expect(db.deleteMemoryEntry(GROUP_ID, 'never-existed-xyz')).toBe(false);
  });

  it('删除后应无法搜索到', () => {
    db.saveMemoryEntry(GROUP_ID, 'ephemeral', 'temp');
    db.deleteMemoryEntry(GROUP_ID, 'ephemeral');
    expect(db.searchMemory(GROUP_ID, 'ephemeral')).toHaveLength(0);
  });
});

describe('Agent Memory - listMemory', () => {
  beforeEach(() => {
    for (const m of db.listMemory(GROUP_ID)) {
      db.deleteMemoryEntry(GROUP_ID, m.key);
    }
  });

  it('空状态应返回空数组', () => {
    expect(db.listMemory(GROUP_ID)).toHaveLength(0);
  });

  it('应返回所有条目', () => {
    db.saveMemoryEntry(GROUP_ID, 'a', '1');
    db.saveMemoryEntry(GROUP_ID, 'b', '2');
    db.saveMemoryEntry(GROUP_ID, 'c', '3');
    expect(db.listMemory(GROUP_ID)).toHaveLength(3);
  });

  it('最多返回 50 条', () => {
    for (let i = 0; i < 55; i++) {
      db.saveMemoryEntry(GROUP_ID, `key-${i}`, `val-${i}`);
    }
    expect(db.listMemory(GROUP_ID)).toHaveLength(50);
    // 清理
    for (let i = 0; i < 55; i++) {
      db.deleteMemoryEntry(GROUP_ID, `key-${i}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// Pending Confirmations (sc_pending_confirmations)
// ══════════════════════════════════════════════════════════════════

describe('Pending Confirmations', () => {
  const CONFIRM_ID = 'confirm-001';

  beforeEach(() => {
    try { db.deletePendingConfirmation(CONFIRM_ID); } catch { /* ignore */ }
    try { db.deletePendingConfirmation('confirm-002'); } catch { /* ignore */ }
  });

  it('createPendingConfirmation: 应创建确认记录', () => {
    db.createPendingConfirmation(CONFIRM_ID, GROUP_ID, SENDER_ID, '确定删除？', '上下文');
    const result = db.getPendingConfirmation(GROUP_ID, SENDER_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(CONFIRM_ID);
    expect(result!.question).toBe('确定删除？');
    expect(result!.context).toBe('上下文');
  });

  it('getPendingConfirmation: 无记录应返回 null', () => {
    const result = db.getPendingConfirmation(GROUP_ID, 'unknown-sender');
    expect(result).toBeNull();
  });

  it('getPendingConfirmation: 过期记录应返回 null', () => {
    // ttlMs = 1ms，立即过期
    db.createPendingConfirmation(CONFIRM_ID, GROUP_ID, SENDER_ID, '会过期的', '', 1);
    // 等待过期
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const result = db.getPendingConfirmation(GROUP_ID, SENDER_ID);
    expect(result).toBeNull();
  });

  it('deletePendingConfirmation: 应删除确认记录', () => {
    db.createPendingConfirmation(CONFIRM_ID, GROUP_ID, SENDER_ID, '删我', '');
    db.deletePendingConfirmation(CONFIRM_ID);
    const result = db.getPendingConfirmation(GROUP_ID, SENDER_ID);
    expect(result).toBeNull();
  });

  it('应取最新的确认记录（ORDER BY created_at DESC）', () => {
    db.createPendingConfirmation('confirm-old', GROUP_ID, SENDER_ID, '旧问题', '');
    // 确保时间戳不同
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }
    db.createPendingConfirmation('confirm-new', GROUP_ID, SENDER_ID, '新问题', '');
    const result = db.getPendingConfirmation(GROUP_ID, SENDER_ID);
    expect(result!.question).toBe('新问题');
    // 清理
    db.deletePendingConfirmation('confirm-old');
    db.deletePendingConfirmation('confirm-new');
  });

  it('不同 sender 的确认应隔离', () => {
    db.createPendingConfirmation('confirm-s1', GROUP_ID, 'sender-A', '问题A', '');
    db.createPendingConfirmation('confirm-s2', GROUP_ID, 'sender-B', '问题B', '');
    const resultA = db.getPendingConfirmation(GROUP_ID, 'sender-A');
    const resultB = db.getPendingConfirmation(GROUP_ID, 'sender-B');
    expect(resultA!.question).toBe('问题A');
    expect(resultB!.question).toBe('问题B');
    // 清理
    db.deletePendingConfirmation('confirm-s1');
    db.deletePendingConfirmation('confirm-s2');
  });
});
