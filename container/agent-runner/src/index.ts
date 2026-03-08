/**
 * SecureClaw Agent Runner
 * 容器内入口：读 SC_* 环境变量 → 连接 creds proxy 获取 API Key → 调用 Claude API → 输出标记
 *
 * 凭证协议（一次性连接）：
 *   连接 /tmp/creds.sock 或 TCP → 发送 JSON + \n → 读取 JSON + \n → 连接关闭
 *
 * 调用策略：
 *   1. 直接调用 Anthropic Messages API（最可靠）
 *   2. 如果 API 调用失败，报错退出
 */

import { connect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

// ── 常量 ────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = 'SECURECLAW_OUTPUT_START';
const OUTPUT_END_MARKER = 'SECURECLAW_OUTPUT_END';
const CREDS_SOCKET_PATH = '/tmp/creds.sock';
const CREDS_HOST = process.env.SC_CREDS_HOST;  // TCP 模式（Docker Desktop for Mac）
const CREDS_PORT = process.env.SC_CREDS_PORT ? parseInt(process.env.SC_CREDS_PORT, 10) : 0;
const SOCKET_TIMEOUT_MS = 5000;

// ── 类型定义 ────────────────────────────────────────────────────

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
  error: string;
}

type CredResponse = CredResponseOk | CredResponseError;

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

// ── 环境变量读取 ────────────────────────────────────────────────

function readEnv(): {
  sessionId: string;
  sessionToken: string;
  groupId: string;
  trustLevel: string;
  capabilities: string;
  prompt: string;
} {
  const sessionId = process.env.SC_SESSION_ID;
  const sessionToken = process.env.SC_SESSION_TOKEN;
  const groupId = process.env.SC_GROUP_ID;
  const trustLevel = process.env.SC_TRUST_LEVEL;
  const capabilities = process.env.SC_CAPABILITIES;
  const promptB64 = process.env.SC_PROMPT;

  if (!sessionId || !sessionToken || !groupId || !trustLevel || !promptB64) {
    throw new Error(
      'Missing required SC_* environment variables: ' +
      'SC_SESSION_ID, SC_SESSION_TOKEN, SC_GROUP_ID, SC_TRUST_LEVEL, SC_PROMPT'
    );
  }

  const prompt = Buffer.from(promptB64, 'base64').toString('utf8');

  return {
    sessionId,
    sessionToken,
    groupId,
    trustLevel,
    capabilities: capabilities || '[]',
    prompt,
  };
}

// ── 凭证获取（Unix Socket / TCP 一次性连接）──────────────────────

function fetchApiKey(sessionToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = (CREDS_HOST && CREDS_PORT)
      ? connect(CREDS_PORT, CREDS_HOST)
      : connect(CREDS_SOCKET_PATH);
    let buffer = '';

    socket.setTimeout(SOCKET_TIMEOUT_MS);

    socket.on('connect', () => {
      const request: CredRequest = {
        type: 'get_api_key',
        sessionToken,
        requestId: randomUUID(),
      };
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');

      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx).trim();
      socket.destroy();

      try {
        const response: CredResponse = JSON.parse(line);
        if (response.ok) {
          resolve(response.apiKey);
        } else {
          reject(new Error(`Credential proxy error: ${response.error}`));
        }
      } catch {
        reject(new Error('Failed to parse credential response'));
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Credential socket timeout'));
    });

    socket.on('error', (err: Error) => {
      reject(new Error(`Credential socket error: ${err.message}`));
    });
  });
}

// ── 输出函数 ────────────────────────────────────────────────────

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ── 直接调用 Anthropic Messages API ──────────────────────────────

function callAnthropicApi(prompt: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const url = new URL(`${baseUrl}/v1/messages`);

    const body = JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 300_000, // 5 分钟
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            // 提取第一个 text content block
            const textBlock = parsed.content?.find((b: { type: string }) => b.type === 'text');
            if (textBlock?.text) {
              resolve(textBlock.text);
            } else {
              reject(new Error('No text content in API response'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse API response: ${data.slice(0, 200)}`));
          }
        });
      },
    );

    req.on('error', (err: Error) => {
      reject(new Error(`API request error: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('API request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ── 主流程 ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let env: ReturnType<typeof readEnv>;

  try {
    env = readEnv();
    log(`Session: ${env.sessionId}, Group: ${env.groupId}, Trust: ${env.trustLevel}`);
    log(`Prompt length: ${env.prompt.length} chars`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Environment error: ${msg}`);
    writeOutput({ status: 'error', result: null, error: msg });
    process.exit(1);
  }

  // 获取 API Key
  let apiKey: string;
  try {
    apiKey = await fetchApiKey(env.sessionToken);
    log('API Key obtained from credential proxy');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Credential fetch failed: ${msg}`);
    writeOutput({ status: 'error', result: null, error: `Credential error: ${msg}` });
    process.exit(1);
  }

  // 直接调用 Anthropic Messages API
  try {
    log('Calling Anthropic Messages API...');
    const result = await callAnthropicApi(env.prompt, apiKey);
    log(`API result: ${result.slice(0, 200)}...`);
    writeOutput({ status: 'success', result });
    log('Agent runner completed successfully');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`API call failed: ${msg}`);
    writeOutput({ status: 'error', result: null, error: msg });
    process.exit(1);
  }
}

main();
