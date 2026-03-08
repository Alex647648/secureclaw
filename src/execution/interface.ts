// src/execution/interface.ts
// 执行后端接口（目标C接缝）
import type { AgentTask, AgentResult, ExecutionPolicy, TaskStatus } from '../core/types';

/** 凭证上下文 — 由 session-runner 创建，传递给 ExecutionBackend */
export interface CredentialContext {
  sessionToken: string;
  socketPath: string;
  tcpPort?: number;   // TCP 端口（Docker Desktop for Mac 场景）
}

export interface ExecutionBackend {
  /** 启动容器运行任务 */
  run(task: AgentTask, policy: ExecutionPolicy, credentials?: CredentialContext): Promise<AgentResult>;
  /** 强制终止容器 */
  kill(taskId: string, reason: string): Promise<void>;
  /** 查询容器状态（仅解析 .State.Status，禁止暴露完整 inspect 输出） */
  status(taskId: string): Promise<TaskStatus>;
}
