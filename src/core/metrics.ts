// src/core/metrics.ts
// 基础运行时指标 — 内存存储，通过 /health 端点暴露

export interface MetricsSnapshot {
  tasks: {
    total: number;
    success: number;
    failed: number;
  };
  queue: {
    enqueued: number;
    rejected: number;
  };
  credentials: {
    issued: number;
  };
  messages: {
    received: number;
    sent: number;
    rateLimited: number;
    injectionBlocked: number;
  };
}

/**
 * 轻量级计数器式指标收集器。
 * 线程安全（单进程 Node.js 无竞态），零依赖。
 * 后续可接 Prometheus client 暴露为 /metrics 端点。
 */
export class Metrics {
  private counters = {
    tasksTotal: 0,
    tasksSuccess: 0,
    tasksFailed: 0,
    queueEnqueued: 0,
    queueRejected: 0,
    credentialsIssued: 0,
    messagesReceived: 0,
    messagesSent: 0,
    messagesRateLimited: 0,
    messagesInjectionBlocked: 0,
  };

  // ── 计数方法 ───────────────────────────────────────────────────

  taskCompleted(success: boolean): void {
    this.counters.tasksTotal++;
    if (success) {
      this.counters.tasksSuccess++;
    } else {
      this.counters.tasksFailed++;
    }
  }

  queueEnqueued(): void {
    this.counters.queueEnqueued++;
  }

  queueRejected(): void {
    this.counters.queueRejected++;
  }

  credentialIssued(): void {
    this.counters.credentialsIssued++;
  }

  messageReceived(): void {
    this.counters.messagesReceived++;
  }

  messageSent(): void {
    this.counters.messagesSent++;
  }

  messageRateLimited(): void {
    this.counters.messagesRateLimited++;
  }

  messageInjectionBlocked(): void {
    this.counters.messagesInjectionBlocked++;
  }

  // ── 快照 ───────────────────────────────────────────────────────

  snapshot(): MetricsSnapshot {
    return {
      tasks: {
        total: this.counters.tasksTotal,
        success: this.counters.tasksSuccess,
        failed: this.counters.tasksFailed,
      },
      queue: {
        enqueued: this.counters.queueEnqueued,
        rejected: this.counters.queueRejected,
      },
      credentials: {
        issued: this.counters.credentialsIssued,
      },
      messages: {
        received: this.counters.messagesReceived,
        sent: this.counters.messagesSent,
        rateLimited: this.counters.messagesRateLimited,
        injectionBlocked: this.counters.messagesInjectionBlocked,
      },
    };
  }

  // ── 重置（用于测试）────────────────────────────────────────────

  reset(): void {
    for (const key of Object.keys(this.counters) as Array<keyof typeof this.counters>) {
      this.counters[key] = 0;
    }
  }
}
