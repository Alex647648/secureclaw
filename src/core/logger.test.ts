// src/core/logger.test.ts
import { describe, it, expect } from 'vitest';
import { getLogger, reconfigureLogger, logger } from './logger';

describe('logger', () => {
  it('should export a default logger instance', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should create child loggers with module tag', () => {
    const child = getLogger('test-module');
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
    // child logger 应具有 pino logger 的所有方法
    expect(typeof child.error).toBe('function');
    expect(typeof child.warn).toBe('function');
  });

  it('should reconfigure logger without throwing', () => {
    expect(() => reconfigureLogger({ level: 'debug', prettyPrint: false })).not.toThrow();
    expect(() => reconfigureLogger({ level: 'error', prettyPrint: true })).not.toThrow();
    // 恢复默认
    expect(() => reconfigureLogger({ level: 'info', prettyPrint: false })).not.toThrow();
  });

  it('should support all log levels', () => {
    const log = getLogger('level-test');
    // 所有方法都不应抛出
    expect(() => log.debug('debug msg')).not.toThrow();
    expect(() => log.info('info msg')).not.toThrow();
    expect(() => log.warn('warn msg')).not.toThrow();
    expect(() => log.error('error msg')).not.toThrow();
  });

  it('should support structured logging with objects', () => {
    const log = getLogger('structured-test');
    expect(() => log.info({ key: 'value', count: 42 }, 'structured msg')).not.toThrow();
    expect(() => log.error({ err: new Error('test') }, 'error with context')).not.toThrow();
  });
});
