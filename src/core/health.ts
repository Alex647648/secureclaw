// src/core/health.ts
// 轻量级健康检查 HTTP 端点 — 供 K8s/负载均衡探针使用
import * as http from 'node:http';

import type { MetricsSnapshot } from './metrics';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  timestamp: number;
  channels?: number;
  queueDepth?: number;
  metrics?: MetricsSnapshot;
}

export type HealthCheckFn = () => HealthStatus;

/**
 * 启动健康检查 HTTP 服务器。
 * GET /health → 200 + JSON（status=ok/degraded）或 503（status=error）
 * 其他路径 → 404
 */
export function startHealthServer(
  port: number,
  healthCheck: HealthCheckFn,
): { server: http.Server; stop: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const health = healthCheck();
      const statusCode = health.status === 'error' ? 503 : 200;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1');

  const stop = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { server, stop };
}
