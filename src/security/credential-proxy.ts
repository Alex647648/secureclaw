// src/security/credential-proxy.ts
// 凭证代理 — API Key 闭包隔离 + Unix Socket 分发 + 每会话限次
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateSecureRandom, timingSafeEqual } from '../core/utils';
import { SecurityError } from '../core/types';

// ── 类型定义 ───────────────────────────────────────────────────

export interface SessionCredentials {
  sessionToken: string;   // 256-bit 随机 token（非 API Key）
  socketPath: string;     // Unix socket 路径（Linux 直接挂载）
  tcpPort?: number;       // TCP 端口（Docker Desktop for Mac 场景）
}

export interface CredentialProxyConfig {
  socketDir: string;
  maxRequestsPerSession: number;
}

interface SessionState {
  sessionToken: string;
  groupId: string;
  requestCount: number;
  server: net.Server;
  socketPath: string;
  tcpServer?: net.Server;
  tcpPort?: number;
}

// ── 请求 / 响应协议 ────────────────────────────────────────────

interface CredRequest {
  type: 'get_api_key';
  sessionToken: string;
  requestId: string;
}

interface CredResponseOk {
  ok: true;
  apiKey: string;
}

interface CredResponseError {
  ok: false;
  error: 'invalid_token' | 'session_expired' | 'rate_limited';
}

type CredResponse = CredResponseOk | CredResponseError;

// ── 常量 ───────────────────────────────────────────────────────

const MAX_REQUEST_SIZE = 1024;    // 单行 JSON 最大 1KB
const SOCKET_READ_TIMEOUT = 5000; // 5 秒读超时

// ── CredentialProxy 实现 ───────────────────────────────────────

export class CredentialProxy {
  private config: CredentialProxyConfig;
  private sessions: Map<string, SessionState> = new Map();
  /** 审计回调 — 每次发放 API Key 时调用 */
  private onCredentialIssued?: (sessionId: string, groupId: string, requestCount: number) => void;

  // API Key 存储在闭包中，不对外暴露
  private apiKey: string;

  constructor(
    apiKey: string,
    config: CredentialProxyConfig,
    onCredentialIssued?: (sessionId: string, groupId: string, requestCount: number) => void,
  ) {
    if (!apiKey) {
      throw new SecurityError('CredentialProxy: ANTHROPIC_API_KEY is required');
    }
    this.apiKey = apiKey;
    this.config = config;
    this.onCredentialIssued = onCredentialIssued;
  }

  /** 启动：清理孤儿 socket 文件 */
  async start(): Promise<void> {
    await this.cleanupOrphanedSockets();
    // 确保 socket 目录存在
    if (!fs.existsSync(this.config.socketDir)) {
      fs.mkdirSync(this.config.socketDir, { recursive: true, mode: 0o755 });
    }
  }

  /** 停止：关闭所有会话 socket，清理文件 */
  async stop(): Promise<void> {
    const destroyPromises: Promise<void>[] = [];
    for (const sessionId of this.sessions.keys()) {
      destroyPromises.push(this.destroySession(sessionId));
    }
    await Promise.all(destroyPromises);
  }

