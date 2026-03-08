// src/security/credential-proxy.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { CredentialProxy } from './credential-proxy';
import { SecurityError } from '../core/types';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-credproxy-test-' + Date.now());
const socketDir = path.join(tmpDir, 'sockets');
const TEST_API_KEY = 'sk-ant-test-key-12345';

let proxy: CredentialProxy;

function makeProxy(
  apiKey = TEST_API_KEY,
  maxReq = 3,
  onIssued?: (sid: string, gid: string, count: number) => void,
): CredentialProxy {
  return new CredentialProxy(apiKey, {
    socketDir,
    maxRequestsPerSession: maxReq,
  }, onIssued);
}

/** 通过 Unix socket 发送凭证请求 */
async function sendRequest(socketPath: string, payload: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(payload) + '\n');
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
    });
    client.on('end', () => {
      try {
        resolve(JSON.parse(data.trim()));
      } catch (e) {
        reject(e);
      }
    });
    client.on('error', reject);
  });
}

beforeEach(async () => {
  fs.mkdirSync(socketDir, { recursive: true });
  proxy = makeProxy();
  await proxy.start();
});

afterEach(async () => {
  await proxy.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CredentialProxy', () => {
  // ── 构造函数 ──────────────────────────────────────────────

  it('should throw if API key is empty', () => {
    expect(() => makeProxy('')).toThrow(SecurityError);
  });

  // ── 会话创建 / 销毁 ──────────────────────────────────────

  it('should create session with unique token and socket', async () => {
    const creds = await proxy.createSession('session-1', 'group-1');

    expect(creds.sessionToken).toMatch(/^[0-9a-f]{64}$/); // 256 bit = 64 hex chars
    expect(creds.socketPath).toContain('session-1.sock');
    // Socket 文件存在性由 sendRequest 测试验证（macOS 长路径下 statSync 不可靠）
    expect(proxy.getActiveSessionCount()).toBe(1);
  });

  it('should throw on duplicate session', async () => {
    await proxy.createSession('session-dup', 'group-1');
    await expect(proxy.createSession('session-dup', 'group-1')).rejects.toThrow(SecurityError);
  });

  it('should destroy session and remove socket', async () => {
    const creds = await proxy.createSession('session-del', 'group-1');
    await proxy.destroySession('session-del');

    expect(fs.existsSync(creds.socketPath)).toBe(false);
    expect(proxy.getActiveSessionCount()).toBe(0);
  });

  it('should handle destroying non-existent session gracefully', async () => {
    await proxy.destroySession('nonexistent'); // should not throw
  });

  // ── 凭证分发 ────────────────────────────────────────────

  it('should issue API key with valid session token', async () => {
    const creds = await proxy.createSession('session-ok', 'group-1');

    const response = await sendRequest(creds.socketPath, {
      type: 'get_api_key',
      sessionToken: creds.sessionToken,
      requestId: 'req-1',
    }) as { ok: boolean; apiKey?: string };

    expect(response.ok).toBe(true);
    expect(response.apiKey).toBe(TEST_API_KEY);
  });

  it('should reject invalid session token', async () => {
    const creds = await proxy.createSession('session-bad-token', 'group-1');

    const response = await sendRequest(creds.socketPath, {
      type: 'get_api_key',
      sessionToken: 'wrong-token',
      requestId: 'req-1',
    }) as { ok: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toBe('invalid_token');
  });

  it('should reject after max requests per session', async () => {
    const maxReq = 2;
    const localProxy = makeProxy(TEST_API_KEY, maxReq);
    await localProxy.start();

    const creds = await localProxy.createSession('session-rate', 'group-1');

    // 前 2 次成功
    for (let i = 0; i < maxReq; i++) {
      const res = await sendRequest(creds.socketPath, {
        type: 'get_api_key',
        sessionToken: creds.sessionToken,
        requestId: `req-${i}`,
      }) as { ok: boolean };
      expect(res.ok).toBe(true);
    }

    // 第 3 次被限流
    const blocked = await sendRequest(creds.socketPath, {
      type: 'get_api_key',
      sessionToken: creds.sessionToken,
      requestId: 'req-over',
    }) as { ok: boolean; error?: string };

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe('rate_limited');

    await localProxy.stop();
  });

  it('should reject malformed JSON', async () => {
    const creds = await proxy.createSession('session-bad-json', 'group-1');

    const response = await new Promise<object>((resolve, reject) => {
      const client = net.createConnection(creds.socketPath, () => {
        client.write('not json\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk.toString(); });
      client.on('end', () => {
        try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); }
      });
      client.on('error', reject);
    }) as { ok: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toBe('invalid_token');
  });

  it('should reject request with missing fields', async () => {
    const creds = await proxy.createSession('session-missing', 'group-1');

    const response = await sendRequest(creds.socketPath, {
      type: 'get_api_key',
      // missing sessionToken and requestId
    }) as { ok: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toBe('invalid_token');
  });

  // ── 审计回调 ──────────────────────────────────────────────

  it('should trigger onCredentialIssued callback', async () => {
    const issued: Array<{ sid: string; gid: string; count: number }> = [];
    const localProxy = makeProxy(TEST_API_KEY, 3, (sid, gid, count) => {
      issued.push({ sid, gid, count });
    });
    await localProxy.start();

    const creds = await localProxy.createSession('session-audit', 'group-audit');

    await sendRequest(creds.socketPath, {
      type: 'get_api_key',
      sessionToken: creds.sessionToken,
      requestId: 'req-1',
    });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toEqual({ sid: 'session-audit', gid: 'group-audit', count: 1 });

    await localProxy.stop();
  });

  // ── 请求计数 ──────────────────────────────────────────────

  it('should track request count per session', async () => {
    const creds = await proxy.createSession('session-count', 'group-1');

    expect(proxy.getSessionRequestCount('session-count')).toBe(0);

    await sendRequest(creds.socketPath, {
      type: 'get_api_key',
      sessionToken: creds.sessionToken,
      requestId: 'req-1',
    });

    expect(proxy.getSessionRequestCount('session-count')).toBe(1);
  });

  it('should return -1 for unknown session request count', () => {
    expect(proxy.getSessionRequestCount('nonexistent')).toBe(-1);
  });

  // ── 清理 ─────────────────────────────────────────────────

  it('should cleanup orphaned sockets on start', async () => {
    // 手动创建一个假 socket 文件
    fs.writeFileSync(path.join(socketDir, 'orphan.sock'), '');

    const newProxy = makeProxy();
    await newProxy.start();

    expect(fs.existsSync(path.join(socketDir, 'orphan.sock'))).toBe(false);

    await newProxy.stop();
  });

  it('stop should destroy all sessions', async () => {
    await proxy.createSession('s1', 'g1');
    await proxy.createSession('s2', 'g2');
    expect(proxy.getActiveSessionCount()).toBe(2);

    await proxy.stop();
    expect(proxy.getActiveSessionCount()).toBe(0);
  });

  // ── BUG-3 回归：时序安全 token 比较 ─────────────────────

  it('should reject tokens with similar prefix (timing-safe)', async () => {
    const creds = await proxy.createSession('session-timing', 'group-1');
    // 构造一个只差最后一个字符的 token
    const almostRight = creds.sessionToken.slice(0, -1) + (
      creds.sessionToken.endsWith('0') ? '1' : '0'
    );

    const response = await sendRequest(creds.socketPath, {
      type: 'get_api_key',
      sessionToken: almostRight,
      requestId: 'req-timing',
    }) as { ok: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toBe('invalid_token');
  });

  // ── 超大请求体 ───────────────────────────────────────────

  it('should disconnect on oversized request (>1KB)', async () => {
    const creds = await proxy.createSession('session-big', 'group-1');

    await expect(new Promise<object>((resolve, reject) => {
      const client = net.createConnection(creds.socketPath, () => {
        // 发送超过 1KB 的数据
        client.write('A'.repeat(2048) + '\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk.toString(); });
      client.on('end', () => {
        if (data.trim()) {
          try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); }
        } else {
          reject(new Error('connection closed without response'));
        }
      });
      client.on('error', reject);
      // 超时防止测试挂起
      setTimeout(() => reject(new Error('timeout')), 3000);
    })).rejects.toThrow();
  });
});
