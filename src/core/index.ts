// src/core/index.ts
// SecureClaw 主入口 — 组装所有层，启动服务
import { loadConfig } from './config';
import { generateId } from './utils';
import { SecureClawDB } from '../db/db';
import { LocalAuditBackend } from '../audit/backend/local-audit';
import { CredentialProxy } from '../security/credential-proxy';
import { createContainerBackend } from '../execution/container-backend';
import { createHostBackend } from '../execution/host-backend';
import { startFilterProxy } from '../execution/network-policy';
import { RateLimiter } from '../trust/rate-limiter';
import { TaskBuilder } from '../routing/task-builder';
import { GroupQueue } from '../routing/group-queue';
import { cleanAllSessionDirs } from '../memory/session-memory';
import { createSessionRunner } from '../integration/session-runner';
import { createMessagePipeline, type MessagePipeline } from '../integration/message-pipeline';
import { Scheduler } from '../integration/scheduler';
import { AdminCommandHandler } from '../admin/command-handler';
import { ChannelManager } from '../channels/channel-manager';
import { WhatsAppAdapter } from '../channels/whatsapp-adapter';
import { TelegramAdapter } from '../channels/telegram-adapter';
import { SlackAdapter } from '../channels/slack-adapter';
import { DiscordAdapter } from '../channels/discord-adapter';
import type { ChannelAdapter } from '../channels/interface';
import { startHealthServer, type HealthCheckFn } from './health';
import { reconfigureLogger, getLogger } from './logger';
import { Metrics } from './metrics';

const log = getLogger('core');
const metrics = new Metrics();

// ── 全局引用（用于 shutdown）──────────────────────────────────────

let db: SecureClawDB | null = null;
let credProxy: CredentialProxy | null = null;
let filterProxyStop: (() => Promise<void>) | null = null;
let scheduler: Scheduler | null = null;
let groupQueue: GroupQueue | null = null;
let channelManager: ChannelManager | null = null;
let rateLimiterCleanupTimer: ReturnType<typeof setInterval> | null = null;
let healthStop: (() => Promise<void>) | null = null;
let shuttingDown = false;

// ── 优雅关闭 ─────────────────────────────────────────────────────

async function shutdown(code: number, audit?: LocalAuditBackend): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('Shutting down...');

  // 0. 停止速率限制器清理定时器
  if (rateLimiterCleanupTimer) {
    clearInterval(rateLimiterCleanupTimer);
    rateLimiterCleanupTimer = null;
  }

  // 1. 停止调度器
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }

  // 2. 排空队列（最多等 30 秒）— 在断开通道前执行，让在途任务可以发送响应
  if (groupQueue) {
    try {
      await groupQueue.drain(30_000);
    } catch {
      // 超时或错误，继续关闭
    }
    groupQueue = null;
  }

  // 3. 断开通道连接（队列排空后再断开）
  if (channelManager) {
    try {
      await channelManager.disconnectAll();
    } catch {
      // 忽略
    }
    channelManager = null;
  }

  // 4. 停止凭证代理
  if (credProxy) {
    try {
      await credProxy.stop();
    } catch {
      // 忽略
    }
    credProxy = null;
  }

  // 4. 停止过滤代理
  if (filterProxyStop) {
    try {
      await filterProxyStop();
    } catch {
      // 忽略
    }
    filterProxyStop = null;
  }

  // 5. 清理会话目录
  try {
    cleanAllSessionDirs(process.cwd());
  } catch {
    // 忽略
  }

  // 6. 写关闭审计日志
  if (audit) {
    try {
      await audit.append({
        entryId: generateId(),
        timestamp: Date.now(),
        eventType: 'security_alert',
        actorId: 'system',
        payload: { action: 'shutdown' },
      });
    } catch {
      // 忽略
    }
  }

  // 6.5 停止健康检查服务器
  if (healthStop) {
    try {
      await healthStop();
    } catch {
      // 忽略
    }
    healthStop = null;
  }

  // 7. 关闭数据库
  if (db) {
    db.close();
    db = null;
  }

  process.exit(code);
}

