// src/trust/rate-limiter.test.ts
import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  // ── 基本功能 ──────────────────────────────────────────────

  it('should allow requests under limit', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 30 });
    const result = limiter.check('user-1', 1000);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(result.maxRequests).toBe(30);
  });

  it('should use default config (30/min)', () => {
    const limiter = new RateLimiter();
    const config = limiter.getConfig();
    expect(config.windowMs).toBe(60_000);
    expect(config.maxRequests).toBe(30);
  });

  it('should block after reaching limit', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 3 });
    const base = 10_000;

    // 3 次允许
    expect(limiter.check('user-1', base).allowed).toBe(true);
    expect(limiter.check('user-1', base + 100).allowed).toBe(true);
    expect(limiter.check('user-1', base + 200).allowed).toBe(true);

    // 第 4 次阻止
    const blocked = limiter.check('user-1', base + 300);
    expect(blocked.allowed).toBe(false);
    expect(blocked.currentCount).toBe(3);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('should not count blocked requests', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const base = 10_000;

    limiter.check('user-1', base);
    limiter.check('user-1', base + 100);
    limiter.check('user-1', base + 200); // blocked, not counted

    expect(limiter.peek('user-1', base + 300)).toBe(2); // 仍然是 2
  });

  // ── 滑动窗口 ──────────────────────────────────────────────

  it('should allow after window expires', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    const base = 10_000;

    limiter.check('user-1', base);
    limiter.check('user-1', base + 100);
    expect(limiter.check('user-1', base + 200).allowed).toBe(false);

    // 窗口过期后应该允许
    expect(limiter.check('user-1', base + 1100).allowed).toBe(true);
  });

  it('should slide window correctly', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    const base = 10_000;

    // t=0: first request
    limiter.check('user-1', base);
    // t=600: second request
    limiter.check('user-1', base + 600);
    // t=700: blocked
    expect(limiter.check('user-1', base + 700).allowed).toBe(false);
    // t=1001: first request expired, one slot free
    expect(limiter.check('user-1', base + 1001).allowed).toBe(true);
    // t=1100: still blocked (second request at t=600 not yet expired)
    expect(limiter.check('user-1', base + 1100).allowed).toBe(false);
    // t=1601: second request expired
    expect(limiter.check('user-1', base + 1601).allowed).toBe(true);
  });

  // ── 多 sender 隔离 ───────────────────────────────────────

  it('should track senders independently', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const base = 10_000;

    limiter.check('user-1', base);
    limiter.check('user-1', base + 100);
    expect(limiter.check('user-1', base + 200).allowed).toBe(false);

    // user-2 should still be allowed
    expect(limiter.check('user-2', base + 200).allowed).toBe(true);
  });

  // ── 30 条/分钟极限测试 ────────────────────────────────────

  it('should allow exactly 30 requests per minute', () => {
    const limiter = new RateLimiter(); // 默认 30/min
    const base = 100_000;

    for (let i = 0; i < 30; i++) {
      const result = limiter.check('user-1', base + i * 100);
      expect(result.allowed).toBe(true);
    }

    // 第 31 条应该被阻止
    const blocked = limiter.check('user-1', base + 30 * 100);
    expect(blocked.allowed).toBe(false);
    expect(blocked.currentCount).toBe(30);
  });

  // ── peek ─────────────────────────────────────────────────

  it('peek should not increase count', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const base = 10_000;

    limiter.check('user-1', base);
    limiter.check('user-1', base + 100);

    expect(limiter.peek('user-1', base + 200)).toBe(2);
    expect(limiter.peek('user-1', base + 200)).toBe(2); // 反复 peek 不增加
  });

  it('peek should return 0 for unknown sender', () => {
    const limiter = new RateLimiter();
    expect(limiter.peek('nonexistent')).toBe(0);
  });

  // ── reset ────────────────────────────────────────────────

  it('should reset single sender', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const base = 10_000;

    limiter.check('user-1', base);
    limiter.check('user-1', base + 100);
    expect(limiter.check('user-1', base + 200).allowed).toBe(false);

    limiter.reset('user-1');
    expect(limiter.check('user-1', base + 300).allowed).toBe(true);
  });

  it('should resetAll', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const base = 10_000;

    limiter.check('user-1', base);
    limiter.check('user-2', base);

    limiter.resetAll();

    expect(limiter.check('user-1', base + 100).allowed).toBe(true);
    expect(limiter.check('user-2', base + 100).allowed).toBe(true);
  });

  // ── cleanup ──────────────────────────────────────────────

  it('should cleanup expired entries', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10 });
    const base = 10_000;

    limiter.check('user-1', base);
    limiter.check('user-2', base);

    // 窗口过期
    const removed = limiter.cleanup(base + 1001);
    expect(removed).toBe(2);
    expect(limiter.peek('user-1', base + 1001)).toBe(0);
  });

  // ── retryAfterMs ─────────────────────────────────────────

  it('should calculate correct retryAfterMs', () => {
    const limiter = new RateLimiter({ windowMs: 10_000, maxRequests: 1 });
    const base = 10_000;

    limiter.check('user-1', base);
    const blocked = limiter.check('user-1', base + 5_000);

    // 第一个请求在 base=10000，窗口 10000ms，所以过期时间是 20000
    // 当前时间 15000，windowStart = 15000-10000 = 5000
    // 第一个时间戳 10000 > 5000，所以还在窗口内
    // retryAfterMs = timestamps[0] - windowStart = 10000 - 5000 = 5000
    expect(blocked.retryAfterMs).toBe(5_000);
  });

  // ── 边界条件：窗口边界精确匹配 ────────────────────────

  it('should expire at exactly window boundary', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.check('user-1', 10_000);
    // 恰好在窗口边界：windowStart = 11000 - 1000 = 10000，时间戳 10000 <= 10000 → 过期
    expect(limiter.check('user-1', 11_000).allowed).toBe(true);
  });

  it('should still block 1ms before window expiry', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.check('user-1', 10_000);
    // windowStart = 10999 - 1000 = 9999，时间戳 10000 > 9999 → 仍在窗口内
    expect(limiter.check('user-1', 10_999).allowed).toBe(false);
  });

  // ── 高并发模拟 ────────────────────────────────────────

  it('should handle rapid burst of 30 messages', () => {
    const limiter = new RateLimiter();
    const base = 100_000;

    // 在同一毫秒内发 30 条（极端突发）
    for (let i = 0; i < 30; i++) {
      expect(limiter.check('burst-user', base).allowed).toBe(true);
    }
    expect(limiter.check('burst-user', base).allowed).toBe(false);
  });

  // ── 大量 sender 内存管理 ─────────────────────────────

  it('should cleanup many senders efficiently', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10 });
    const base = 10_000;

    // 创建 100 个 sender
    for (let i = 0; i < 100; i++) {
      limiter.check(`sender-${i}`, base);
    }

    // 全部过期后清理
    const removed = limiter.cleanup(base + 1001);
    expect(removed).toBe(100);
  });
});
