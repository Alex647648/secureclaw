// src/db/db.ts
// SecureClaw 数据库层 — 所有 SQL 操作封装在此文件
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type Group,
  type NewGroup,
  type Message,
  type NewMessage,
  type Session,
  type NewSession,
  type ScheduledTask,
  type NewScheduledTask,
  type AuditEntry,
  type AuditFilter,
  TrustLevel,
  SAFE_ID_PATTERN,
} from '../core/types';
import type { AppConfig } from '../core/config';

// ── SQL Schema ──────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sc_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'whatsapp',
  channel_id TEXT NOT NULL,
  trust_level INTEGER NOT NULL DEFAULT 2,
  network_policy TEXT NOT NULL DEFAULT 'claude_only',
  is_admin_group INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sc_group_member_trust (
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  trust_level INTEGER NOT NULL,
  reason TEXT,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_id)
);

CREATE TABLE IF NOT EXISTS sc_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  trust_level INTEGER,
  injection_score REAL,
  timestamp INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (group_id) REFERENCES sc_groups(id)
);
CREATE INDEX IF NOT EXISTS idx_sc_messages_group_timestamp ON sc_messages(group_id, timestamp);

CREATE TABLE IF NOT EXISTS sc_agent_sessions (
  session_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  task_id TEXT,
  trust_level INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  FOREIGN KEY (group_id) REFERENCES sc_groups(id)
);

CREATE TABLE IF NOT EXISTS sc_scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  prompt TEXT NOT NULL,
  trust_level INTEGER NOT NULL,
  network_policy TEXT NOT NULL DEFAULT 'claude_only',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES sc_groups(id)
);