// ── 主函数 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. 加载配置
  const config = loadConfig();

  // 1.5 用加载后的配置重建 logger
  reconfigureLogger(config.log);
  log.info({ name: config.app.name }, 'Starting...');

  // 2. 初始化数据库
  db = new SecureClawDB(config.db.path);

  // 3. 初始化审计层
  const audit = new LocalAuditBackend(db.getDatabase());

  // 4. Bootstrap（首次运行时创建 admin group）
  db.bootstrap(config);

  // 5. 清理上次崩溃残留的会话目录
  cleanAllSessionDirs(process.cwd());

  // 6. 初始化凭证代理
  credProxy = new CredentialProxy(
    config.anthropicApiKey,
    {
      socketDir: config.security.credProxy.socketDir,
      maxRequestsPerSession: config.security.credProxy.maxRequestsPerSession,
    },
    // 审计回调
    (sessionId, groupId, requestCount) => {
      audit.append({
        entryId: generateId(),
        timestamp: Date.now(),
        eventType: 'credential_issued',
        groupId,
        sessionId,
        actorId: 'cred-proxy',
        payload: { requestCount },
      }).catch(() => {});
    },
  );
  await credProxy.start();

  // 7. 启动网络过滤代理（claude_only 策略使用）
  const filterProxy = await startFilterProxy();
  filterProxyStop = filterProxy.stop;

  // 8. 创建执行后端
  const executionBackend = createContainerBackend({
    runtime: config.container.runtime,
    image: config.container.image,
    projectRoot: process.cwd(),
  });

  // 8.5 创建 ADMIN 宿主执行后端（跳过容器，直接在宿主机运行 Claude CLI）
  const hostBackend = createHostBackend({
    apiKey: config.anthropicApiKey,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    projectRoot: process.cwd(),
    db,
  });
  log.info('Host execution backend created for ADMIN tasks');

  // 9. 创建速率限制器 + 定期清理（每 5 分钟）
  const rateLimiter = new RateLimiter();
  rateLimiterCleanupTimer = setInterval(() => {
    rateLimiter.cleanup();
  }, 5 * 60 * 1000);

  // 10. 创建任务构建器
  const taskBuilder = new TaskBuilder({
    projectRoot: process.cwd(),
  });

  // 11. 创建通道适配器
  const adapters: ChannelAdapter[] = [];

  if (config.channels.whatsapp.enabled) {
    adapters.push(new WhatsAppAdapter({ authDir: config.channels.whatsapp.authDir }));
  }
  if (config.channels.telegram.enabled) {
    adapters.push(new TelegramAdapter({ botToken: config.channels.telegram.botToken }));
  }
  if (config.channels.slack.enabled) {
    adapters.push(new SlackAdapter({
      botToken: config.channels.slack.botToken,
      appToken: config.channels.slack.appToken,
    }));
  }
  if (config.channels.discord.enabled) {
    adapters.push(new DiscordAdapter({ botToken: config.channels.discord.botToken }));
  }

  channelManager = new ChannelManager({ adapters }, db, audit);

  // 消息发送回调 — 通过 ChannelManager 路由到对应通道
  const sendMessage = async (msg: { groupId: string; content: string; channelType: string; replyToId?: string }) => {
    if (!channelManager) {
      log.warn('Channel manager unavailable, dropping outbound message');
      return;
    }
    try {
      await channelManager.send(msg);
    } catch (err: any) {
      log.error({ err }, 'Send error');
    }
  };

  // 12. 创建会话运行器（ADMIN 走宿主后端，其他走容器后端）
  const sessionRunner = createSessionRunner(
    {
      projectRoot: process.cwd(),
      timeoutMs: config.container.timeoutMs,
      memoryMb: 512,
      cpuCount: 1,
    },
    executionBackend,
    credProxy,
    db,
    audit,
    sendMessage,
    hostBackend,  // ADMIN 宿主执行后端
  );

  // 13. 创建队列
  groupQueue = new GroupQueue(config.container.maxConcurrent, sessionRunner);

  // 14. 创建管理员命令处理器
  const adminHandler = new AdminCommandHandler(db, audit);

  // 15. 创建消息管线
  const pipelineConfig = {
    triggerWord: config.app.triggerWord,
    adminHandler,
    sendResponse: sendMessage,
  };
  const pipeline: MessagePipeline = createMessagePipeline(
    pipelineConfig,
    db,
    audit,
    rateLimiter,
    taskBuilder,
    groupQueue,
  );

  // 15. 创建调度器
  scheduler = new Scheduler(
    { timezone: config.app.timezone },
    db,
    audit,
    taskBuilder,
    groupQueue,
  );
  scheduler.start();

  // 16. 写启动审计日志
  await audit.append({
    entryId: generateId(),
    timestamp: Date.now(),
    eventType: 'security_alert',
    actorId: 'system',
    payload: {
      action: 'startup',
      version: '1.0.0',
      runtime: config.container.runtime,
      maxConcurrent: config.container.maxConcurrent,
    },
  });

  log.info({
    runtime: config.container.runtime,
    maxConcurrent: config.container.maxConcurrent,
    triggerWord: config.app.triggerWord,
  }, 'Initialized successfully');

  // 17. 连接通道
  channelManager.setPipeline(pipeline);
  await channelManager.connectAll();

  // 17.5 自动触发词：trigger_word 为 "auto" 时从 Bot 名称生成
  if (config.app.triggerWord === 'auto') {
    const botInfo = channelManager.getBotInfo();
    if (botInfo) {
      pipelineConfig.triggerWord = `@${botInfo.username}`;
      log.info({ triggerWord: pipelineConfig.triggerWord, botId: botInfo.id }, 'Auto trigger word set from bot name');
    } else {
      pipelineConfig.triggerWord = '';
      log.warn('trigger_word is "auto" but no bot info available, responding to all messages');
    }
  }

  log.info({ connected: channelManager.connectedCount, total: channelManager.channelTypes.length }, 'Channels connected');

  // 18. 启动健康检查 HTTP 端点
  const startedAt = Date.now();
  const healthCheck: HealthCheckFn = () => ({
    status: shuttingDown ? 'error' : 'ok',
    uptime: Date.now() - startedAt,
    timestamp: Date.now(),
    channels: channelManager?.connectedCount ?? 0,
    metrics: metrics.snapshot(),
  });
  const healthPort = parseInt(process.env.SC_HEALTH_PORT || '9090', 10);
  const health = startHealthServer(healthPort, healthCheck);
  healthStop = health.stop;
  log.info({ port: healthPort }, 'Health endpoint started');

  // 19. 注册信号处理
  process.on('SIGINT', () => { shutdown(0, audit).catch(() => {}); });
  process.on('SIGTERM', () => { shutdown(0, audit).catch(() => {}); });
}

// ── 全局异常兜底 ──────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled rejection');
  // 不退出进程，仅记录日志；避免单个异步错误导致整个服务崩溃
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  // 未捕获同步异常属于严重错误，触发优雅关闭
  shutdown(1).catch(() => {});
});

// ── 启动 ─────────────────────────────────────────────────────────

main().catch(async (err) => {
  log.fatal({ err }, 'Fatal error');
  await shutdown(1).catch(() => {});
});

// 导出管线创建函数供测试使用
export { createMessagePipeline, createSessionRunner, Scheduler };
