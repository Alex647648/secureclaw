// src/trust/rate-limiter.ts
// 滑动窗口速率限制器 — per-sender 维度，默认 30 条/分钟

// ── 配置 ───────────────────────────────────────────────────────

export interface RateLimiterConfig {
  /** 窗口时长（毫秒），默认 60_000（1 分钟） */
  windowMs: number;
  /** 窗口内最大消息数，默认 30 */
  maxRequests: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  windowMs: 60_000,
  maxRequests: 30,
};

// ── 限速结果 ───────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  /** 当前窗口内的请求计数 */
  currentCount: number;
  /** 窗口最大允许数 */
  maxRequests: number;
  /** 距离最早请求过期的毫秒数（被限流时有用） */
  retryAfterMs: number;
}

// ── RateLimiter 类 ─────────────────────────────────────────────

export class RateLimiter {
  private config: RateLimiterConfig;
  /** sender → timestamp 数组（滑动窗口） */
  private windows: Map<string, number[]> = new Map();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查 sender 是否允许发送消息。
   * 如果允许，自动记录此请求。
   * 如果超限，不记录，返回 allowed: false。
   */
  check(senderId: string, now?: number): RateLimitResult {
    const ts = now ?? Date.now();
    const windowStart = ts - this.config.windowMs;

    // 获取或创建窗口
    let timestamps = this.windows.get(senderId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(senderId, timestamps);
    }

    // 清除过期时间戳
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= this.config.maxRequests) {
      // 超限
      const retryAfterMs = timestamps[0] - windowStart;
      return {
        allowed: false,
        currentCount: timestamps.length,
        maxRequests: this.config.maxRequests,
        retryAfterMs: Math.max(0, retryAfterMs),
      };
    }

    // 允许，记录时间戳
    timestamps.push(ts);
    return {
      allowed: true,
      currentCount: timestamps.length,
      maxRequests: this.config.maxRequests,
      retryAfterMs: 0,
    };
  }

  /** 获取 sender 当前窗口内的计数（不增加计数） */
  peek(senderId: string, now?: number): number {
    const ts = now ?? Date.now();
    const windowStart = ts - this.config.windowMs;
    const timestamps = this.windows.get(senderId);
    if (!timestamps) return 0;
    // 计算窗口内的有效时间戳数
    let count = 0;
    for (const t of timestamps) {
      if (t > windowStart) count++;
    }
    return count;
  }

  /** 清除指定 sender 的限流记录 */
  reset(senderId: string): void {
    this.windows.delete(senderId);
  }

  /** 清除所有限流记录 */
  resetAll(): void {
    this.windows.clear();
  }

  /** 清理过期条目（定期维护，防止内存泄漏） */
  cleanup(now?: number): number {
    const ts = now ?? Date.now();
    const windowStart = ts - this.config.windowMs;
    let removed = 0;

    for (const [senderId, timestamps] of this.windows) {
      // 移除过期时间戳
      while (timestamps.length > 0 && timestamps[0] <= windowStart) {
        timestamps.shift();
        removed++;
      }
      // 如果全部过期，删除整个 key
      if (timestamps.length === 0) {
        this.windows.delete(senderId);
      }
    }

    return removed;
  }

  /** 获取当前配置（测试用） */
  getConfig(): Readonly<RateLimiterConfig> {
    return { ...this.config };
  }
}
