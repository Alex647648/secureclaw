// src/core/types.test.ts
// 测试：mergeCapabilities 权限合并安全性、CAPABILITY_PRESETS 完整性
import { describe, it, expect } from 'vitest';
import {
  TrustLevel,
  CAPABILITY_PRESETS,
  NETWORK_POLICY_PRESETS,
  mergeCapabilities,
  SecurityError,
  SAFE_ID_PATTERN,
} from './types';

describe('CAPABILITY_PRESETS', () => {
  it('BLOCKED should have all capabilities false', () => {
    const blocked = CAPABILITY_PRESETS[TrustLevel.BLOCKED];
    expect(Object.values(blocked).every(v => v === false)).toBe(true);
  });

  it('ADMIN should have all capabilities true', () => {
    const admin = CAPABILITY_PRESETS[TrustLevel.ADMIN];
    expect(Object.values(admin).every(v => v === true)).toBe(true);
  });

  it('TRUSTED should not have bash', () => {
    expect(CAPABILITY_PRESETS[TrustLevel.TRUSTED].bash).toBe(false);
    expect(CAPABILITY_PRESETS[TrustLevel.TRUSTED].fileRead).toBe(true);
  });

  it('UNTRUSTED should only have fileRead', () => {
    const u = CAPABILITY_PRESETS[TrustLevel.UNTRUSTED];
    expect(u.fileRead).toBe(true);
    expect(u.fileWrite).toBe(false);
    expect(u.bash).toBe(false);
    expect(u.networkAccess).toBe(false);
  });
});

describe('mergeCapabilities', () => {
  it('should allow lowering permissions (true → false)', () => {
    const base = CAPABILITY_PRESETS[TrustLevel.ADMIN];
    const result = mergeCapabilities(base, { bash: false });
    expect(result.bash).toBe(false);
    expect(result.fileRead).toBe(true); // 其他不变
  });

  it('should NOT allow raising permissions (false → true)', () => {
    const base = CAPABILITY_PRESETS[TrustLevel.TRUSTED];
    const result = mergeCapabilities(base, { bash: true }); // 尝试提权
    expect(result.bash).toBe(false); // 被忽略
  });

  it('should handle multiple overrides', () => {
    const base = CAPABILITY_PRESETS[TrustLevel.ADMIN];
    const result = mergeCapabilities(base, { bash: false, networkAccess: false, spawnSubAgent: false });
    expect(result.bash).toBe(false);
    expect(result.networkAccess).toBe(false);
    expect(result.spawnSubAgent).toBe(false);
    expect(result.fileRead).toBe(true); // 未覆盖的保持不变
  });

  it('should return unchanged base when no valid overrides', () => {
    const base = CAPABILITY_PRESETS[TrustLevel.UNTRUSTED];
    const result = mergeCapabilities(base, { bash: true, networkAccess: true }); // 全部被忽略
    expect(result).toEqual(base);
  });

  it('should not mutate the base object', () => {
    const base = { ...CAPABILITY_PRESETS[TrustLevel.ADMIN] };
    mergeCapabilities(base, { bash: false });
    expect(base.bash).toBe(true); // 原对象未变
  });
});

describe('NETWORK_POLICY_PRESETS', () => {
  it('should have all four presets', () => {
    expect(Object.keys(NETWORK_POLICY_PRESETS)).toEqual(['isolated', 'claude_only', 'trusted', 'open']);
  });
});

describe('SAFE_ID_PATTERN', () => {
  it('should accept valid IDs', () => {
    expect(SAFE_ID_PATTERN.test('main')).toBe(true);
    expect(SAFE_ID_PATTERN.test('group-123')).toBe(true);
    expect(SAFE_ID_PATTERN.test('a_b_c')).toBe(true);
    expect(SAFE_ID_PATTERN.test('A')).toBe(true);
  });

  it('should reject invalid IDs', () => {
    expect(SAFE_ID_PATTERN.test('')).toBe(false);
    expect(SAFE_ID_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(SAFE_ID_PATTERN.test('has space')).toBe(false);
    expect(SAFE_ID_PATTERN.test('../escape')).toBe(false);
    expect(SAFE_ID_PATTERN.test('has@special')).toBe(false);
  });
});

describe('SecurityError', () => {
  it('should be an instance of Error', () => {
    const err = new SecurityError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SecurityError');
    expect(err.message).toBe('test');
  });
});
