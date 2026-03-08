// src/core/logger.ts
// 统一结构化日志 — 基于 pino，输出 NDJSON（生产）或彩色格式（开发）
import pino from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  level: LogLevel;
  prettyPrint: boolean;
}

// 默认配置（loadConfig 之前的引导阶段使用）
const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  prettyPrint: process.env.NODE_ENV !== 'production',
};

/**
 * 创建 pino logger 实例。
 * 生产环境输出 NDJSON（便于 ELK/Loki 采集），开发环境输出彩色可读格式。
 */
function createLogger(config: LoggerConfig = DEFAULT_CONFIG): pino.Logger {
  const options: pino.LoggerOptions = {
    level: config.level,
    name: 'secureclaw',
  };

  if (config.prettyPrint) {
    // 开发环境使用 pino-pretty（同步 transport）
    return pino(options, pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    }));
  }

  // 生产环境输出 NDJSON 到 stdout
  return pino(options);
}

// 单例 logger — 在 reconfigure() 之前使用默认配置
let logger = createLogger();

/**
 * 用加载后的配置重新创建 logger。
 * 在 loadConfig() 之后、业务逻辑之前调用一次。
 */
export function reconfigureLogger(config: LoggerConfig): void {
  logger = createLogger(config);
}

/**
 * 创建带模块标签的子 logger。
 * 例如：getLogger('trust-engine') → 日志中带 module: 'trust-engine'
 */
export function getLogger(module: string): pino.Logger {
  return logger.child({ module });
}

export { logger };
