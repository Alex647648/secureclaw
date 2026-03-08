// src/audit/backend/local-audit.ts
// 哈希链式审计实现 — append-only，同步事务保证并发安全
import type Database from 'better-sqlite3';
import type { AuditEntry, AuditFilter, IntegrityReport } from '../../core/types';
import type { AuditBackend } from './interface';
import { sha256, canonicalSerialize } from '../../core/utils';

const GENESIS_HASH = sha256('secureclaw-audit-genesis');

// 统一排序：使用 SQLite 内置 rowid 保证插入顺序一致性
// rowid 在 better-sqlite3 同步事务中天然单调递增
const ORDER_BY_INSERT = 'ORDER BY rowid';

export class LocalAuditBackend implements AuditBackend {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async append(entry: Omit<AuditEntry, 'prevHash' | 'entryHash'>): Promise<void> {
    this._append(entry);
  }

  /** 同步写入 — better-sqlite3 的事务天然序列化 */
  private _append(entry: Omit<AuditEntry, 'prevHash' | 'entryHash'>): void {
    const tx = this.db.transaction(() => {
      const prev = this.db
        .prepare(`SELECT entry_hash FROM sc_audit_log ${ORDER_BY_INSERT} DESC LIMIT 1`)
        .get() as { entry_hash: string } | undefined;

      const prevHash = prev?.entry_hash ?? GENESIS_HASH;

      // 规范化入参：确保可选字段一致性
      const normalized: Record<string, unknown> = {
        entryId: entry.entryId,
        timestamp: entry.timestamp,
        eventType: entry.eventType,
        actorId: entry.actorId,
        payload: entry.payload,
        prevHash,
      };
      if (entry.groupId != null) normalized.groupId = entry.groupId;
      if (entry.sessionId != null) normalized.sessionId = entry.sessionId;

      const entryHash = sha256(canonicalSerialize(normalized));

      this.db.prepare(
        'INSERT INTO sc_audit_log (entry_id, timestamp, event_type, group_id, session_id, actor_id, payload, prev_hash, entry_hash) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(
        entry.entryId, entry.timestamp, entry.eventType,
        entry.groupId ?? null, entry.sessionId ?? null, entry.actorId,
        JSON.stringify(entry.payload), prevHash, entryHash
      );
    });
    tx();
  }

  async query(filter: AuditFilter): Promise<AuditEntry[]> {
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

  async verifyChainIntegrity(): Promise<IntegrityReport> {
    const rows = this.db.prepare(
      `SELECT * FROM sc_audit_log ${ORDER_BY_INSERT} ASC`
    ).all() as Array<{
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

    let expectedPrevHash = GENESIS_HASH;

    for (const row of rows) {
      if (row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          firstBrokenAt: row.entry_id,
          checkedAt: Date.now(),
        };
      }

      // 规范化重建：与 _append 完全一致的字段选择
      const entryForHash: Record<string, unknown> = {
        entryId: row.entry_id,
        timestamp: row.timestamp,
        eventType: row.event_type,
        actorId: row.actor_id,
        payload: JSON.parse(row.payload),
        prevHash: row.prev_hash,
      };
      if (row.group_id != null) entryForHash.groupId = row.group_id;
      if (row.session_id != null) entryForHash.sessionId = row.session_id;

      const computedHash = sha256(canonicalSerialize(entryForHash));

      if (row.entry_hash !== computedHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          firstBrokenAt: row.entry_id,
          checkedAt: Date.now(),
        };
      }

      expectedPrevHash = row.entry_hash;
    }

    return {
      valid: true,
      totalEntries: rows.length,
      checkedAt: Date.now(),
    };
  }
}

// ── CLI 入口：npm run verify-audit ──────────────────────────────

if (require.main === module) {
  const Database = require('better-sqlite3');
  const dbPath = process.argv[2] || 'scdata/secureclaw.db';
  const db = new Database(dbPath);
  const audit = new LocalAuditBackend(db);
  audit.verifyChainIntegrity().then(report => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.valid ? 0 : 1);
  });
}
