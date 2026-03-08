// src/core/health.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { startHealthServer, type HealthStatus } from './health';
import * as http from 'node:http';

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 使用随机端口避免冲突
let port = 19090 + Math.floor(Math.random() * 1000);
let stopFn: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (stopFn) {
    await stopFn();
    stopFn = null;
  }
});

describe('startHealthServer', () => {
  it('should return 200 with ok status', async () => {
    const testPort = ++port;
    const healthCheck = (): HealthStatus => ({
      status: 'ok',
      uptime: 1234,
      timestamp: Date.now(),
      channels: 2,
    });

    const { stop } = startHealthServer(testPort, healthCheck);
    stopFn = stop;

    // 等待服务器启动
    await new Promise((r) => setTimeout(r, 100));

    const res = await httpGet(testPort, '/health');
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.uptime).toBe(1234);
    expect(body.channels).toBe(2);
  });

  it('should return 503 when status is error', async () => {
    const testPort = ++port;
    const healthCheck = (): HealthStatus => ({
      status: 'error',
      uptime: 0,
      timestamp: Date.now(),
    });

    const { stop } = startHealthServer(testPort, healthCheck);
    stopFn = stop;

    await new Promise((r) => setTimeout(r, 100));

    const res = await httpGet(testPort, '/health');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).status).toBe('error');
  });

  it('should return 404 for non-health paths', async () => {
    const testPort = ++port;
    const { stop } = startHealthServer(testPort, () => ({
      status: 'ok', uptime: 0, timestamp: Date.now(),
    }));
    stopFn = stop;

    await new Promise((r) => setTimeout(r, 100));

    const res = await httpGet(testPort, '/other');
    expect(res.status).toBe(404);
  });

  it('should stop cleanly', async () => {
    const testPort = ++port;
    const { stop } = startHealthServer(testPort, () => ({
      status: 'ok', uptime: 0, timestamp: Date.now(),
    }));

    await new Promise((r) => setTimeout(r, 100));

    await stop();
    // 停止后应无法连接
    await expect(httpGet(testPort, '/health')).rejects.toThrow();
    // 标记已停止，不需要在 afterEach 中再停
    stopFn = null;
  });

  it('should return degraded status', async () => {
    const testPort = ++port;
    const { stop } = startHealthServer(testPort, () => ({
      status: 'degraded',
      uptime: 500,
      timestamp: Date.now(),
      channels: 0,
    }));
    stopFn = stop;

    await new Promise((r) => setTimeout(r, 100));

    const res = await httpGet(testPort, '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('degraded');
  });
});
