/**
 * platform.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

// 模拟 child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// 需要在 mock 之后动态导入
let platform: typeof import('./platform.js');

beforeEach(async () => {
  vi.resetModules();
  platform = await import('./platform.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPlatform', () => {
  it('returns macos for darwin', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    // 重新导入以获取新的 os.platform 值
    expect(platform.getPlatform()).toBe('macos');
  });

  it('returns linux for linux', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    expect(platform.getPlatform()).toBe('linux');
  });

  it('returns unknown for windows', () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    expect(platform.getPlatform()).toBe('unknown');
  });
});

describe('isWSL', () => {
  it('returns false on non-linux', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    expect(platform.isWSL()).toBe(false);
  });

  it('detects WSL from /proc/version', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'Linux version 5.15.0-1036-microsoft-standard-WSL2',
    );
    expect(platform.isWSL()).toBe(true);
  });

  it('returns false for native linux', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'Linux version 6.2.0-generic',
    );
    expect(platform.isWSL()).toBe(false);
  });
});

describe('isRoot', () => {
  it('detects root user', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    expect(platform.isRoot()).toBe(true);
  });

  it('detects non-root user', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    expect(platform.isRoot()).toBe(false);
  });
});

describe('commandExists', () => {
  it('returns true when command exists', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/node'));
    expect(platform.commandExists('node')).toBe(true);
  });

  it('returns false when command not found', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    expect(platform.commandExists('nonexistent')).toBe(false);
  });
});

describe('getNodeVersion', () => {
  it('returns version without v prefix', () => {
    vi.mocked(execSync).mockReturnValue('v20.11.0\n' as any);
    expect(platform.getNodeVersion()).toBe('20.11.0');
  });

  it('returns null when node not found', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    expect(platform.getNodeVersion()).toBe(null);
  });
});

describe('getNodeMajorVersion', () => {
  it('extracts major version', () => {
    vi.mocked(execSync).mockReturnValue('v22.5.1\n' as any);
    expect(platform.getNodeMajorVersion()).toBe(22);
  });

  it('returns null when node not found', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    expect(platform.getNodeMajorVersion()).toBe(null);
  });
});

describe('getServiceManager', () => {
  it('returns launchd on macos', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    expect(platform.getServiceManager()).toBe('launchd');
  });

  it('returns none on unknown platform', () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    expect(platform.getServiceManager()).toBe('none');
  });
});