CREATE TABLE IF NOT EXISTS sc_audit_log (
  entry_id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  group_id TEXT,
  session_id TEXT,
  actor_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sc_audit_timestamp ON sc_audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_sc_audit_group ON sc_audit_log(group_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sc_audit_event ON sc_audit_log(event_type, timestamp);

CREATE TABLE IF NOT EXISTS sc_app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sc_agent_memory (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(group_id, key)
);
CREATE INDEX IF NOT EXISTS idx_sc_memory_group ON sc_agent_memory(group_id);

CREATE TABLE IF NOT EXISTS sc_pending_confirmations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sc_pending_group_sender ON sc_pending_confirmations(group_id, sender_id);
`;

// ── 数据库类 ────────────────────────────────────────────────────

export class SecureClawDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** 获取底层数据库实例（仅供审计层使用） */
  getDatabase(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ── Groups ──────────────────────────────────────────────────

  createGroup(group: NewGroup): Group {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO sc_groups (id, name, channel_type, channel_id, trust_level, network_policy, is_admin_group, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      group.id, group.name, group.channel_type, group.channel_id,
      group.trust_level, group.network_policy, group.is_admin_group,
      now, now
    );
    return { ...group, created_at: now, updated_at: now };
  }

  getGroup(id: string): Group | null {
    return (this.db.prepare('SELECT * FROM sc_groups WHERE id = ?').get(id) as Group | undefined) ?? null;
  }

  getGroupByChannelId(channelType: string, channelId: string): Group | null {
    return (this.db.prepare(
      'SELECT * FROM sc_groups WHERE channel_type = ? AND channel_id = ?'
    ).get(channelType, channelId) as Group | undefined) ?? null;
  }

  listGroups(): Group[] {
    return this.db.prepare('SELECT * FROM sc_groups').all() as Group[];
  }

  private static readonly ALLOWED_GROUP_FIELDS = new Set([
    'name', 'channel_type', 'channel_id', 'trust_level',
    'network_policy', 'is_admin_group',
  ]);

  updateGroup(id: string, updates: Partial<Group>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'id' || key === 'created_at' || key === 'updated_at') continue;
      if (!SecureClawDB.ALLOWED_GROUP_FIELDS.has(key)) {
        throw new Error(`Invalid update field: ${key}`);
      }
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return; // 没有有效字段，跳过
    const now = Date.now();
    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);
    this.db.prepare(`UPDATE sc_groups SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  // ── Member Trust ────────────────────────────────────────────

  setMemberTrust(groupId: string, memberId: string, level: TrustLevel, setBy: string, reason?: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO sc_group_member_trust (group_id, member_id, trust_level, reason, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, member_id) DO UPDATE SET trust_level = ?, reason = ?, set_by = ?, set_at = ?`
    ).run(groupId, memberId, level, reason ?? null, setBy, now, level, reason ?? null, setBy, now);
  }

  getMemberTrust(groupId: string, memberId: string): TrustLevel | null {
    const row = this.db.prepare(
      'SELECT trust_level FROM sc_group_member_trust WHERE group_id = ? AND member_id = ?'
    ).get(groupId, memberId) as { trust_level: number } | undefined;
    return row ? row.trust_level as TrustLevel : null;
  }

  isBlocked(groupId: string, memberId: string): boolean {
    return this.getMemberTrust(groupId, memberId) === TrustLevel.BLOCKED;
  }

  // ── Messages ────────────────────────────────────────────────

  insertMessage(msg: NewMessage): void {
    this.db.prepare(
      `INSERT INTO sc_messages (id, group_id, sender_id, sender_name, content, content_type, trust_level, injection_score, timestamp, processed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      msg.id, msg.group_id, msg.sender_id, msg.sender_name,
      msg.content, msg.content_type, msg.trust_level, msg.injection_score,
      msg.timestamp
    );
  }

  getMessagesSince(groupId: string, since: number): Message[] {
    return this.db.prepare(
      'SELECT * FROM sc_messages WHERE group_id = ? AND timestamp >= ? ORDER BY timestamp ASC'
    ).all(groupId, since) as Message[];
  }

  getNewMessages(since: number): Message[] {
    return this.db.prepare(
      'SELECT * FROM sc_messages WHERE timestamp >= ? AND processed = 0 ORDER BY timestamp ASC'
    ).all(since) as Message[];
  }

  updateMessageTrustLevel(id: string, trustLevel: number, injectionScore: number): void {
    this.db.prepare(
      'UPDATE sc_messages SET trust_level = ?, injection_score = ? WHERE id = ?'
    ).run(trustLevel, injectionScore, id);
  }

  markMessageProcessed(id: string): void {
    this.db.prepare('UPDATE sc_messages SET processed = 1 WHERE id = ?').run(id);
  }

  // ── Sessions ────────────────────────────────────────────────

  createSession(session: NewSession): void {
    this.db.prepare(
      `INSERT INTO sc_agent_sessions (session_id, group_id, task_id, trust_level, started_at, ended_at, status)
       VALUES (?, ?, ?, ?, ?, NULL, 'running')`
    ).run(session.session_id, session.group_id, session.task_id, session.trust_level, session.started_at);
  }

  updateSessionStatus(sessionId: string, status: Session['status'], endedAt?: number): void {
    this.db.prepare(
      'UPDATE sc_agent_sessions SET status = ?, ended_at = ? WHERE session_id = ?'
    ).run(status, endedAt ?? Date.now(), sessionId);
  }

  getSession(sessionId: string): Session | null {
    return (this.db.prepare(
      'SELECT * FROM sc_agent_sessions WHERE session_id = ?'
    ).get(sessionId) as Session | undefined) ?? null;
  }

  // ── Scheduled Tasks ─────────────────────────────────────────

  createTask(task: NewScheduledTask): ScheduledTask {
    this.db.prepare(
      `INSERT INTO sc_scheduled_tasks (id, group_id, name, cron_expression, prompt, trust_level, network_policy, enabled, last_run_at, next_run_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id, task.group_id, task.name, task.cron_expression, task.prompt,
      task.trust_level, task.network_policy, task.enabled,
      task.last_run_at ?? null, task.next_run_at, task.created_at, task.created_by
    );
    return { ...task, last_run_at: task.last_run_at ?? null };
  }

  getDueTasks(): ScheduledTask[] {
    const now = Date.now();
    return this.db.prepare(
      'SELECT * FROM sc_scheduled_tasks WHERE enabled = 1 AND next_run_at <= ?'
    ).all(now) as ScheduledTask[];
  }

  updateTaskLastRun(id: string, lastRunAt: number, nextRunAt: number): void {
    this.db.prepare(
      'UPDATE sc_scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?'
    ).run(lastRunAt, nextRunAt, id);
  }

  setTaskEnabled(id: string, enabled: boolean): void {
    const result = this.db.prepare(
      'UPDATE sc_scheduled_tasks SET enabled = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, id);
    if (result.changes === 0) {
      throw new Error(`Task "${id}" not found`);
    }
  }

  listTasks(groupId?: string): ScheduledTask[] {
    if (groupId) {
      return this.db.prepare(
        'SELECT * FROM sc_scheduled_tasks WHERE group_id = ?'
      ).all(groupId) as ScheduledTask[];
    }
    return this.db.prepare('SELECT * FROM sc_scheduled_tasks').all() as ScheduledTask[];
  }

  // ── State ───────────────────────────────────────────────────

  getState(key: string): string | null {
    const row = this.db.prepare(
      'SELECT value FROM sc_app_state WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setState(key: string, value: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO sc_app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
    ).run(key, value, now, value, now);
  }

  // ── Audit（只有 INSERT）──────────────────────────────────────

  insertAuditEntry(entry: AuditEntry): void {
    this.db.prepare(
      `INSERT INTO sc_audit_log (entry_id, timestamp, event_type, group_id, session_id, actor_id, payload, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.entryId, entry.timestamp, entry.eventType,
      entry.groupId ?? null, entry.sessionId ?? null, entry.actorId,
      JSON.stringify(entry.payload), entry.prevHash, entry.entryHash
    );
  }

  queryAuditLog(filter: AuditFilter): AuditEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.groupId) {
      conditions.push('group_id = ?');
      params.push(filter.groupId);
    }
    if (filter.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.fromTimestamp) {
      conditions.push('timestamp >= ?');
      params.push(filter.fromTimestamp);
    }
    if (filter.toTimestamp) {
      conditions.push('timestamp <= ?');
      params.push(filter.toTimestamp);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter.limit ? 'LIMIT ?' : '';
    if (filter.limit) params.push(filter.limit);

    const rows = this.db.prepare(
      `SELECT * FROM sc_audit_log ${where} ORDER BY timestamp DESC ${limitClause}`
    ).all(...params) as Array<{
      entry_id: string;
      timestamp: number;
      event_type: string;
      group_id: string | null;
      session_id: string | null;
      actor_id: string;
      payload: string;
      prev_hash: string;
      entry_hash: string;
    }>;

    return rows.map(row => ({
      entryId: row.entry_id,
      timestamp: row.timestamp,
      eventType: row.event_type as AuditEntry['eventType'],
      groupId: row.group_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      actorId: row.actor_id,
      payload: JSON.parse(row.payload),
      prevHash: row.prev_hash,
      entryHash: row.entry_hash,
    }));
  }

  // ── Agent Memory（结构化长期记忆）───────────────────────────

  saveMemoryEntry(groupId: string, key: string, value: string, tags: string = ''): void {
    const now = Date.now();
    const id = `${groupId}:${key}`;
    this.db.prepare(
      `INSERT INTO sc_agent_memory (id, group_id, key, value, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, key) DO UPDATE SET value = ?, tags = ?, updated_at = ?`
    ).run(id, groupId, key, value, tags, now, now, value, tags, now);
  }

  searchMemory(groupId: string, query: string): Array<{ key: string; value: string; tags: string; updated_at: number }> {
    const pattern = `%${query}%`;
    return this.db.prepare(
      `SELECT key, value, tags, updated_at FROM sc_agent_memory
       WHERE group_id = ? AND (key LIKE ? OR value LIKE ? OR tags LIKE ?)
       ORDER BY updated_at DESC LIMIT 20`
    ).all(groupId, pattern, pattern, pattern) as Array<{ key: string; value: string; tags: string; updated_at: number }>;
  }

  deleteMemoryEntry(groupId: string, key: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM sc_agent_memory WHERE group_id = ? AND key = ?'
    ).run(groupId, key);
    return result.changes > 0;
  }

  listMemory(groupId: string): Array<{ key: string; value: string; tags: string; updated_at: number }> {
    return this.db.prepare(
      'SELECT key, value, tags, updated_at FROM sc_agent_memory WHERE group_id = ? ORDER BY updated_at DESC LIMIT 50'
    ).all(groupId) as Array<{ key: string; value: string; tags: string; updated_at: number }>;
  }

  // ── Pending Confirmations（确认式交互）─────────────────────

  createPendingConfirmation(id: string, groupId: string, senderId: string, question: string, context: string, ttlMs: number = 300_000): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO sc_pending_confirmations (id, group_id, sender_id, question, context, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, groupId, senderId, question, context, now, now + ttlMs);
  }

  getPendingConfirmation(groupId: string, senderId: string): { id: string; question: string; context: string } | null {
    const now = Date.now();
    // 清理过期确认
    this.db.prepare('DELETE FROM sc_pending_confirmations WHERE expires_at < ?').run(now);
    const row = this.db.prepare(
      'SELECT id, question, context FROM sc_pending_confirmations WHERE group_id = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(groupId, senderId) as { id: string; question: string; context: string } | undefined;
    return row ?? null;
  }

  deletePendingConfirmation(id: string): void {
    this.db.prepare('DELETE FROM sc_pending_confirmations WHERE id = ?').run(id);
  }

  // ── Bootstrap ───────────────────────────────────────────────

  bootstrap(config: AppConfig): void {
    const groups = this.listGroups();
    if (groups.length > 0) return; // 数据库非空，跳过 bootstrap

    if (!config.bootstrap.adminChannelId) {
      throw new Error(
        'Database is empty and bootstrap.admin_channel_id is not set.\n' +
        'Run `bash setup.sh` or set bootstrap config in secureclaw.yaml'
      );
    }

    if (!SAFE_ID_PATTERN.test(config.bootstrap.adminGroupId)) {
      throw new Error(`Invalid admin_group_id: "${config.bootstrap.adminGroupId}" — must match ${SAFE_ID_PATTERN}`);
    }

    const now = Date.now();
    // 根据启用的通道确定管理员群组类型（不再硬编码 whatsapp）
    const channelOrder = ['whatsapp', 'telegram', 'slack', 'discord'] as const;
    let adminChannelType = 'whatsapp';
    if (config.channels) {
      for (const ch of channelOrder) {
        if (config.channels[ch]?.enabled) {
          adminChannelType = ch;
          break;
        }
      }
    }

    this.createGroup({
      id: config.bootstrap.adminGroupId,
      name: config.bootstrap.adminGroupId,
      channel_type: adminChannelType,
      channel_id: config.bootstrap.adminChannelId,
      trust_level: TrustLevel.ADMIN,
      network_policy: 'claude_only',
      is_admin_group: 1,
    });

    for (const senderId of config.bootstrap.adminSenderIds) {
      if (senderId) {
        this.setMemberTrust(
          config.bootstrap.adminGroupId,
          senderId,
          TrustLevel.ADMIN,
          'bootstrap'
        );
      }
    }
  }
}
