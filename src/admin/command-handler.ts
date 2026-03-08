// src/admin/command-handler.ts
// 管理员命令处理器 — 通过聊天消息执行管理操作
import type { SecureClawDB } from '../db/db';
import type { AuditBackend } from '../audit/backend/interface';
import { TrustLevel, SAFE_ID_PATTERN, type NewGroup } from '../core/types';
import { generateId } from '../core/utils';
import { analyze } from '../trust/injection-guard';
import { CronExpressionParser } from 'cron-parser';

// ── 命令结果 ───────────────────────────────────────────────────

export interface CommandResult {
  success: boolean;
  message: string;
}

// ── 命令定义 ───────────────────────────────────────────────────

export const ADMIN_PREFIX = '!admin';

export const COMMAND_HELP = `SecureClaw 管理命令:
!admin help — 显示此帮助
!admin status — 系统状态
!admin group list — 列出所有群组
!admin group add <id> <channel_type> <channel_id> [name] — 添加群组
!admin group remove <id> — 移除群组
!admin trust set <group_id> <sender_id> <level> — 设置信任级别 (0-3)
!admin trust get <group_id> <sender_id> — 查询信任级别
!admin task list [group_id] — 列出定时任务
!admin task add <group_id> <name> <cron> <prompt> — 添加定时任务
!admin task enable <task_id> — 启用定时任务
!admin task disable <task_id> — 禁用定时任务`;

// ── 命令解析 ───────────────────────────────────────────────────

/**
 * 检测消息是否为管理员命令。
 */
export function isAdminCommand(content: string): boolean {
  return content.trimStart().startsWith(ADMIN_PREFIX);
}

/**
 * 解析命令参数。
 * 支持引号包裹参数（用于含空格的 prompt）。
 */
export function parseArgs(content: string): string[] {
  // 移除 !admin 前缀
  const trimmed = content.trimStart().slice(ADMIN_PREFIX.length).trim();
  if (!trimmed) return [];

  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (!inQuotes && (ch === '"' || ch === "'")) {
      inQuotes = true;
      quoteChar = ch;
      continue;
    }

    if (inQuotes && ch === quoteChar) {
      inQuotes = false;
      quoteChar = '';
      continue;
    }

    if (!inQuotes && ch === ' ') {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) args.push(current);
  return args;
}

// ── 命令处理器 ─────────────────────────────────────────────────

export class AdminCommandHandler {
  private db: SecureClawDB;
  private audit: AuditBackend;

  constructor(db: SecureClawDB, audit: AuditBackend) {
    this.db = db;
    this.audit = audit;
  }

  /**
   * 执行管理员命令。
   * 调用方需先验证发送者具有 ADMIN 信任级别。
   */
  async execute(
    content: string,
    groupId: string,
    senderId: string,
  ): Promise<CommandResult> {
    const args = parseArgs(content);
    if (args.length === 0) {
      return { success: true, message: COMMAND_HELP };
    }

    const subCommand = args[0].toLowerCase();

    try {
      let result: CommandResult;

      switch (subCommand) {
        case 'help':
          result = { success: true, message: COMMAND_HELP };
          break;
        case 'status':
          result = this.handleStatus();
          break;
        case 'group':
          result = this.handleGroup(args.slice(1), senderId);
          break;
        case 'trust':
          result = this.handleTrust(args.slice(1), senderId);
          break;
        case 'task':
          result = await this.handleTask(args.slice(1), senderId);
          break;
        default:
          result = { success: false, message: `未知命令: ${subCommand}\n${COMMAND_HELP}` };
      }

      // 审计日志
      await this.audit.append({
        entryId: generateId(),
        timestamp: Date.now(),
        eventType: 'security_alert',
        groupId,
        actorId: senderId,
        payload: {
          action: 'admin_command',
          command: subCommand,
          args: args.slice(1),
          success: result.success,
        },
      }).catch(() => {});

      return result;
    } catch (err: any) {
      return { success: false, message: `命令执行错误: ${err.message}` };
    }
  }

  // ── status ─────────────────────────────────────────────────

  private handleStatus(): CommandResult {
    const groups = this.db.listGroups();
    const tasks = this.db.listTasks();

    const lines = [
      '=== SecureClaw Status ===',
      `Groups: ${groups.length}`,
      `Scheduled Tasks: ${tasks.length} (${tasks.filter(t => t.enabled).length} enabled)`,
    ];

    return { success: true, message: lines.join('\n') };
  }

  // ── group ──────────────────────────────────────────────────

  private handleGroup(args: string[], senderId: string): CommandResult {
    if (args.length === 0) {
      return { success: false, message: '用法: !admin group <list|add|remove>' };
    }

    const action = args[0].toLowerCase();

    switch (action) {
      case 'list':
        return this.groupList();
      case 'add':
        return this.groupAdd(args.slice(1), senderId);
      case 'remove':
        return this.groupRemove(args.slice(1));
      default:
        return { success: false, message: `未知 group 操作: ${action}` };
    }
  }

