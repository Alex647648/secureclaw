// src/security/mount-controller.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateMount, validateMounts, getForbiddenPatterns, getAllowedAbsolutePaths } from './mount-controller';
import { SecurityError } from '../core/types';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-mount-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateMount', () => {
  // ── 路径穿越 ──────────────────────────────────────────────

  it('should reject paths with ..', () => {
    expect(() => validateMount('../../../etc/passwd')).toThrow(SecurityError);
    expect(() => validateMount('/tmp/../etc')).toThrow(SecurityError);
  });

  // ── 不存在的路径 ──────────────────────────────────────────

  it('should reject non-existent paths', () => {
    expect(() => validateMount('/nonexistent/path/foo')).toThrow(SecurityError);
    expect(() => validateMount(path.join(tmpDir, 'nonexistent'))).toThrow(SecurityError);
  });

  // ── 禁止模式 ────────────────────────────────────────────

  it('should reject .ssh directory', () => {
    const sshDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(sshDir);
    expect(() => validateMount(sshDir)).toThrow(SecurityError);
  });

  it('should reject .config/claude directory', () => {
    const claudeDir = path.join(tmpDir, '.config', 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    expect(() => validateMount(claudeDir)).toThrow(SecurityError);
  });

  it('should reject .env file', () => {
    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(envFile, 'SECRET=value');
    expect(() => validateMount(envFile)).toThrow(SecurityError);
  });

  it('should reject credentials file', () => {
    const credFile = path.join(tmpDir, 'credentials');
    fs.writeFileSync(credFile, 'secret');
    expect(() => validateMount(credFile)).toThrow(SecurityError);
  });

  it('should reject private_key file', () => {
    const keyFile = path.join(tmpDir, 'my_private_key.pem');
    fs.writeFileSync(keyFile, 'key');
    expect(() => validateMount(keyFile)).toThrow(SecurityError);
  });

  it('should reject node_modules directory', () => {
    const nmDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nmDir);
    expect(() => validateMount(nmDir + '/')).toThrow(SecurityError);
  });

  it('should reject src directory', () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    expect(() => validateMount(srcDir + '/')).toThrow(SecurityError);
  });

  it('should reject .secret files', () => {
    const secretFile = path.join(tmpDir, '.secret');
    fs.writeFileSync(secretFile, 'hidden');
    expect(() => validateMount(secretFile)).toThrow(SecurityError);
  });

  // ── 符号链接攻击 ──────────────────────────────────────────

  it('should resolve symlinks and check real path', () => {
    // 创建 .ssh 目录
    const sshDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(sshDir);

    // 创建指向 .ssh 的符号链接
    const symlinkPath = path.join(tmpDir, 'innocent-link');
    fs.symlinkSync(sshDir, symlinkPath);

    // 通过符号链接挂载应被拒绝
    expect(() => validateMount(symlinkPath)).toThrow(SecurityError);
  });

  // ── 合法路径 ──────────────────────────────────────────────

  it('should allow legitimate paths within project', () => {
    const groupDir = path.join(tmpDir, 'groups', 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });

    // 需要在 tmpDir 下运行，模拟项目目录
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      expect(() => validateMount(groupDir)).not.toThrow();
    } finally {
      process.chdir(origCwd);
    }
  });

  // ── BUG-5 回归：路径前缀碰撞 ────────────────────────────

  it('should reject paths that share prefix with allowed paths but are different dirs', () => {
    // /tmp/secureclaw-creds 是白名单，/tmp/secureclaw-creds-evil 不应通过
    const evilDir = '/tmp/secureclaw-creds-evil';
    const exists = fs.existsSync(evilDir);
    if (!exists) {
      try { fs.mkdirSync(evilDir, { recursive: true }); } catch { return; }
    }
    try {
      expect(() => validateMount(evilDir)).toThrow(SecurityError);
    } finally {
      if (!exists) {
        try { fs.rmdirSync(evilDir); } catch { /* ignore */ }
      }
    }
  });

  // ── 批量验证 ──────────────────────────────────────────────

  it('should validate multiple paths and throw on first failure', () => {
    const goodDir = path.join(tmpDir, 'valid');
    fs.mkdirSync(goodDir);
    const badDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(badDir);

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      expect(() => validateMounts([goodDir, badDir])).toThrow(SecurityError);
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe('mount-controller: configuration', () => {
  it('should have forbidden patterns defined', () => {
    const patterns = getForbiddenPatterns();
    expect(patterns.length).toBeGreaterThan(10);
  });

  it('should include credential proxy socket dir in allowed paths', () => {
    const allowed = getAllowedAbsolutePaths();
    expect(allowed).toContain('/tmp/secureclaw-creds');
  });
});
