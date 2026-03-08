// src/core/utils.test.ts
// 多维度测试：canonicalSerialize、timingSafeEqual、computeDiff、generateId、sha256
import { describe, it, expect } from 'vitest';
import {
  canonicalSerialize,
  timingSafeEqual,
  computeDiff,
  generateId,
  generateSecureRandom,
  sha256,
  hmacSha256,
} from './utils';

// ── canonicalSerialize ─────────────────────────────────────────

describe('canonicalSerialize', () => {
  it('should sort object keys alphabetically', () => {
    const result = canonicalSerialize({ b: 2, a: 1 });
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('should handle nested objects with sorted keys', () => {
    const result = canonicalSerialize({ z: { b: 2, a: 1 }, a: 0 });
    expect(result).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  it('should recurse into arrays and sort nested object keys', () => {
    const result = canonicalSerialize([{ b: 1, a: 2 }]);
    expect(result).toBe('[{"a":2,"b":1}]');
  });

  it('should handle mixed arrays correctly', () => {
    const result = canonicalSerialize([1, 'hello', { c: 3, a: 1 }, null, true]);
    expect(result).toBe('[1,"hello",{"a":1,"c":3},null,true]');
  });

  it('should skip undefined values in objects', () => {
    const a = canonicalSerialize({ x: 1 });
    const b = canonicalSerialize({ x: 1, y: undefined });
    expect(a).toBe(b);
  });

  it('should handle null values', () => {
    expect(canonicalSerialize(null)).toBe('null');
    expect(canonicalSerialize({ a: null })).toBe('{"a":null}');
  });

  it('should handle primitives', () => {
    expect(canonicalSerialize(42)).toBe('42');
    expect(canonicalSerialize('hello')).toBe('"hello"');
    expect(canonicalSerialize(true)).toBe('true');
    expect(canonicalSerialize(false)).toBe('false');
  });

  it('should handle empty structures', () => {
    expect(canonicalSerialize({})).toBe('{}');
    expect(canonicalSerialize([])).toBe('[]');
  });

  it('should handle deeply nested structures', () => {
    const result = canonicalSerialize({ c: { b: { a: 1 } } });
    expect(result).toBe('{"c":{"b":{"a":1}}}');
  });

  it('should handle strings with special characters', () => {
    const result = canonicalSerialize({ key: 'line1\nline2\ttab"quote' });
    expect(JSON.parse(result)).toEqual({ key: 'line1\nline2\ttab"quote' });
  });

  it('should produce deterministic output regardless of insertion order', () => {
    const obj1: Record<string, unknown> = {};
    obj1.z = 1; obj1.a = 2; obj1.m = 3;
    const obj2: Record<string, unknown> = {};
    obj2.a = 2; obj2.m = 3; obj2.z = 1;
    expect(canonicalSerialize(obj1)).toBe(canonicalSerialize(obj2));
  });

  it('should handle undefined at top level', () => {
    expect(canonicalSerialize(undefined)).toBe('null');
  });
});

// ── timingSafeEqual ────────────────────────────────────────────

describe('timingSafeEqual', () => {
  it('should return true for equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('should return false for unequal strings', () => {
    expect(timingSafeEqual('abc', 'xyz')).toBe(false);
  });

  it('should return false for different length strings', () => {
    expect(timingSafeEqual('short', 'much longer string')).toBe(false);
  });

  it('should return true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('should handle long strings', () => {
    const a = 'x'.repeat(10000);
    const b = 'x'.repeat(10000);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it('should detect single character difference', () => {
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
  });
});

// ── computeDiff ────────────────────────────────────────────────

describe('computeDiff', () => {
  it('should compute diff for normal content', () => {
    const result = computeDiff('line1\nline2', 'line1\nline2\nline3');
    expect(result).toContain('2→3');
    expect(result).toContain('+1');
  });

  it('should handle empty to non-empty', () => {
    const result = computeDiff('', 'hello');
    expect(result).toContain('chars: 0→5');
  });

  it('should handle empty to empty', () => {
    const result = computeDiff('', '');
    expect(result).toContain('chars: 0→0');
  });

  it('should handle content shrink', () => {
    const result = computeDiff('line1\nline2\nline3', 'line1');
    expect(result).toContain('-2');
  });
});

// ── generateId / generateSecureRandom ──────────────────────────

describe('generateId', () => {
  it('should produce 32-char hex strings', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should produce unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('generateSecureRandom', () => {
  it('should produce hex string of correct length', () => {
    expect(generateSecureRandom(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSecureRandom(32)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── sha256 / hmacSha256 ────────────────────────────────────────

describe('sha256', () => {
  it('should produce consistent hashes', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });

  it('should produce different hashes for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('should produce 64-char hex string', () => {
    expect(sha256('test')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hmacSha256', () => {
  it('should produce different output with different secrets', () => {
    expect(hmacSha256('data', 'secret1')).not.toBe(hmacSha256('data', 'secret2'));
  });

  it('should be deterministic', () => {
    expect(hmacSha256('data', 'secret')).toBe(hmacSha256('data', 'secret'));
  });
});