  private groupList(): CommandResult {
    const groups = this.db.listGroups();
    if (groups.length === 0) {
      return { success: true, message: '没有已注册的群组。' };
    }

    const lines = ['=== Groups ==='];
    for (const g of groups) {
      const admin = g.is_admin_group ? ' [ADMIN]' : '';
      const trust = ['BLOCKED', 'UNTRUSTED', 'TRUSTED', 'ADMIN'][g.trust_level] || String(g.trust_level);
      lines.push(`- ${g.id}: ${g.name} (${g.channel_type}/${g.channel_id}) trust=${trust}${admin}`);
    }
    return { success: true, message: lines.join('\n') };
  }

  private groupAdd(args: string[], senderId: string): CommandResult {
    // !admin group add <id> <channel_type> <channel_id> [name]
    if (args.length < 3) {
      return { success: false, message: '用法: !admin group add <id> <channel_type> <channel_id> [name]' };
    }

    const [id, channelType, channelId, ...nameParts] = args;
    const name = nameParts.join(' ') || id;

    if (!SAFE_ID_PATTERN.test(id)) {
      return { success: false, message: `无效 group ID: "${id}" — 需匹配 ${SAFE_ID_PATTERN}` };
    }

    const validTypes = ['whatsapp', 'telegram', 'slack', 'discord'];
    if (!validTypes.includes(channelType)) {
      return { success: false, message: `无效 channel_type: "${channelType}" — 需为 ${validTypes.join('/')}` };
    }

    // 检查重复
    if (this.db.getGroup(id)) {
      return { success: false, message: `Group "${id}" 已存在` };
    }

    const newGroup: NewGroup = {
      id,
      name,
      channel_type: channelType,
      channel_id: channelId,
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      is_admin_group: 0,
    };

    this.db.createGroup(newGroup);
    return { success: true, message: `Group "${id}" 已创建 (type=${channelType}, trust=TRUSTED)` };
  }

  private groupRemove(args: string[]): CommandResult {
    if (args.length < 1) {
      return { success: false, message: '用法: !admin group remove <id>' };
    }

    const id = args[0];
    const group = this.db.getGroup(id);
    if (!group) {
      return { success: false, message: `Group "${id}" 不存在` };
    }

    if (group.is_admin_group) {
      return { success: false, message: '不允许删除管理员群组' };
    }

    // 软删除：设为 BLOCKED 并禁用所有关联定时任务
    this.db.updateGroup(id, { trust_level: TrustLevel.BLOCKED });
    const tasks = this.db.listTasks(id);
    for (const task of tasks) {
      this.db.setTaskEnabled(task.id, false);
    }
    return { success: true, message: `Group "${id}" 已禁用（${tasks.length} 个定时任务已同步禁用）` };
  }

  // ── trust ──────────────────────────────────────────────────

  private handleTrust(args: string[], senderId: string): CommandResult {
    if (args.length === 0) {
      return { success: false, message: '用法: !admin trust <set|get>' };
    }

    const action = args[0].toLowerCase();

    switch (action) {
      case 'set':
        return this.trustSet(args.slice(1), senderId);
      case 'get':
        return this.trustGet(args.slice(1));
      default:
        return { success: false, message: `未知 trust 操作: ${action}` };
    }
  }

  private trustSet(args: string[], setBy: string): CommandResult {
    // !admin trust set <group_id> <sender_id> <level>
    if (args.length < 3) {
      return { success: false, message: '用法: !admin trust set <group_id> <sender_id> <level>' };
    }

    const [groupId, memberId, levelStr] = args;

    // 安全验证：groupId 和 memberId 必须符合 SAFE_ID_PATTERN
    if (!SAFE_ID_PATTERN.test(groupId)) {
      return { success: false, message: `无效 group_id: "${groupId}" — 需匹配 ${SAFE_ID_PATTERN}` };
    }
    if (!SAFE_ID_PATTERN.test(memberId)) {
      return { success: false, message: `无效 sender_id: "${memberId}" — 需匹配 ${SAFE_ID_PATTERN}` };
    }

    const level = parseInt(levelStr, 10);

    if (isNaN(level) || level < 0 || level > 3) {
      return { success: false, message: `无效信任级别: "${levelStr}" — 需为 0(BLOCKED)/1(UNTRUSTED)/2(TRUSTED)/3(ADMIN)` };
    }

    const group = this.db.getGroup(groupId);
    if (!group) {
      return { success: false, message: `Group "${groupId}" 不存在` };
    }

    this.db.setMemberTrust(groupId, memberId, level as TrustLevel, setBy, 'admin_command');

    const levelName = ['BLOCKED', 'UNTRUSTED', 'TRUSTED', 'ADMIN'][level];
    return { success: true, message: `已设置 ${memberId} 在 ${groupId} 的信任级别为 ${levelName}(${level})` };
  }

