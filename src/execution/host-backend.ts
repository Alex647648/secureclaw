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

// ── 配置 ───────────────────────────────────────────────────────

export interface HostBackendConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  projectRoot?: string;
}

// ── 活跃请求跟踪 ───────────────────────────────────────────────

const activeRequests = new Map<string, { abort: () => void }>();

// ── 工具描述（嵌入 system prompt）──────────────────────────────

const TOOL_SYSTEM_PROMPT = `
You have access to the following tools on the user's local machine. To use a tool, output EXACTLY this format on its own line:

<tool_call>
{"name": "tool_name", "input": {parameters}}
</tool_call>

Available tools:
1. list_files(path?: string, show_hidden?: boolean) - List files and directories. path defaults to ~/Desktop if not specified.
2. read_file(path: string) - Read content of a text file.
3. write_file(path: string, content: string, append?: boolean) - Write/append to a file.
4. move_file(source: string, destination: string) - Move or rename a file/directory.
5. delete_file(path: string) - Delete a file or empty directory.
6. create_directory(path: string) - Create a directory recursively.
7. run_command(command: string, cwd?: string) - Execute a shell command.
8. search_files(pattern: string, directory?: string) - Search for files by name pattern.
9. save_memory(content: string) - Save persistent memory for this chat. Use to remember role settings, preferences, etc.

CRITICAL RULES for tool use:
- When the user asks to perform a file operation (list, organize, create, delete, move files), you MUST use the appropriate tool to ACTUALLY DO IT. Do NOT just describe or list — complete the full task.
- For multi-step tasks (e.g., "organize desktop files"): first list_files to see what's there, then create_directory for categories, then move_file for each file. Complete ALL steps.
- You can chain multiple tool calls in one response. Put each <tool_call> on its own line.
- After tool results come back, continue with more <tool_call> until the task is fully done. Only give a text summary when all operations are complete.
- Use ~ for home directory paths (e.g., ~/Desktop).
- When the user sets your name/role/persona, ALWAYS use save_memory to persist it.
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

function executeTool(
  name: string,
  input: Record<string, unknown>,
  homeDir: string,
  projectRoot: string,
  groupId: string,
): string {
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
            const textBlock = parsed.content?.find((b: { type: string }) => b.type === 'text');
            resolve(textBlock?.text || '');
          } catch {
            reject(new Error(`Failed to parse API response: ${data.slice(0, 200)}`));
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

const MAX_TOOL_TURNS = 10;

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
): Promise<{ output: string; toolCallCount: number }> {
  const messages: ApiMessage[] = [
    { role: 'user', content: prompt },
  ];

  let toolCallCount = 0;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const responseText = await apiRequest(
      messages, TOOL_SYSTEM_PROMPT, apiKey, baseUrl, model, timeoutMs, taskId,
    );

    const { toolCalls, cleanText } = extractToolCalls(responseText);

    if (toolCalls.length === 0) {
      // 无工具调用 — 返回最终文本
      return { output: cleanText || responseText || '(empty response)', toolCallCount };
    }

    // 将模型原始响应加入历史
    messages.push({ role: 'assistant', content: responseText });

    // 执行工具，收集结果
    const results: string[] = [];
    for (const tc of toolCalls) {
      console.error(`[host-backend] Tool call #${toolCallCount + 1}: ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`);
      const result = executeTool(tc.name, tc.input, homeDir, projectRoot, groupId);
      toolCallCount++;
      console.error(`[host-backend] Tool result: ${result.slice(0, 300)}${result.length > 300 ? '...' : ''}`);
      results.push(`[${tc.name}] result:\n${result}`);
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

export function createHostBackend(config: HostBackendConfig): ExecutionBackend {
  const { apiKey } = config;
  const baseUrl = config.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const model = config.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const homeDir = process.env.HOME || '/tmp';
  const projectRoot = config.projectRoot || process.cwd();

  return {
    async run(task: AgentTask, policy: ExecutionPolicy, _credentials?: CredentialContext): Promise<AgentResult> {
      const startTime = Date.now();
      console.error(`[host-backend] Starting: model=${model}, group=${task.groupId}, prompt=${task.prompt.length} chars`);

      try {
        const { output, toolCallCount } = await runWithTools(
          task.prompt, apiKey, baseUrl, model, policy.timeoutMs,
          task.taskId, homeDir, projectRoot, task.groupId,
        );

        const durationMs = Date.now() - startTime;
        console.error(`[host-backend] Done: ${durationMs}ms, output=${output.length} chars, tools=${toolCallCount}`);

        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          success: true,
          output,
          durationMs,
          toolCallCount,
        };
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
