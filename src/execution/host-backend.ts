// src/execution/host-backend.ts
// 宿主执行后端 — ADMIN 信任级别，Anthropic Messages API + prompt-based 工具调用
// 注：第三方 API 代理不支持原生 tool use，因此用 prompt 模拟工具调用协议
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTask, AgentResult, ExecutionPolicy, TaskStatus } from '../core/types';
import type { ExecutionBackend, CredentialContext } from './interface';
import type { SecureClawDB } from '../db/db';

// ── 配置 ───────────────────────────────────────────────────────

export interface HostBackendConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  projectRoot?: string;
  db?: SecureClawDB;
}

// ── 活跃请求跟踪 ───────────────────────────────────────────────

const activeRequests = new Map<string, { abort: () => void }>();

// ── 工具描述（嵌入 system prompt）──────────────────────────────

// ── 进度回调类型 ─────────────────────────────────────────────

export type ProgressCallback = (message: string) => Promise<void>;

const TOOL_SYSTEM_PROMPT = `
You have access to the following tools on the user's local machine. To use a tool, output EXACTLY this format on its own line:

<tool_call>
{"name": "tool_name", "input": {parameters}}
</tool_call>

Available tools:

== File Operations ==
1. list_files(path?: string, show_hidden?: boolean) - List files and directories. path defaults to ~/Desktop if not specified.
2. read_file(path: string) - Read content of a text file.
3. write_file(path: string, content: string, append?: boolean) - Write/append to a file.
4. move_file(source: string, destination: string) - Move or rename a file/directory.
5. delete_file(path: string) - Delete a file or empty directory.
6. create_directory(path: string) - Create a directory recursively.
7. search_files(pattern: string, directory?: string) - Search for files by name pattern.

== System ==
8. run_command(command: string, cwd?: string) - Execute a shell command (30s timeout).
9. run_applescript(script: string) - Execute AppleScript via osascript. Use for macOS automation: control apps, show dialogs, get system info.
10. ensure_tool(name: string, install_cmd?: string) - Check if a CLI tool is installed, auto-install if missing (via brew/npm).

== Network ==
11. http_request(url: string, method?: string, headers?: object, body?: string) - Make an HTTP/HTTPS request. Returns status + body.
12. web_search(query: string, count?: number) - Search the web. Requires SEARCH_API_KEY env var (Brave Search API).

== Memory ==
13. save_memory(content: string) - Save persistent file-based memory (CLAUDE.md) for role/persona settings.
14. remember(key: string, value: string, tags?: string) - Save a structured key-value memory entry to database. Use for facts, preferences, notes.
15. recall(query: string) - Search structured memories by keyword (matches key, value, or tags).
16. forget(key: string) - Delete a specific structured memory entry.
17. list_memories() - List all structured memory entries for this group.

== Interaction ==
18. ask_confirmation(question: string) - Ask the user a yes/no question and pause. The user's next message will be treated as the answer.

CRITICAL RULES for tool use:
- When the user asks to perform a file operation (list, organize, create, delete, move files), you MUST use the appropriate tool to ACTUALLY DO IT. Do NOT just describe or list — complete the full task.
- For multi-step tasks (e.g., "organize desktop files"): first list_files to see what's there, then create_directory for categories, then move_file for each file. Complete ALL steps.
- You can chain multiple tool calls in one response. Put each <tool_call> on its own line.
- After tool results come back, continue with more <tool_call> until the task is fully done. Only give a text summary when all operations are complete.
- Use ~ for home directory paths (e.g., ~/Desktop).
- When the user sets your name/role/persona, ALWAYS use save_memory to persist it.
- Use remember/recall for storing and retrieving specific facts, preferences, project notes, etc. Use save_memory only for role/persona persistence.
- Be proactive: if the user says "organize", decide a reasonable categorization (by file type: images, documents, code, etc.) and execute it immediately.
`.trim();

// ── 工具执行器 ──────────────────────────────────────────────────

function resolvePath(p: string, homeDir: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(homeDir, p.slice(2));
  }
  if (path.isAbsolute(p)) return p;
  return path.join(homeDir, p);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── 确认式交互状态 ──────────────────────────────────────────────

interface ConfirmationState {
  question: string;
  groupId: string;
  senderId: string;
}

let pendingConfirmation: ConfirmationState | null = null;

// ── HTTP 请求工具 ────────────────────────────────────────────────

function httpToolRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const req = requestFn(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: method.toUpperCase(),
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          // 截断过长响应
          const truncated = data.length > 8000 ? data.slice(0, 8000) + '\n... (truncated)' : data;
          resolve({ status: res.statusCode ?? 0, body: truncated });
        });
      },
    );
    req.on('error', (err: Error) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timeout (15s)')); });
    if (body) req.write(body);
    req.end();
  });
}

function executeTool(
  name: string,
  input: Record<string, unknown>,
  homeDir: string,
  projectRoot: string,
  groupId: string,
  db?: SecureClawDB,
): string | Promise<string> {
  try {
    switch (name) {
      case 'list_files': {
        const dirPath = resolvePath((input.path as string) || '~/Desktop', homeDir);
        const showHidden = input.show_hidden as boolean ?? false;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const items = entries
          .filter(e => showHidden || !e.name.startsWith('.'))
          .map(e => {
            const fullPath = path.join(dirPath, e.name);
            try {
              const stat = fs.statSync(fullPath);
              const size = e.isDirectory() ? '' : ` (${formatSize(stat.size)})`;
              return `${e.isDirectory() ? '📁' : '📄'} ${e.name}${size}`;
            } catch {
              return `❓ ${e.name}`;
            }
          });
        return `Directory: ${dirPath}\n${items.length} items:\n${items.join('\n')}`;
      }

      case 'read_file': {
        const filePath = resolvePath(input.path as string, homeDir);
        const stat = fs.statSync(filePath);
        if (stat.size > 1024 * 1024) {
          return `File too large (${formatSize(stat.size)}). Use run_command with head/tail.`;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        return lines.length > 200
          ? lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more lines)`
          : content;
      }

      case 'write_file': {
        const filePath = resolvePath(input.path as string, homeDir);
        const content = input.content as string;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (input.append) {
          fs.appendFileSync(filePath, content, 'utf8');
          return `Appended ${content.length} chars to ${filePath}`;
        }
        fs.writeFileSync(filePath, content, 'utf8');
        return `Wrote ${content.length} chars to ${filePath}`;
      }

      case 'move_file': {
        const src = resolvePath(input.source as string, homeDir);
        const dst = resolvePath(input.destination as string, homeDir);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return `Moved ${src} → ${dst}`;
      }

      case 'delete_file': {
        const filePath = resolvePath(input.path as string, homeDir);
        const stat = fs.statSync(filePath);
        stat.isDirectory() ? fs.rmdirSync(filePath) : fs.unlinkSync(filePath);
        return `Deleted ${filePath}`;
      }

      case 'create_directory': {
        const dirPath = resolvePath(input.path as string, homeDir);
        fs.mkdirSync(dirPath, { recursive: true });
        return `Created directory ${dirPath}`;
      }

      case 'run_command': {
        const command = input.command as string;
        const cwd = input.cwd ? resolvePath(input.cwd as string, homeDir) : homeDir;
        const output = execSync(command, {
          cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const trimmed = output.trim();
        return trimmed.length > 4000 ? trimmed.slice(0, 4000) + '\n... (truncated)' : (trimmed || '(no output)');
      }

      case 'search_files': {
        const pattern = input.pattern as string;
        const dir = resolvePath((input.directory as string) || homeDir, homeDir);
        const maxDepth = (input.max_depth as number) || 5;
        const output = execSync(
          `find ${JSON.stringify(dir)} -maxdepth ${maxDepth} -name ${JSON.stringify(pattern)} 2>/dev/null | head -50`,
          { encoding: 'utf8', timeout: 10_000 },
        );
        return output.trim() || 'No files found';
      }

      case 'save_memory': {
        const content = input.content as string;
        const memoryDir = path.join(projectRoot, 'groups', groupId);
        const memoryPath = path.join(memoryDir, 'CLAUDE.md');
        fs.mkdirSync(memoryDir, { recursive: true });
        fs.writeFileSync(memoryPath, content, 'utf8');
        return `Memory saved (${content.length} chars). Will be loaded automatically next time.`;
      }

      // ── AppleScript 工具 ──────────────────────────────────

      case 'run_applescript': {
        const script = input.script as string;
        if (!script) return 'Error: script parameter is required';
        const output = execSync(`osascript -e ${JSON.stringify(script)}`, {
          timeout: 15_000,
          maxBuffer: 512 * 1024,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const trimmed = output.trim();
        return trimmed.length > 4000 ? trimmed.slice(0, 4000) + '\n... (truncated)' : (trimmed || '(no output)');
      }

      // ── 依赖安装工具 ──────────────────────────────────────

      case 'ensure_tool': {
        const toolName = input.name as string;
        if (!toolName) return 'Error: name parameter is required';
        // 检查是否已安装
        try {
          const location = execSync(`which ${toolName}`, { encoding: 'utf8', timeout: 5000 }).trim();
          return `✅ ${toolName} is already installed at ${location}`;
        } catch {
          // 未安装，尝试安装
        }
        const installCmd = input.install_cmd as string;
        if (installCmd) {
          try {
            execSync(installCmd, { encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });
            return `✅ Installed ${toolName} via: ${installCmd}`;
          } catch (e: any) {
            return `❌ Failed to install ${toolName}: ${e.message}`;
          }
        }
        // 尝试 brew
        try {
          execSync(`brew install ${toolName}`, { encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });
          return `✅ Installed ${toolName} via brew`;
        } catch {
          // brew 失败，尝试 npm
        }
        try {
          execSync(`npm install -g ${toolName}`, { encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
          return `✅ Installed ${toolName} via npm`;
        } catch (e: any) {
          return `❌ Could not install ${toolName}. Try specifying install_cmd parameter.`;
        }
      }

      // ── HTTP 请求工具 ─────────────────────────────────────

      case 'http_request': {
        const url = input.url as string;
        if (!url) return 'Error: url parameter is required';
        const method = (input.method as string) || 'GET';
        const headers = (input.headers as Record<string, string>) || {};
        const body = input.body as string | undefined;
        return httpToolRequest(url, method, headers, body).then(
          (res) => `HTTP ${res.status}\n${res.body}`,
          (err) => `Error: ${err.message}`,
        );
      }

      // ── 网页搜索工具 ──────────────────────────────────────

      case 'web_search': {
        const query = input.query as string;
        if (!query) return 'Error: query parameter is required';
        const apiKey = process.env.SEARCH_API_KEY;
        if (!apiKey) return 'Error: SEARCH_API_KEY environment variable not set. Set it to a Brave Search API key.';
        const count = Math.min((input.count as number) || 5, 10);
        const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
        return httpToolRequest(searchUrl, 'GET', {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        }).then(
          (res) => {
            try {
              const data = JSON.parse(res.body);
              const results = (data.web?.results || []) as Array<{ title: string; url: string; description: string }>;
              if (results.length === 0) return 'No results found.';
              return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join('\n\n');
            } catch {
              return `Search returned status ${res.status}: ${res.body.slice(0, 500)}`;
            }
          },
          (err) => `Error: ${err.message}`,
        );
      }

      // ── 结构化记忆工具 ────────────────────────────────────

      case 'remember': {
        const key = input.key as string;
        const value = input.value as string;
        if (!key || !value) return 'Error: key and value parameters are required';
        if (!db) return 'Error: database not available';
        const tags = (input.tags as string) || '';
        db.saveMemoryEntry(groupId, key, value, tags);
        return `✅ Remembered "${key}" = "${value.slice(0, 100)}${value.length > 100 ? '...' : ''}"${tags ? ` [tags: ${tags}]` : ''}`;
      }

      case 'recall': {
        const query = input.query as string;
        if (!query) return 'Error: query parameter is required';
        if (!db) return 'Error: database not available';
        const results = db.searchMemory(groupId, query);
        if (results.length === 0) return `No memories found matching "${query}"`;
        return results.map(r => `• ${r.key}: ${r.value}${r.tags ? ` [${r.tags}]` : ''}`).join('\n');
      }

      case 'forget': {
        const key = input.key as string;
        if (!key) return 'Error: key parameter is required';
        if (!db) return 'Error: database not available';
        const deleted = db.deleteMemoryEntry(groupId, key);
        return deleted ? `🗑️ Forgot "${key}"` : `No memory found with key "${key}"`;
      }

      case 'list_memories': {
        if (!db) return 'Error: database not available';
        const all = db.listMemory(groupId);
        if (all.length === 0) return 'No memories stored yet.';
        return all.map(r => `• ${r.key}: ${r.value}${r.tags ? ` [${r.tags}]` : ''}`).join('\n');
      }

      // ── 确认式交互工具 ────────────────────────────────────

      case 'ask_confirmation': {
        const question = input.question as string;
        if (!question) return 'Error: question parameter is required';
        pendingConfirmation = { question, groupId, senderId: '' };
        return `CONFIRMATION_REQUESTED: ${question}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// ── 从模型响应中提取 tool_call ──────────────────────────────────

interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

function extractToolCalls(text: string): { toolCalls: ParsedToolCall[]; cleanText: string } {
  const toolCalls: ParsedToolCall[] = [];
  const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

  let match;
  while ((match = toolCallRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name) {
        toolCalls.push({
          name: parsed.name,
          input: parsed.input || {},
        });
      }
    } catch {
      // JSON 解析失败，跳过
    }
  }

  // 移除 tool_call 标签，得到干净文本
  const cleanText = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

  return { toolCalls, cleanText };
}

// ── API 请求 ────────────────────────────────────────────────────

interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── 模型输出清洗 ─────────────────────────────────────────────────
// 处理各种格式残留：JSON 包装、容器标记、Markdown 多余格式

function cleanModelOutput(raw: string): string {
  let text = raw;

  // 1. 如果整个输出是 JSON（模型错误地输出了 JSON 包装），提取内容
  if (text.startsWith('{') && text.includes('"result"')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.result) text = String(parsed.result);
    } catch { /* 不是 JSON，继续 */ }
  }

  // 2. 剥离容器输出标记（SECURECLAW_OUTPUT_START / SECURECLAW_OUTPUT_END）
  text = text.replace(/SECURECLAW_OUTPUT_START\n?/g, '');
  text = text.replace(/\n?SECURECLAW_OUTPUT_END\n?/g, '');

  // 3. 剥离可能的 JSON 状态包装
  text = text.replace(/^\{"status"\s*:\s*"success"\s*,\s*"result"\s*:\s*"/i, '');
  text = text.replace(/"\s*\}\s*$/i, '');

  // 4. 清理转义换行符（\n 字面量→真正的换行）
  text = text.replace(/\\n/g, '\n');

  // 5. 去除首尾空白
  text = text.trim();

  return text;
}

function apiRequest(
  messages: ApiMessage[],
  system: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  timeoutMs: number,
  taskId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/v1/messages`);

    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages,
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
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          activeRequests.delete(taskId);
          if (res.statusCode !== 200) {
            reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            // 标准 Anthropic 格式：{"content":[{"type":"text","text":"..."}]}
            const textBlock = parsed.content?.find((b: { type: string }) => b.type === 'text');
            if (textBlock?.text) {
              resolve(cleanModelOutput(textBlock.text));
            } else if (parsed.result) {
              // 第三方代理格式：{"status":"success","result":"..."}
              resolve(cleanModelOutput(String(parsed.result)));
            } else if (parsed.choices?.[0]?.message?.content) {
              // OpenAI 兼容格式：{"choices":[{"message":{"content":"..."}}]}
              resolve(cleanModelOutput(parsed.choices[0].message.content));
            } else {
              // 回退：尝试从整个响应中提取文本
              const fallback = parsed.content?.[0]?.text || parsed.text || parsed.message || '';
              resolve(cleanModelOutput(String(fallback)));
            }
          } catch {
            // 非 JSON 响应 — 直接当作文本处理
            resolve(cleanModelOutput(data));
          }
        });
      },
    );

    activeRequests.set(taskId, { abort: () => req.destroy() });

    req.on('error', (err: Error) => {
      activeRequests.delete(taskId);
      reject(new Error(`API request error: ${err.message}`));
    });

    req.on('timeout', () => {
      activeRequests.delete(taskId);
      req.destroy();
      reject(new Error('API request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ── 多轮工具调用循环 ────────────────────────────────────────────

const MAX_TOOL_TURNS = 15;

async function runWithTools(
  prompt: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  timeoutMs: number,
  taskId: string,
  homeDir: string,
  projectRoot: string,
  groupId: string,
  onProgress?: ProgressCallback,
  db?: SecureClawDB,
): Promise<{ output: string; toolCallCount: number; confirmationQuestion?: string }> {
  const messages: ApiMessage[] = [
    { role: 'user', content: prompt },
  ];

  let toolCallCount = 0;
  pendingConfirmation = null;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const responseText = await apiRequest(
      messages, TOOL_SYSTEM_PROMPT, apiKey, baseUrl, model, timeoutMs, taskId,
    );

    const { toolCalls, cleanText } = extractToolCalls(responseText);

    if (toolCalls.length === 0) {
      // 无工具调用 — 返回最终文本（二次清洗确保干净）
      const finalOutput = cleanModelOutput(cleanText || responseText || '');
      return { output: finalOutput || '(empty response)', toolCallCount };
    }

    // 将模型原始响应加入历史
    messages.push({ role: 'assistant', content: responseText });

    // 执行工具，收集结果
    const results: string[] = [];
    for (const tc of toolCalls) {
      console.error(`[host-backend] Tool call #${toolCallCount + 1}: ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`);
      const rawResult = executeTool(tc.name, tc.input, homeDir, projectRoot, groupId, db);
      // 支持异步工具（http_request, web_search）
      const result = rawResult instanceof Promise ? await rawResult : rawResult;
      toolCallCount++;
      console.error(`[host-backend] Tool result: ${result.slice(0, 300)}${result.length > 300 ? '...' : ''}`);
      results.push(`[${tc.name}] result:\n${result}`);

      // 检查确认式交互
      const confirm = pendingConfirmation as ConfirmationState | null;
      if (confirm) {
        return {
          output: cleanText || '',
          toolCallCount,
          confirmationQuestion: confirm.question,
        };
      }
    }

    // 每 5 次工具调用发送进度通知
    if (onProgress && toolCallCount % 5 === 0 && toolCallCount > 0) {
      await onProgress(`⏳ 已执行 ${toolCallCount} 个操作，继续处理中...`);
    }

    // 把工具执行结果作为 user 消息反馈（鼓励继续操作）
    messages.push({
      role: 'user',
      content: `Tool execution results:\n\n${results.join('\n\n')}\n\nContinue with more <tool_call> if the task is not yet complete. If the user asked you to organize/move/create/delete files, you MUST actually perform those operations now — do NOT just describe or list. Once ALL operations are done, give a concise summary in the user's language WITHOUT any <tool_call> tags.`,
    });
  }

  return { output: '(reached maximum tool call limit)', toolCallCount };
}

// ── ExecutionBackend 实现 ──────────────────────────────────────

export interface HostBackendWithProgress extends ExecutionBackend {
  /** 设置进度回调（通过通道发送中间状态） */
  setProgressCallback(cb: ProgressCallback): void;
}

export function createHostBackend(config: HostBackendConfig): HostBackendWithProgress {
  const { apiKey } = config;
  const baseUrl = config.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const model = config.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const homeDir = process.env.HOME || '/tmp';
  const projectRoot = config.projectRoot || process.cwd();
  const db = config.db;
  let progressCallback: ProgressCallback | undefined;

  return {
    setProgressCallback(cb: ProgressCallback) {
      progressCallback = cb;
    },

    async run(task: AgentTask, policy: ExecutionPolicy, _credentials?: CredentialContext): Promise<AgentResult> {
      const startTime = Date.now();
      console.error(`[host-backend] Starting: model=${model}, group=${task.groupId}, prompt=${task.prompt.length} chars`);

      try {
        const { output, toolCallCount, confirmationQuestion } = await runWithTools(
          task.prompt, apiKey, baseUrl, model, policy.timeoutMs,
          task.taskId, homeDir, projectRoot, task.groupId,
          progressCallback, db,
        );

        const durationMs = Date.now() - startTime;
        console.error(`[host-backend] Done: ${durationMs}ms, output=${output.length} chars, tools=${toolCallCount}`);

        const result: AgentResult = {
          taskId: task.taskId,
          sessionId: task.sessionId,
          success: true,
          output,
          durationMs,
          toolCallCount,
        };

        // 如果有确认请求，在 output 前附加提问
        if (confirmationQuestion) {
          result.output = `${confirmationQuestion}\n\n(请回复以继续)`;
        }

        return result;
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        console.error(`[host-backend] Failed: ${durationMs}ms, error=${err.message}`);
        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          success: false,
          error: err.message || 'Unknown error',
          durationMs,
          toolCallCount: 0,
        };
      } finally {
        activeRequests.delete(task.taskId);
      }
    },

    async kill(taskId: string, _reason: string): Promise<void> {
      const req = activeRequests.get(taskId);
      if (req) {
        req.abort();
        activeRequests.delete(taskId);
      }
    },

    async status(taskId: string): Promise<TaskStatus> {
      return activeRequests.has(taskId) ? 'running' : 'unknown';
    },
  };
}

