// src/execution/container-backend.test.ts
import { describe, it, expect } from 'vitest';
import {
  extractOutput,
  buildContainerArgs,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from './container-backend';
import { TrustLevel, CAPABILITY_PRESETS, NETWORK_POLICY_PRESETS, type AgentTask, type ExecutionPolicy } from '../core/types';

// ── extractOutput ─────────────────────────────────────────────

describe('extractOutput', () => {
  it('should extract content between markers', () => {
    const stdout = `some logs\n${OUTPUT_START_MARKER}\nHello World\n${OUTPUT_END_MARKER}\nmore logs`;
    expect(extractOutput(stdout)).toBe('Hello World');
  });

  it('should handle multi-line output', () => {
    const stdout = `${OUTPUT_START_MARKER}\nLine 1\nLine 2\nLine 3\n${OUTPUT_END_MARKER}`;
    expect(extractOutput(stdout)).toBe('Line 1\nLine 2\nLine 3');
  });

  it('should return undefined when no start marker', () => {
    expect(extractOutput('no markers here')).toBeUndefined();
  });

  it('should return undefined when no end marker', () => {
    expect(extractOutput(`${OUTPUT_START_MARKER}\ncontent without end`)).toBeUndefined();
  });

  it('should return empty string for empty content between markers', () => {
    expect(extractOutput(`${OUTPUT_START_MARKER}\n${OUTPUT_END_MARKER}`)).toBe('');
  });

  it('should handle markers with surrounding whitespace', () => {
    const stdout = `log\n${OUTPUT_START_MARKER}\n  result  \n${OUTPUT_END_MARKER}\nlog`;
    expect(extractOutput(stdout)).toBe('result');
  });

  it('should extract first occurrence if multiple markers exist', () => {
    const stdout = [
      OUTPUT_START_MARKER, '\nFirst\n', OUTPUT_END_MARKER,
      '\ngarbage\n',
      OUTPUT_START_MARKER, '\nSecond\n', OUTPUT_END_MARKER,
    ].join('');
    expect(extractOutput(stdout)).toBe('First');
  });

  it('should handle Chinese/Unicode output', () => {
    const stdout = `${OUTPUT_START_MARKER}\n你好世界 🎉\n${OUTPUT_END_MARKER}`;
    expect(extractOutput(stdout)).toBe('你好世界 🎉');
  });
});

// ── buildContainerArgs ────────────────────────────────────────

function makeTask(overrides?: Partial<AgentTask>): AgentTask {
  return {
    taskId: 'task-001',
    groupId: 'group-001',
    sessionId: 'session-001',
    prompt: 'Hello, help me',
    trustLevel: TrustLevel.TRUSTED,
    capabilitySet: CAPABILITY_PRESETS[TrustLevel.TRUSTED],
    networkPolicy: NETWORK_POLICY_PRESETS.claude_only,
    source: 'message',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makePolicy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    networkPolicy: NETWORK_POLICY_PRESETS.claude_only,
    capabilitySet: CAPABILITY_PRESETS[TrustLevel.TRUSTED],
    timeoutMs: 1800000,
    memoryMb: 512,
    cpuCount: 1.0,
    ...overrides,
  };
}

describe('buildContainerArgs', () => {
  it('should build apple container args correctly', () => {
    const { runtimeCmd, args } = buildContainerArgs(
      'apple', makeTask(), makePolicy(),
      'test-token', '/tmp/creds/session.sock', '/path/to/groups/group-001', 'secureclaw-agent:latest',
    );

    expect(runtimeCmd).toBe('container');
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('node');
    expect(args).toContain('--name');
    expect(args[args.indexOf('--name') + 1]).toBe('sclaw-task-001');
  });

  it('should build docker args with correct runtime cmd', () => {
    const { runtimeCmd } = buildContainerArgs(
      'docker', makeTask(), makePolicy(),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    expect(runtimeCmd).toBe('docker');
  });

  it('should include resource limits', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask(), makePolicy({ memoryMb: 256, cpuCount: 0.5 }),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    expect(args).toContain('--memory');
    expect(args[args.indexOf('--memory') + 1]).toBe('256m');
    expect(args).toContain('--cpus');
    expect(args[args.indexOf('--cpus') + 1]).toBe('0.5');
  });

  it('should include volume mounts', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask(), makePolicy(),
      'token', '/tmp/secureclaw-creds/session.sock', '/path/groups/group-001', 'img:latest',
    );
    // Group dir mount
    const volumeArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--volume');
    expect(volumeArgs.some(v => v.includes('group-001:/home/node/group:rw'))).toBe(true);
    expect(volumeArgs.some(v => v.includes('creds.sock:rw'))).toBe(true);
  });

  it('should set SC_ environment variables', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask(), makePolicy(),
      'test-token-123', '/tmp/sock', '/path/group', 'img:latest',
    );
    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--env');
    expect(envArgs.some(e => e.startsWith('SC_SESSION_ID='))).toBe(true);
    expect(envArgs.some(e => e.startsWith('SC_SESSION_TOKEN='))).toBe(true);
    expect(envArgs.some(e => e.startsWith('SC_GROUP_ID='))).toBe(true);
    expect(envArgs.some(e => e.startsWith('SC_TRUST_LEVEL='))).toBe(true);
    expect(envArgs.some(e => e.startsWith('SC_CAPABILITIES='))).toBe(true);
    expect(envArgs.some(e => e.startsWith('SC_PROMPT='))).toBe(true);
    // SC_PROMPT 应该是 base64 编码
    const promptEnv = envArgs.find(e => e.startsWith('SC_PROMPT='))!;
    const encoded = promptEnv.split('=')[1];
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('Hello, help me');
  });

  it('should NOT include ANTHROPIC_API_KEY', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask(), makePolicy(),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--env');
    expect(envArgs.some(e => e.includes('ANTHROPIC_API_KEY'))).toBe(false);
  });

  // ── 网络策略参数 ──────────────────────────────────────────

  it('should add --network none for isolated policy', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask({ networkPolicy: NETWORK_POLICY_PRESETS.isolated }),
      makePolicy({ networkPolicy: NETWORK_POLICY_PRESETS.isolated }),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
  });

  it('should add HTTPS_PROXY for claude_only policy (apple)', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask(), makePolicy(),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--env');
    expect(envArgs.some(e => e.startsWith('HTTPS_PROXY=') && e.includes('host.containers.internal'))).toBe(true);
  });

  it('should use host-gateway for claude_only policy (docker)', () => {
    const { args } = buildContainerArgs(
      'docker', makeTask(), makePolicy(),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--env');
    expect(envArgs.some(e => e.startsWith('HTTPS_PROXY=') && e.includes('host-gateway'))).toBe(true);
  });

  it('should add no network args for trusted/open policy', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask({ networkPolicy: NETWORK_POLICY_PRESETS.open }),
      makePolicy({ networkPolicy: NETWORK_POLICY_PRESETS.open }),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    expect(args).not.toContain('--network');
    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--env');
    expect(envArgs.some(e => e.startsWith('HTTPS_PROXY='))).toBe(false);
  });

  it('should place image name as last argument', () => {
    const { args } = buildContainerArgs(
      'apple', makeTask(), makePolicy(),
      'token', '/tmp/sock', '/path/group', 'my-image:v2',
    );
    expect(args[args.length - 1]).toBe('my-image:v2');
  });

  it('should name container using taskId (consistent with kill/status)', () => {
    const task = makeTask({ taskId: 'my-task-id', sessionId: 'my-session-id' });
    const { args } = buildContainerArgs(
      'apple', task, makePolicy(),
      'token', '/tmp/sock', '/path/group', 'img:latest',
    );
    expect(args[args.indexOf('--name') + 1]).toBe('sclaw-my-task-id');
    expect(args[args.indexOf('--name') + 1]).not.toContain('my-session-id');
  });
});
