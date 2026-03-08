/**
 * environment.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 模拟依赖
vi.mock('better-sqlite3', () => {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ count: 0 }),
    }),
    close: vi.fn(),
  };
  return { default: vi.fn(() => mockDb) };
});

vi.mock('./platform.js', () => ({
  commandExists: vi.fn().mockReturnValue(false),
  getNodeMajorVersion: vi.fn().mockReturnValue(22),
  getNodeVersion: vi.fn().mockReturnValue('22.5.1'),
  getPlatform: vi.fn().mockReturnValue('macos'),
  isHeadless: vi.fn().mockReturnValue(false),
  isWSL: vi.fn().mockReturnValue(false),
}));

vi.mock('./status.js', () => ({
  emitStatus: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('environment', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits status block with environment info', async () => {
    const { emitStatus } = await import('./status.js');

    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const { run } = await import('./environment.js');
    await run([]);

    expect(emitStatus).toHaveBeenCalledWith(
      'CHECK_ENVIRONMENT',
      expect.objectContaining({
        STATUS: 'success',
        NODE_OK: true,
        PLATFORM: 'macos',
      }),
    );
  });

  it('detects existing env file', async () => {
    const { emitStatus } = await import('./status.js');

    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (String(p).endsWith('secureclaw.env')) return true;
      return false;
    });

    const { run } = await import('./environment.js');
    await run([]);

    expect(emitStatus).toHaveBeenCalledWith(
      'CHECK_ENVIRONMENT',
      expect.objectContaining({
        HAS_ENV: true,
      }),
    );
  });

  it('reports node not ok when version < 20', async () => {
    const { emitStatus } = await import('./status.js');
    const platformMod = await import('./platform.js');

    vi.mocked(platformMod.getNodeMajorVersion).mockReturnValue(18);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const { run } = await import('./environment.js');
    await run([]);

    expect(emitStatus).toHaveBeenCalledWith(
      'CHECK_ENVIRONMENT',
      expect.objectContaining({
        NODE_OK: false,
      }),
    );
  });
});