  /** 为指定会话创建凭证通道 */
  async createSession(sessionId: string, groupId: string): Promise<SessionCredentials> {
    if (this.sessions.has(sessionId)) {
      throw new SecurityError(`Session already exists: ${sessionId}`);
    }

    const sessionToken = generateSecureRandom(32); // 256 bit
    const socketPath = path.join(this.config.socketDir, `${sessionId}.sock`);

    // 如果 socket 文件已存在，先删除
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    const server = net.createServer((conn) => {
      this.handleConnection(conn, sessionId);
    });

    // 监听 Unix socket
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(socketPath, () => {
        // 设置 socket 文件权限 666（容器内 node 用户需要连接）
        try {
          fs.chmodSync(socketPath, 0o666);
        } catch {
          // 某些系统可能不支持对 socket 设 chmod，忽略
        }
        resolve();
      });
    });

    // 同时创建 TCP 服务（Docker Desktop for Mac 不支持 Unix socket 跨 VM 挂载）
    const tcpServer = net.createServer((conn) => {
      this.handleConnection(conn, sessionId);
    });

    const tcpPort = await new Promise<number>((resolve, reject) => {
      tcpServer.on('error', reject);
      tcpServer.listen(0, '0.0.0.0', () => {
        const addr = tcpServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });

    const state: SessionState = {
      sessionToken,
      groupId,
      requestCount: 0,
      server,
      socketPath,
      tcpServer,
      tcpPort,
    };
    this.sessions.set(sessionId, state);

    return { sessionToken, socketPath, tcpPort };
  }

  /** 销毁指定会话 */
  async destroySession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // 关闭服务器（Unix socket + TCP）
    await new Promise<void>((resolve) => {
      state.server.close(() => resolve());
    });
    if (state.tcpServer) {
      await new Promise<void>((resolve) => {
        state.tcpServer!.close(() => resolve());
      });
    }

    // 删除 socket 文件
    try {
      if (fs.existsSync(state.socketPath)) {
        fs.unlinkSync(state.socketPath);
      }
    } catch {
      // 忽略删除失败
    }

    this.sessions.delete(sessionId);
  }

  /** 清理孤儿 socket 文件（进程启动时调用） */
  async cleanupOrphanedSockets(): Promise<void> {
    if (!fs.existsSync(this.config.socketDir)) return;
    const files = fs.readdirSync(this.config.socketDir);
    for (const file of files) {
      if (file.endsWith('.sock')) {
        try {
          fs.unlinkSync(path.join(this.config.socketDir, file));
        } catch {
          // 忽略
        }
      }
    }
  }

  /** 处理单个连接 */
  private handleConnection(conn: net.Socket, sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      conn.end(JSON.stringify({ ok: false, error: 'session_expired' } satisfies CredResponseError) + '\n');
      return;
    }

    // 设置超时
    conn.setTimeout(SOCKET_READ_TIMEOUT);
    conn.on('timeout', () => {
      conn.destroy();
    });

    let buffer = '';

    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');

      // 超过最大请求大小 → 立即关闭
      if (buffer.length > MAX_REQUEST_SIZE) {
        conn.destroy();
        return;
      }

      // 等待换行符表示请求结束
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx).trim();
      // 处理完一个请求后关闭连接
      conn.removeAllListeners('data');

      const response = this.processRequest(line, sessionId, state);
      conn.end(JSON.stringify(response) + '\n');
    });
  }

  /** 处理凭证请求 */
  private processRequest(requestLine: string, sessionId: string, state: SessionState): CredResponse {
    let req: CredRequest;
    try {
      req = JSON.parse(requestLine);
    } catch {
      return { ok: false, error: 'invalid_token' };
    }

    // 验证请求格式
    if (req.type !== 'get_api_key' || !req.sessionToken || !req.requestId) {
      return { ok: false, error: 'invalid_token' };
    }

    // 验证 session token（时序安全比较，防止时序侧信道攻击）
    if (!timingSafeEqual(req.sessionToken, state.sessionToken)) {
      return { ok: false, error: 'invalid_token' };
    }

    // 检查请求次数限制
    if (state.requestCount >= this.config.maxRequestsPerSession) {
      return { ok: false, error: 'rate_limited' };
    }

    // 发放 API Key
    state.requestCount++;

    // 触发审计回调
    if (this.onCredentialIssued) {
      this.onCredentialIssued(sessionId, state.groupId, state.requestCount);
    }

    return { ok: true, apiKey: this.apiKey };
  }

  /** 获取活跃会话数 */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /** 获取会话的请求计数（测试用） */
  getSessionRequestCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.requestCount ?? -1;
  }
}
