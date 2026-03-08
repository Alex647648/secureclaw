// src/security/sandbox-validator.test.ts
import { describe, it, expect } from 'vitest';
import { assertSafeId, validateTask, LIMITS } from './sandbox-validator';
import {
  type AgentTask,
  TrustLevel,
  CAPABILITY_PRESETS,
  NETWORK_POLICY_PRESETS,
  SecurityError,
} from '../core/types';

function makeTask(overrides?: Partial<AgentTask>): AgentTask {
  return {
    taskId: 'task-001',
    groupId: 'group-001',
    sessionId: 'session-001',
    prompt: 'Hello, please help me',
    trustLevel: TrustLevel.TRUSTED,
    capabilitySet: CAPABILITY_PRESETS[TrustLevel.TRUSTED],
    networkPolicy: NETWORK_POLICY_PRESETS.claude_only,
    source: 'message',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('assertSafeId', () => {
  it('should accept valid IDs', () => {
    expect(() => assertSafeId('abc', 'test')).not.toThrow();
    expect(() => assertSafeId('group-123', 'test')).not.toThrow();
    expect(() => assertSafeId('a_b_c', 'test')).not.toThrow();
    expect(() => assertSafeId('A-Z-0-9', 'test')).not.toThrow();
    expect(() => assertSafeId('a'.repeat(64), 'test')).not.toThrow();
  });

  it('should reject empty strings', () => {
    expect(() => assertSafeId('', 'test')).toThrow(SecurityError);
  });

  it('should reject IDs over 64 chars', () => {
    expect(() => assertSafeId('a'.repeat(65), 'test')).toThrow(SecurityError);
  });

  it('should reject IDs with spaces', () => {
    expect(() => assertSafeId('has space', 'test')).toThrow(SecurityError);
  });

  it('should reject path traversal IDs', () => {
    expect(() => assertSafeId('../etc', 'test')).toThrow(SecurityError);
    expect(() => assertSafeId('../../', 'test')).toThrow(SecurityError);
  });

  it('should reject special characters', () => {
    expect(() => assertSafeId('has@special', 'test')).toThrow(SecurityError);
    expect(() => assertSafeId('has/slash', 'test')).toThrow(SecurityError);
    expect(() => assertSafeId('has.dot', 'test')).toThrow(SecurityError);
  });

  it('should include label in error message', () => {
    expect(() => assertSafeId('bad id!', 'groupId')).toThrow('groupId');
  });
});

describe('validateTask', () => {
  // ── 正常任务 ──────────────────────────────────────────────

  it('should accept valid TRUSTED task', () => {
    expect(() => validateTask(makeTask())).not.toThrow();
  });

  it('should accept valid ADMIN task with bash', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.ADMIN,
      capabilitySet: CAPABILITY_PRESETS[TrustLevel.ADMIN],
    }))).not.toThrow();
  });

  // ── ID 验证 ──────────────────────────────────────────────

  it('should reject invalid groupId', () => {
    expect(() => validateTask(makeTask({ groupId: '../escape' }))).toThrow(SecurityError);
    expect(() => validateTask(makeTask({ groupId: '../escape' }))).toThrow('groupId');
  });

  it('should reject invalid sessionId', () => {
    expect(() => validateTask(makeTask({ sessionId: 'has space' }))).toThrow(SecurityError);
    expect(() => validateTask(makeTask({ sessionId: 'has space' }))).toThrow('sessionId');
  });

  it('should reject invalid taskId', () => {
    expect(() => validateTask(makeTask({ taskId: 'a@b' }))).toThrow(SecurityError);
    expect(() => validateTask(makeTask({ taskId: 'a@b' }))).toThrow('taskId');
  });

  // ── bash 能力限制 ────────────────────────────────────────

  it('should reject bash capability for non-ADMIN', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.TRUSTED,
      capabilitySet: { ...CAPABILITY_PRESETS[TrustLevel.TRUSTED], bash: true },
    }))).toThrow(SecurityError);
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.TRUSTED,
      capabilitySet: { ...CAPABILITY_PRESETS[TrustLevel.TRUSTED], bash: true },
    }))).toThrow('bash');
  });

  it('should allow bash for ADMIN', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.ADMIN,
      capabilitySet: CAPABILITY_PRESETS[TrustLevel.ADMIN],
    }))).not.toThrow();
  });

  // ── open 网络策略限制 ────────────────────────────────────

  it('should reject open network policy for non-ADMIN', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.TRUSTED,
      networkPolicy: NETWORK_POLICY_PRESETS.open,
    }))).toThrow(SecurityError);
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.TRUSTED,
      networkPolicy: NETWORK_POLICY_PRESETS.open,
    }))).toThrow('open');
  });

  it('should allow open network policy for ADMIN', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.ADMIN,
      capabilitySet: CAPABILITY_PRESETS[TrustLevel.ADMIN],
      networkPolicy: NETWORK_POLICY_PRESETS.open,
    }))).not.toThrow();
  });

  // ── prompt 长度限制 ───────────────────────────────────────

  it('should reject prompt exceeding 50K chars', () => {
    expect(() => validateTask(makeTask({
      prompt: 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1),
    }))).toThrow(SecurityError);
    expect(() => validateTask(makeTask({
      prompt: 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1),
    }))).toThrow('Prompt too long');
  });

  it('should accept prompt at exactly 50K chars', () => {
    expect(() => validateTask(makeTask({
      prompt: 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH),
    }))).not.toThrow();
  });

  // ── 边界组合 ──────────────────────────────────────────────

  it('should reject UNTRUSTED with bash (double violation)', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.UNTRUSTED,
      capabilitySet: { ...CAPABILITY_PRESETS[TrustLevel.UNTRUSTED], bash: true },
    }))).toThrow(SecurityError);
  });

  it('should reject BLOCKED with any capabilities', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.BLOCKED,
      capabilitySet: { ...CAPABILITY_PRESETS[TrustLevel.BLOCKED], bash: true },
    }))).toThrow(SecurityError);
  });

  // ── 错误消息包含信任级别名称 ──────────────────────────────

  it('should include trust level name in bash error message', () => {
    try {
      validateTask(makeTask({
        trustLevel: TrustLevel.TRUSTED,
        capabilitySet: { ...CAPABILITY_PRESETS[TrustLevel.TRUSTED], bash: true },
      }));
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain('TRUSTED');
      expect(e.message).toContain('ADMIN');
    }
  });

  it('should include trust level name in open policy error message', () => {
    try {
      validateTask(makeTask({
        trustLevel: TrustLevel.UNTRUSTED,
        networkPolicy: NETWORK_POLICY_PRESETS.open,
      }));
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain('UNTRUSTED');
    }
  });

  // ── 合法 TRUSTED 任务（无 bash、无 open）────────────────

  it('should accept TRUSTED with claude_only network policy', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.TRUSTED,
      networkPolicy: NETWORK_POLICY_PRESETS.claude_only,
    }))).not.toThrow();
  });

  it('should accept TRUSTED with isolated network policy', () => {
    expect(() => validateTask(makeTask({
      trustLevel: TrustLevel.TRUSTED,
      networkPolicy: NETWORK_POLICY_PRESETS.isolated,
    }))).not.toThrow();
  });
});
