// src/db/db.test.ts
// 多维度测试：CRUD、安全边界、SQL 注入防护、Bootstrap、Edge Cases
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecureClawDB } from './db';
import { LocalAuditBackend } from '../audit/backend/local-audit';
import { TrustLevel } from '../core/types';
import { generateId } from '../core/utils';

const TEST_DB_PATH = path.join(__dirname, '../../test-secureclaw.db');

let db: SecureClawDB;
let audit: LocalAuditBackend;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = new SecureClawDB(TEST_DB_PATH);
  audit = new LocalAuditBackend(db.getDatabase());
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ── Groups CRUD ───────────────────────────────────────────────

describe('Groups', () => {
  it('should create and retrieve a group', () => {
    const group = db.createGroup({
      id: 'test-group',
      name: 'Test Group',
      channel_type: 'whatsapp',
      channel_id: '120363027788222222@g.us',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      is_admin_group: 0,
    });

    expect(group.id).toBe('test-group');
    expect(group.created_at).toBeGreaterThan(0);

    const retrieved = db.getGroup('test-group');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Test Group');
  });

  it('should find group by channelId', () => {
    db.createGroup({
      id: 'wa-group', name: 'WA Group', channel_type: 'whatsapp',
      channel_id: '120363027788@g.us', trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only', is_admin_group: 0,
    });

    expect(db.getGroupByChannelId('whatsapp', '120363027788@g.us')).not.toBeNull();
    expect(db.getGroupByChannelId('telegram', '120363027788@g.us')).toBeNull();
    expect(db.getGroupByChannelId('whatsapp', 'nonexistent')).toBeNull();
  });

  it('should list all groups', () => {
    db.createGroup({ id: 'g1', name: 'G1', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
    db.createGroup({ id: 'g2', name: 'G2', channel_type: 'telegram', channel_id: 'tg:-100123', trust_level: TrustLevel.ADMIN, network_policy: 'claude_only', is_admin_group: 1 });
    expect(db.listGroups()).toHaveLength(2);
  });

  it('should return null for nonexistent group', () => {
    expect(db.getGroup('nonexistent')).toBeNull();
  });

  it('should reject duplicate group IDs', () => {
    db.createGroup({ id: 'dup', name: 'A', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
    expect(() => db.createGroup({ id: 'dup', name: 'B', channel_type: 'whatsapp', channel_id: '2@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 })).toThrow();
  });
});

// ── updateGroup ───────────────────────────────────────────────

describe('updateGroup', () => {
  beforeEach(() => {
    db.createGroup({ id: 'upd', name: 'Original', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
  });

  it('should update valid fields', () => {
    db.updateGroup('upd', { name: 'Updated' });
    expect(db.getGroup('upd')!.name).toBe('Updated');
  });

  it('should update multiple fields at once', () => {
    db.updateGroup('upd', { name: 'New', trust_level: TrustLevel.ADMIN, network_policy: 'isolated' });
    const g = db.getGroup('upd')!;
    expect(g.name).toBe('New');
    expect(g.trust_level).toBe(TrustLevel.ADMIN);
    expect(g.network_policy).toBe('isolated');
  });

  it('should reject invalid field names (SQL injection prevention)', () => {
    expect(() => db.updateGroup('upd', { ['1=1; DROP TABLE sc_groups; --']: 'x' } as any)).toThrow('Invalid update field');
  });

  it('should skip update when no valid fields provided', () => {
    const before = db.getGroup('upd')!;
    db.updateGroup('upd', {}); // 空 update
    const after = db.getGroup('upd')!;
    expect(after.updated_at).toBe(before.updated_at); // 没变
  });

  it('should not allow updating id or created_at', () => {
    const before = db.getGroup('upd')!;
    db.updateGroup('upd', { id: 'hacked', created_at: 0 } as any);
    const after = db.getGroup('upd')!;
    expect(after.id).toBe('upd');
    expect(after.created_at).toBe(before.created_at);
  });

  it('should silently succeed for nonexistent group', () => {
    // No error, but no row affected
    db.updateGroup('nonexistent', { name: 'X' });
    expect(db.getGroup('nonexistent')).toBeNull();
  });
});

// ── Messages ──────────────────────────────────────────────────

describe('Messages', () => {
  beforeEach(() => {
    db.createGroup({ id: 'msg-group', name: 'Msg', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
  });

  it('should insert and query messages', () => {
    const now = Date.now();
    db.insertMessage({ id: 'msg-1', group_id: 'msg-group', sender_id: 'user1', sender_name: 'Alice', content: 'Hello', content_type: 'text', trust_level: TrustLevel.TRUSTED, injection_score: 0.1, timestamp: now });

    const msgs = db.getMessagesSince('msg-group', now - 1000);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].processed).toBe(0);

    db.markMessageProcessed('msg-1');
    expect(db.getMessagesSince('msg-group', now - 1000)[0].processed).toBe(1);
  });

  it('should return empty array for no messages', () => {
    expect(db.getMessagesSince('msg-group', Date.now())).toHaveLength(0);
  });

  it('should reject message with invalid group_id (FK violation)', () => {
    expect(() => db.insertMessage({ id: 'bad-msg', group_id: 'nonexistent', sender_id: 'u', sender_name: '', content: 'x', content_type: 'text', trust_level: null, injection_score: null, timestamp: Date.now() })).toThrow();
  });

  it('getNewMessages should filter by timestamp AND processed', () => {
    const t1 = Date.now() - 5000;
    const t2 = Date.now();
    db.insertMessage({ id: 'm1', group_id: 'msg-group', sender_id: 'u', sender_name: '', content: 'old', content_type: 'text', trust_level: null, injection_score: null, timestamp: t1 });
    db.insertMessage({ id: 'm2', group_id: 'msg-group', sender_id: 'u', sender_name: '', content: 'new', content_type: 'text', trust_level: null, injection_score: null, timestamp: t2 });

    // Both unprocessed, query from t2
    const newMsgs = db.getNewMessages(t2);
    expect(newMsgs).toHaveLength(1);
    expect(newMsgs[0].id).toBe('m2');

    // Mark m2 processed
    db.markMessageProcessed('m2');
    expect(db.getNewMessages(t2)).toHaveLength(0);
  });
});

// ── Member Trust ──────────────────────────────────────────────

describe('Member Trust', () => {
  beforeEach(() => {
    db.createGroup({ id: 'trust-group', name: 'Trust', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
  });

  it('should set and get member trust levels', () => {
    expect(db.getMemberTrust('trust-group', 'user1')).toBeNull();
    db.setMemberTrust('trust-group', 'user1', TrustLevel.ADMIN, 'bootstrap');
    expect(db.getMemberTrust('trust-group', 'user1')).toBe(TrustLevel.ADMIN);
  });

  it('should update existing trust level', () => {
    db.setMemberTrust('trust-group', 'user1', TrustLevel.ADMIN, 'bootstrap');
    db.setMemberTrust('trust-group', 'user1', TrustLevel.BLOCKED, 'admin', 'misbehavior');
    expect(db.getMemberTrust('trust-group', 'user1')).toBe(TrustLevel.BLOCKED);
    expect(db.isBlocked('trust-group', 'user1')).toBe(true);
  });

  it('isBlocked should return false for unset members', () => {
    expect(db.isBlocked('trust-group', 'unknown')).toBe(false);
  });
});

// ── Sessions ──────────────────────────────────────────────────

describe('Sessions', () => {
  beforeEach(() => {
    db.createGroup({ id: 'sess-group', name: 'Sess', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
  });

  it('should create and update sessions', () => {
    db.createSession({ session_id: 's1', group_id: 'sess-group', task_id: 't1', trust_level: TrustLevel.TRUSTED, started_at: Date.now() });
    expect(db.getSession('s1')!.status).toBe('running');

    db.updateSessionStatus('s1', 'completed');
    const updated = db.getSession('s1')!;
    expect(updated.status).toBe('completed');
    expect(updated.ended_at).toBeGreaterThan(0);
  });

  it('should return null for nonexistent session', () => {
    expect(db.getSession('nonexistent')).toBeNull();
  });
});

// ── Scheduled Tasks ───────────────────────────────────────────

describe('Scheduled Tasks', () => {
  beforeEach(() => {
    db.createGroup({ id: 'task-group', name: 'Task', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
  });

  it('should create and list tasks', () => {
    const now = Date.now();
    db.createTask({ id: 'task-1', group_id: 'task-group', name: 'Daily Report', cron_expression: '0 9 * * *', prompt: 'Generate report', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', enabled: 1, next_run_at: now + 3600000, created_at: now, created_by: 'admin' });

    const tasks = db.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('Daily Report');

    const groupTasks = db.listTasks('task-group');
    expect(groupTasks).toHaveLength(1);

    const otherTasks = db.listTasks('other-group');
    expect(otherTasks).toHaveLength(0);
  });

  it('should get due tasks', () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 100000;
    db.createTask({ id: 'due', group_id: 'task-group', name: 'Due', cron_expression: '* * * * *', prompt: 'p', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', enabled: 1, next_run_at: past, created_at: past, created_by: 'admin' });
    db.createTask({ id: 'future', group_id: 'task-group', name: 'Future', cron_expression: '* * * * *', prompt: 'p', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', enabled: 1, next_run_at: future, created_at: past, created_by: 'admin' });

    const due = db.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('due');
  });

  it('should update last run and disable tasks', () => {
    const now = Date.now();
    db.createTask({ id: 't1', group_id: 'task-group', name: 'T', cron_expression: '* * * * *', prompt: 'p', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', enabled: 1, next_run_at: now - 1000, created_at: now, created_by: 'admin' });

    db.updateTaskLastRun('t1', now, now + 60000);
    const tasks = db.listTasks();
    expect(tasks[0].last_run_at).toBe(now);
    expect(tasks[0].next_run_at).toBe(now + 60000);

    db.setTaskEnabled('t1', false);
    expect(db.getDueTasks()).toHaveLength(0); // disabled tasks not returned
  });
});

// ── App State ─────────────────────────────────────────────────

describe('App State', () => {
  it('should get/set state values', () => {
    expect(db.getState('version')).toBeNull();
    db.setState('version', '1.0.0');
    expect(db.getState('version')).toBe('1.0.0');
    db.setState('version', '1.0.1');
    expect(db.getState('version')).toBe('1.0.1');
  });
});

// ── Audit Chain ───────────────────────────────────────────────

describe('Audit Chain', () => {
  it('should append entries and verify chain integrity', async () => {
    await audit.append({ entryId: generateId(), timestamp: Date.now(), eventType: 'message_received', groupId: 'test-group', actorId: 'user1', payload: { content: 'test' } });
    await audit.append({ entryId: generateId(), timestamp: Date.now(), eventType: 'trust_evaluated', groupId: 'test-group', actorId: 'system', payload: { trustLevel: 2 } });
    await audit.append({ entryId: generateId(), timestamp: Date.now(), eventType: 'task_completed', groupId: 'test-group', sessionId: 'sess-1', actorId: 'system', payload: { success: true } });

    const report = await audit.verifyChainIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(3);
  });

  it('should detect chain tampering', async () => {
    await audit.append({ entryId: 'entry-1', timestamp: Date.now(), eventType: 'message_received', actorId: 'user1', payload: { content: 'original' } });
    await audit.append({ entryId: 'entry-2', timestamp: Date.now(), eventType: 'task_completed', actorId: 'system', payload: { success: true } });

    // 篡改 payload
    db.getDatabase().prepare("UPDATE sc_audit_log SET payload = '{\"content\":\"tampered\"}' WHERE entry_id = 'entry-1'").run();

    const report = await audit.verifyChainIntegrity();
    expect(report.valid).toBe(false);
    expect(report.firstBrokenAt).toBe('entry-1');
  });

  it('should handle entries with same timestamp correctly', async () => {
    const ts = Date.now();
    await audit.append({ entryId: 'same-ts-a', timestamp: ts, eventType: 'message_received', actorId: 'u1', payload: {} });
    await audit.append({ entryId: 'same-ts-b', timestamp: ts, eventType: 'message_received', actorId: 'u2', payload: {} });
    await audit.append({ entryId: 'same-ts-c', timestamp: ts, eventType: 'message_received', actorId: 'u3', payload: {} });

    const report = await audit.verifyChainIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(3);
  });

  it('should handle entries without optional fields', async () => {
    await audit.append({ entryId: generateId(), timestamp: Date.now(), eventType: 'message_received', actorId: 'user1', payload: { test: true } });
    // No groupId, no sessionId

    const report = await audit.verifyChainIntegrity();
    expect(report.valid).toBe(true);
  });

  it('should query with filters', async () => {
    await audit.append({ entryId: 'q1', timestamp: 1000, eventType: 'message_received', groupId: 'g1', actorId: 'u1', payload: {} });
    await audit.append({ entryId: 'q2', timestamp: 2000, eventType: 'trust_evaluated', groupId: 'g1', actorId: 'system', payload: {} });
    await audit.append({ entryId: 'q3', timestamp: 3000, eventType: 'message_received', groupId: 'g2', actorId: 'u2', payload: {} });

    expect(await audit.query({ groupId: 'g1' })).toHaveLength(2);
    expect(await audit.query({ eventType: 'message_received' })).toHaveLength(2);
    expect(await audit.query({ limit: 1 })).toHaveLength(1);
    expect(await audit.query({ fromTimestamp: 2000 })).toHaveLength(2);
    expect(await audit.query({ fromTimestamp: 2000, toTimestamp: 2000 })).toHaveLength(1);
  });

  it('should verify integrity on empty database', async () => {
    const report = await audit.verifyChainIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(0);
  });
});

// ── Bootstrap ─────────────────────────────────────────────────

describe('Bootstrap', () => {
  it('should create admin group from config', () => {
    db.bootstrap({
      bootstrap: { adminGroupId: 'main', adminChannelId: '120363027788@g.us', adminSenderIds: ['447911123456@s.whatsapp.net'] },
    } as any);

    const group = db.getGroup('main');
    expect(group).not.toBeNull();
    expect(group!.is_admin_group).toBe(1);
    expect(group!.trust_level).toBe(TrustLevel.ADMIN);
    expect(db.getMemberTrust('main', '447911123456@s.whatsapp.net')).toBe(TrustLevel.ADMIN);
  });

  it('should skip bootstrap if groups exist', () => {
    db.createGroup({ id: 'existing', name: 'E', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
    db.bootstrap({ bootstrap: { adminGroupId: 'main', adminChannelId: '', adminSenderIds: [] } } as any);
    expect(db.getGroup('main')).toBeNull();
  });

  it('should throw for empty adminChannelId', () => {
    expect(() => db.bootstrap({ bootstrap: { adminGroupId: 'main', adminChannelId: '', adminSenderIds: [] } } as any)).toThrow('admin_channel_id');
  });

  it('should throw for invalid adminGroupId', () => {
    expect(() => db.bootstrap({ bootstrap: { adminGroupId: 'invalid group id!', adminChannelId: '1@g.us', adminSenderIds: [] } } as any)).toThrow('Invalid admin_group_id');
  });

  it('should skip empty sender IDs', () => {
    db.bootstrap({ bootstrap: { adminGroupId: 'main', adminChannelId: '1@g.us', adminSenderIds: ['', 'valid-user'] } } as any);
    expect(db.getMemberTrust('main', '')).toBeNull();
    expect(db.getMemberTrust('main', 'valid-user')).toBe(TrustLevel.ADMIN);
  });

  it('should use first enabled channel type for admin group', () => {
    db.bootstrap({
      bootstrap: { adminGroupId: 'main', adminChannelId: '-1001234', adminSenderIds: ['user1'] },
      channels: {
        whatsapp: { enabled: false },
        telegram: { enabled: true },
        slack: { enabled: false },
        discord: { enabled: false },
      },
    } as any);
    const group = db.getGroup('main');
    expect(group).not.toBeNull();
    expect(group!.channel_type).toBe('telegram');
  });

  it('should default to whatsapp when no channels config provided', () => {
    db.bootstrap({
      bootstrap: { adminGroupId: 'main', adminChannelId: '1@g.us', adminSenderIds: ['user1'] },
    } as any);
    const group = db.getGroup('main');
    expect(group!.channel_type).toBe('whatsapp');
  });
});

// ── BUG-FIX 回归：updateMessageTrustLevel + setTaskEnabled ────

describe('DB bug fix regressions', () => {
  it('should update message trust level in-place', () => {
    db.createGroup({ id: 'g1', name: 'G1', channel_type: 'whatsapp', channel_id: '1@g.us', trust_level: TrustLevel.TRUSTED, network_policy: 'claude_only', is_admin_group: 0 });
    db.insertMessage({
      id: 'msg-1', group_id: 'g1', sender_id: 'u1', sender_name: 'User',
      content: 'test', content_type: 'text', trust_level: null, injection_score: null,
      timestamp: Date.now(),
    });

    db.updateMessageTrustLevel('msg-1', TrustLevel.TRUSTED, 0.2);

    const messages = db.getMessagesSince('g1', 0);
    expect(messages).toHaveLength(1); // 只有 1 条，不是 2 条
    expect(messages[0].trust_level).toBe(TrustLevel.TRUSTED);
    expect(messages[0].injection_score).toBe(0.2);
  });

  it('should throw on setTaskEnabled for non-existent task', () => {
    expect(() => db.setTaskEnabled('ghost', true)).toThrow('not found');
  });
});

// ── QueryAuditLog LIMIT parameterization ──────────────────────

describe('QueryAuditLog Security', () => {
  it('should parameterize LIMIT correctly', () => {
    // This should not throw even with edge values
    const result = db.queryAuditLog({ limit: 0 });
    expect(result).toHaveLength(0);
  });

  it('should handle query with all filters', () => {
    const result = db.queryAuditLog({
      groupId: 'g1',
      sessionId: 's1',
      eventType: 'message_received',
      fromTimestamp: 0,
      toTimestamp: Date.now(),
      limit: 10,
    });
    expect(result).toHaveLength(0);
  });
});
