// src/execution/network-policy.ts
// 网络策略 → 容器参数映射 + claude_only HTTP_PROXY 过滤代理
import * as http from 'node:http';
import * as net from 'node:net';
import type { NetworkPolicy } from '../core/types';

// ── 容器参数映射 ───────────────────────────────────────────────

export interface NetworkPolicyArgs {
  /** 额外的 container run 参数 */
  containerArgs: string[];
  /** 额外的环境变量 */
  envArgs: string[];
}

/**
 * 根据网络策略生成容器启动参数。
 */
export function getNetworkArgs(
  policy: NetworkPolicy,
  runtime: 'apple' | 'docker',
): NetworkPolicyArgs {
  switch (policy.preset) {
    case 'isolated':
      return {
        containerArgs: ['--network', 'none'],
        envArgs: [],
      };

    case 'claude_only': {
      const proxyHost = runtime === 'apple'
        ? 'host.containers.internal'
        : 'host-gateway';
      return {
        containerArgs: [],
        envArgs: [`HTTPS_PROXY=http://${proxyHost}:18080`],
      };
    }

    case 'trusted':
    case 'open':
      return {
        containerArgs: [],
        envArgs: [],
      };

    default:
      // 未知策略 → 默认隔离
      return {
        containerArgs: ['--network', 'none'],
        envArgs: [],
      };
  }
}

// ── claude_only HTTP_PROXY 过滤代理 ──────────────────────────

const ALLOWED_HOST = 'api.anthropic.com';
const ALLOWED_PORT = 443;
const PROXY_PORT = 18080;

/**
 * 创建 HTTP CONNECT 过滤代理。
 * 仅允许到 api.anthropic.com:443 的 CONNECT 请求，其余返回 403。
 *
 * 注意：这是应用层约束，TCP 直连可绕过。
 * Phase 1 目标用户为内部成员，此限制属于补偿控制。
 */
export function createFilterProxy(): http.Server {
  const server = http.createServer((_req, res) => {
    // 普通 HTTP 请求一律拒绝
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: Only CONNECT to api.anthropic.com:443 is allowed');
  });

  server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr || '443', 10);

    if (host !== ALLOWED_HOST || port !== ALLOWED_PORT) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // 转发到目标
    const targetSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    // 连接空闲超时保护（5 分钟）
    // 需要足够长以支持 Anthropic 流式 API 调用中的长推理暂停
    targetSocket.setTimeout(300_000, () => {
      targetSocket.destroy();
      clientSocket.destroy();
    });

    targetSocket.on('error', () => {
      targetSocket.destroy();
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      targetSocket.destroy();
      clientSocket.destroy();
    });
  });

  // 限制最大并发连接数
  server.maxConnections = 256;

  return server;
}

/**
 * 启动过滤代理（监听 127.0.0.1:18080）。
 * 返回关闭函数。
 */
export async function startFilterProxy(): Promise<{ stop: () => Promise<void> }> {
  const server = createFilterProxy();

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(PROXY_PORT, '127.0.0.1', () => resolve());
  });

  return {
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

/** 暴露常量（测试用） */
export const PROXY_CONFIG = {
  ALLOWED_HOST,
  ALLOWED_PORT,
  PROXY_PORT,
} as const;
