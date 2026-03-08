// src/execution/container-backend.ts
// 容器执行后端 — Apple Container / Docker 运行，stdout 标记解析
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { AgentTask, AgentResult, ExecutionPolicy, TaskStatus } from '../core/types';
import type { ExecutionBackend, CredentialContext } from './interface';

const execFileAsync = promisify(execFile);

// ── stdout 标记 ────────────────────────────────────────────────
export const OUTPUT_START_MARKER = 'SECURECLAW_OUTPUT_START';
export const OUTPUT_END_MARKER = 'SECURECLAW_OUTPUT_END';

/**
 * 从容器 stdout 中提取标记区内容。
 * 返回 undefined 表示未找到标记。
 */
export function extractOutput(stdout: string): string | undefined {
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  if (startIdx === -1) return undefined;

  const contentStart = startIdx + OUTPUT_START_MARKER.length;
  // 使用 lastIndexOf 查找最后一个 END 标记，避免 agent 响应内容中包含标记文字导致截断
  const endIdx = stdout.lastIndexOf(OUTPUT_END_MARKER);
  if (endIdx === -1 || endIdx <= contentStart) return undefined;

  return stdout.slice(contentStart, endIdx).trim();
}

// ── 容器参数构建 ───────────────────────────────────────────────

interface ContainerArgs {
  runtimeCmd: string;
  args: string[];
}

function buildContainerArgs(
  runtime: 'apple' | 'docker',
  task: AgentTask,
  policy: ExecutionPolicy,
  sessionToken: string,
  socketPath: string,
  groupDir: string,
  image: string,
  tcpPort?: number,
): ContainerArgs {
  const runtimeCmd = runtime === 'apple' ? 'container' : 'docker';
  const args: string[] = ['run', '--rm'];

  // 容器名用 taskId（与 kill/status 一致，SAFE_ID_PATTERN 已验证）
  args.push('--name', `sclaw-${task.taskId}`);

  // 非 root 用户
  args.push('--user', 'node');

  // 资源限制
  args.push('--memory', `${policy.memoryMb}m`);
  args.push('--cpus', String(policy.cpuCount));

  // 挂载：group 工作目录（rw）
  args.push('--volume', `${groupDir}:/home/node/group:rw`);

  // 凭证通道：优先 TCP（Docker Desktop for Mac 不支持跨 VM Unix socket 挂载）
  if (tcpPort && runtime === 'docker') {
    // Docker 容器通过 host.docker.internal 连接宿主 TCP 端口
    args.push('--add-host', 'host.docker.internal:host-gateway');
    args.push('--env', `SC_CREDS_HOST=host.docker.internal`);
    args.push('--env', `SC_CREDS_PORT=${tcpPort}`);
  } else {
    // Unix socket 直接挂载（Linux / Apple Container）
    args.push('--volume', `${socketPath}:/tmp/creds.sock:rw`);
  }

  // 环境变量（无 ANTHROPIC_API_KEY）
  args.push('--env', `SC_SESSION_ID=${task.sessionId}`);
  args.push('--env', `SC_SESSION_TOKEN=${sessionToken}`);
  args.push('--env', `SC_GROUP_ID=${task.groupId}`);
  args.push('--env', `SC_TRUST_LEVEL=${task.trustLevel}`);
  args.push('--env', `SC_CAPABILITIES=${JSON.stringify(task.capabilitySet)}`);
  // prompt base64 编码（避免 shell 特殊字符问题）
  args.push('--env', `SC_PROMPT=${Buffer.from(task.prompt, 'utf8').toString('base64')}`);
  // 传递 ANTHROPIC_BASE_URL（第三方代理支持）
  if (process.env.ANTHROPIC_BASE_URL) {
    args.push('--env', `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
  }

  // 网络策略
  if (policy.networkPolicy.preset === 'isolated') {
    args.push('--network', 'none');
  } else if (policy.networkPolicy.preset === 'claude_only') {
    const proxyHost = runtime === 'apple'
      ? 'host.containers.internal'
      : 'host-gateway';
    args.push('--env', `HTTPS_PROXY=http://${proxyHost}:18080`);
  }
  // trusted / open: 无网络限制参数

  args.push(image);
  return { runtimeCmd, args };
}

// ── ExecutionBackend 工厂 ──────────────────────────────────────

export interface ContainerBackendConfig {
  runtime: 'apple' | 'docker';
  image: string;
  /** 项目根目录（用于计算 group 目录绝对路径） */
  projectRoot: string;
}

export function createContainerBackend(config: ContainerBackendConfig): ExecutionBackend {
  const { runtime, image, projectRoot } = config;

  return {
    async run(task: AgentTask, policy: ExecutionPolicy, credentials?: CredentialContext): Promise<AgentResult> {
      const startTime = Date.now();

      // 计算 group 工作目录的绝对路径
      const groupDir = path.resolve(projectRoot, 'groups', task.groupId);

      // 凭证上下文由 session-runner 传入
      const sessionToken = credentials?.sessionToken ?? '';
      const socketPath = credentials?.socketPath ?? `/tmp/secureclaw-creds/${task.sessionId}.sock`;

      const { runtimeCmd, args } = buildContainerArgs(
        runtime, task, policy,
        sessionToken,
        socketPath,
        groupDir,
        image,
        credentials?.tcpPort,
      );

      try {
        const { stdout, stderr } = await execFileAsync(runtimeCmd, args, {
          timeout: policy.timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB stdout buffer
        });

        const rawOutput = extractOutput(stdout);
        // agent-runner 输出 JSON: {"status":"success","result":"..."} 或 {"status":"error","error":"..."}
        let output: string | undefined;
        let outputError: string | undefined;
        if (rawOutput) {
          try {
            const parsed = JSON.parse(rawOutput);
            if (parsed.status === 'success' && parsed.result) {
              output = parsed.result;
            } else {
              outputError = parsed.error || parsed.result || 'Unknown agent error';
            }
          } catch {
            // 非 JSON 格式 — 直接使用原始输出
            output = rawOutput;
          }
        }
        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          success: output !== undefined,
          output,
          error: output === undefined ? (outputError || 'No output markers found in container stdout') : undefined,
          durationMs: Date.now() - startTime,
          toolCallCount: 0, // Phase 1 无法精确统计
        };
      } catch (err: any) {
        const isTimeout = err.killed === true || err.signal === 'SIGTERM';
        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          success: false,
          error: isTimeout
            ? `Container timed out after ${policy.timeoutMs}ms`
            : (err.message || 'Unknown container error'),
          durationMs: Date.now() - startTime,
          toolCallCount: 0,
        };
      }
    },

    async kill(taskId: string, reason: string): Promise<void> {
      const runtimeCmd = runtime === 'apple' ? 'container' : 'docker';
      try {
        await execFileAsync(runtimeCmd, ['kill', `sclaw-${taskId}`]);
      } catch {
        // 容器可能已退出，忽略
      }
    },

    async status(taskId: string): Promise<TaskStatus> {
      const runtimeCmd = runtime === 'apple' ? 'container' : 'docker';
      try {
        // ⚠️ 仅解析 .State.Status 字段，禁止暴露完整 inspect 输出
        const { stdout } = await execFileAsync(runtimeCmd, [
          'inspect', '--format', '{{.State.Status}}', `sclaw-${taskId}`,
        ]);
        const status = stdout.trim().toLowerCase();
        if (status === 'running') return 'running';
        if (status === 'exited') return 'completed';
        return 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
}

/** 导出构建参数函数（测试用） */
export { buildContainerArgs };
