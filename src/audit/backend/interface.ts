// src/audit/backend/interface.ts
// AuditBackend 接口（目标C接缝）
import type { AuditEntry, AuditFilter, IntegrityReport } from '../../core/types';

export interface AuditBackend {
  /** append-only，永远不提供 update/delete */
  append(entry: Omit<AuditEntry, 'prevHash' | 'entryHash'>): Promise<void>;
  /** 查询审计日志 */
  query(filter: AuditFilter): Promise<AuditEntry[]>;
  /** 从 genesis 开始逐条验证 prevHash 链 */
  verifyChainIntegrity(): Promise<IntegrityReport>;
}
