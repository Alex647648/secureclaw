// src/memory/session-memory.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createSessionDir,
  cleanSessionDir,
  cleanAllSessionDirs,
  sessionDirExists,
  getSessionDir,
  getClaudeDir,
} from './session-memory';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-sessmem-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSessionDir', () => {
  it('should create .claude directory and return path', () => {
    const claudeDir = createSessionDir(tmpDir, 'group-1');
    expect(fs.existsSync(claudeDir)).toBe(true);
    expect(claudeDir).toContain('.claude');
  });

  it('should be idempotent', () => {
    const dir1 = createSessionDir(tmpDir, 'group-1');
    const dir2 = createSessionDir(tmpDir, 'group-1');
    expect(dir1).toBe(dir2);
    expect(fs.existsSync(dir1)).toBe(true);
  });
});

describe('cleanSessionDir', () => {
  it('should delete .claude directory', () => {
    createSessionDir(tmpDir, 'group-clean');
    expect(sessionDirExists(tmpDir, 'group-clean')).toBe(true);

    cleanSessionDir(tmpDir, 'group-clean');
    expect(sessionDirExists(tmpDir, 'group-clean')).toBe(false);
  });

  it('should handle non-existent directory gracefully', () => {
    expect(() => cleanSessionDir(tmpDir, 'nonexistent')).not.toThrow();
  });

  it('should delete files inside .claude directory', () => {
    const claudeDir = createSessionDir(tmpDir, 'group-files');
    fs.writeFileSync(path.join(claudeDir, 'some-file.txt'), 'data');

    cleanSessionDir(tmpDir, 'group-files');
    expect(sessionDirExists(tmpDir, 'group-files')).toBe(false);
  });
});

describe('cleanAllSessionDirs', () => {
  it('should clean all group session dirs', () => {
    createSessionDir(tmpDir, 'group-A');
    createSessionDir(tmpDir, 'group-B');
    createSessionDir(tmpDir, 'group-C');

    expect(sessionDirExists(tmpDir, 'group-A')).toBe(true);
    expect(sessionDirExists(tmpDir, 'group-B')).toBe(true);

    cleanAllSessionDirs(tmpDir);

    expect(sessionDirExists(tmpDir, 'group-A')).toBe(false);
    expect(sessionDirExists(tmpDir, 'group-B')).toBe(false);
    expect(sessionDirExists(tmpDir, 'group-C')).toBe(false);
  });

  it('should handle missing sessions dir', () => {
    expect(() => cleanAllSessionDirs(tmpDir)).not.toThrow();
  });

  it('should skip non-directory entries (e.g. .DS_Store)', () => {
    createSessionDir(tmpDir, 'group-real');
    // 创建一个文件在 sessions 目录下
    const sessionsDir = path.join(tmpDir, 'scdata/sessions');
    fs.writeFileSync(path.join(sessionsDir, '.DS_Store'), 'junk');

    expect(() => cleanAllSessionDirs(tmpDir)).not.toThrow();
    expect(sessionDirExists(tmpDir, 'group-real')).toBe(false);
    // .DS_Store 文件应该还在（未被当作 group 清理）
    expect(fs.existsSync(path.join(sessionsDir, '.DS_Store'))).toBe(true);
  });
});

describe('getSessionDir / getClaudeDir', () => {
  it('should return correct paths', () => {
    expect(getSessionDir(tmpDir, 'grp')).toBe(
      path.join(tmpDir, 'scdata/sessions', 'grp')
    );
    expect(getClaudeDir(tmpDir, 'grp')).toBe(
      path.join(tmpDir, 'scdata/sessions', 'grp', '.claude')
    );
  });

  it('should reject path traversal in groupId', () => {
    expect(() => getSessionDir(tmpDir, '../etc')).toThrow('Invalid groupId');
    expect(() => getSessionDir(tmpDir, '')).toThrow('Invalid groupId');
    expect(() => getSessionDir(tmpDir, 'has space')).toThrow('Invalid groupId');
  });
});

describe('session lifecycle', () => {
  it('should support create → use → clean cycle', () => {
    // 模拟完整会话生命周期
    const claudeDir = createSessionDir(tmpDir, 'lifecycle-group');
    expect(sessionDirExists(tmpDir, 'lifecycle-group')).toBe(true);

    // 模拟容器使用 .claude 目录
    fs.writeFileSync(path.join(claudeDir, 'config.json'), '{}');
    fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects', 'cache.db'), 'data');

    // 任务结束，清理
    cleanSessionDir(tmpDir, 'lifecycle-group');
    expect(sessionDirExists(tmpDir, 'lifecycle-group')).toBe(false);

    // 下次任务应从干净状态开始
    const newDir = createSessionDir(tmpDir, 'lifecycle-group');
    const files = fs.readdirSync(newDir);
    expect(files).toHaveLength(0); // 空目录
  });
});