  private trustGet(args: string[]): CommandResult {
    if (args.length < 2) {
      return { success: false, message: '用法: !admin trust get <group_id> <sender_id>' };
    }

    const [groupId, memberId] = args;

    if (!SAFE_ID_PATTERN.test(groupId)) {
      return { success: false, message: `无效 group_id: "${groupId}" — 需匹配 ${SAFE_ID_PATTERN}` };
    }
    if (!SAFE_ID_PATTERN.test(memberId)) {
      return { success: false, message: `无效 sender_id: "${memberId}" — 需匹配 ${SAFE_ID_PATTERN}` };
    }

    const level = this.db.getMemberTrust(groupId, memberId);

    if (level === null) {
      return { success: true, message: `${memberId} 在 ${groupId} 中无显式信任设置（使用群组默认）` };
    }

    const levelName = ['BLOCKED', 'UNTRUSTED', 'TRUSTED', 'ADMIN'][level];
    return { success: true, message: `${memberId} 在 ${groupId}: ${levelName}(${level})` };
  }

  // ── task ───────────────────────────────────────────────────

  private async handleTask(args: string[], senderId: string): Promise<CommandResult> {
    if (args.length === 0) {
      return { success: false, message: '用法: !admin task <list|add|enable|disable>' };
    }

    const action = args[0].toLowerCase();

    switch (action) {
      case 'list':
        return this.taskList(args[1]); // optional group_id
      case 'add':
        return this.taskAdd(args.slice(1), senderId);
      case 'enable':
        return this.taskSetEnabled(args[1], true);
      case 'disable':
        return this.taskSetEnabled(args[1], false);
      default:
        return { success: false, message: `未知 task 操作: ${action}` };
    }
  }

  private taskList(groupId?: string): CommandResult {
    const tasks = this.db.listTasks(groupId);
    if (tasks.length === 0) {
      return { success: true, message: '没有定时任务。' };
    }

    const lines = ['=== Scheduled Tasks ==='];
    for (const t of tasks) {
      const status = t.enabled ? 'ON' : 'OFF';
      const nextRun = new Date(t.next_run_at).toISOString();
      lines.push(`- [${status}] ${t.id}: "${t.name}" cron=${t.cron_expression} next=${nextRun} group=${t.group_id}`);
    }
    return { success: true, message: lines.join('\n') };
  }

  private taskAdd(args: string[], createdBy: string): CommandResult {
    // !admin task add <group_id> <name> <cron> <prompt>
    if (args.length < 4) {
      return { success: false, message: '用法: !admin task add <group_id> <name> <cron_expression> <prompt>' };
    }

    const [groupId, name, cronExpression, ...promptParts] = args;
    const prompt = promptParts.join(' ');

    const group = this.db.getGroup(groupId);
    if (!group) {
      return { success: false, message: `Group "${groupId}" 不存在` };
    }

    // cron 格式验证 — 使用 cron-parser 确保语义正确
    let nextRunAt: number;
    try {
      const expr = CronExpressionParser.parse(cronExpression, {
        currentDate: new Date(),
      });
      nextRunAt = expr.next().getTime();
    } catch {
      return { success: false, message: `无效 cron 表达式: "${cronExpression}"` };
    }

    // 注入检测 — 定时任务 prompt 必须通过扫描
    const injection = analyze(prompt, TrustLevel.TRUSTED);
    if (injection.action === 'block') {
      return {
        success: false,
        message: `定时任务 prompt 未通过注入检测 (score=${injection.score.toFixed(2)}, flags=${injection.flags.join(',')})`,
      };
    }

    const taskId = generateId();
    this.db.createTask({
      id: taskId,
      group_id: groupId,
      name,
      cron_expression: cronExpression,
      prompt,
      trust_level: group.trust_level as TrustLevel,
      network_policy: group.network_policy,
      enabled: 1,
      last_run_at: null,
      next_run_at: nextRunAt,
      created_at: Date.now(),
      created_by: createdBy,
    });

    return { success: true, message: `定时任务已创建: id=${taskId} name="${name}" cron="${cronExpression}"` };
  }

  private taskSetEnabled(taskId: string | undefined, enabled: boolean): CommandResult {
    if (!taskId) {
      return { success: false, message: `用法: !admin task ${enabled ? 'enable' : 'disable'} <task_id>` };
    }

    try {
      this.db.setTaskEnabled(taskId, enabled);
      return { success: true, message: `任务 ${taskId} 已${enabled ? '启用' : '禁用'}` };
    } catch {
      return { success: false, message: `任务 ${taskId} 不存在` };
    }
  }
}
