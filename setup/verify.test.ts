/**
 * verify.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// 模拟依赖
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// 使用模块级变量确保 mock 可跨 resetModules 访问
const mockPrepareGet = vi.fn().mockReturnValue({ count: 2 });
const mockPragma = vi.fn().mockReturnValue([{ integrity_check: 'ok' }]);
const mockClose = vi.fn();

// 必须使用 function 关键字（非箭头函数），因为会被 new 调用
vi.mock('better-sqlite3', () => ({
  default: vi.fn(function () {
    return {
      prepare: vi.fn().mockReturnValue({ get: mockPrepareGet }),
      pragma: mockPragma,
      close: mockClose,
    };
  }),
}));

vi.mock('./platform.js', () => ({
  getPlatform: vi.fn().mockReturnValue('macos'),
  getServiceManager: vi.fn().mockReturnValue('launchd'),
  isRoot: vi.fn().mockReturnValue(false),
  commandExists: vi.fn().mockReturnValue(false),
}));

vi.mock('./status.js', () => ({
  emitStatus: vi.fn(),
}));

describe('verify', () => {
  const tmpDir = path.join(os.tmpdir(), 'sc-test-verify-' + Date.now());

  beforeEach(() => {
    vi.resetModules();
    mockPrepareGet.mockReturnValue({ count: 2 });
    mockPragma.mockReturnValue([{ integrity_check: 'ok' }]);
    mockClose.mockClear();
    vi.mocked(execSync).mockReset();
    fs.mkdirSync(tmpDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports success when all checks pass', async () => {
    const { emitStatus } = await import('./status.js');
    const platformMod = await import('./platform.js');
    vi.mocked(platformMod.commandExists).mockReturnValue(true);

    // launchctl 返回运行中的服务
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('launchctl list')) {
        return '456\t0\tcom.secureclaw\n' as any;
      }
      if (typeof cmd === 'string' && cmd.includes('docker info')) {
        return '' as any;
      }
      return '' as any;
    });

    // 模拟文件系统
    const envPath = path.join(tmpDir, 'secureclaw.env');
    fs.writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-ant-test123\n');

    const dbDir = path.join(tmpDir, 'scdata');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'secureclaw.db'), '');

    const authDir = path.join(tmpDir, 'scdata', 'whatsapp-auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');

    const { run } = await import('./verify.js');
    await run([]);

    expect(emitStatus).toHaveBeenCalledWith(
      'VERIFY',
      expect.objectContaining({
        SERVICE: 'running',
        CREDENTIALS: 'configured',
        CHANNEL_AUTH: 'authenticated',
        REGISTERED_GROUPS: 2,
        DB_INTEGRITY: 'ok',
        STATUS: 'success',
      }),
    );
  });

  it('reports failure when service not running', async () => {
    const { emitStatus } = await import('./status.js');

    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('launchctl list')) {
        return '-\t0\tcom.other\n' as any;
      }
      throw new Error('not found');
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);

    const { run } = await import('./verify.js');

    try {
      await run([]);
    } catch {
      // 预期的 process.exit
    }

    expect(emitStatus).toHaveBeenCalledWith(
      'VERIFY',
      expect.objectContaining({
        STATUS: 'failed',
      }),
    );

    exitSpy.mockRestore();
  });

  it('checks database integrity', async () => {
    const { emitStatus } = await import('./status.js');

    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });

    // 数据库文件存在
    const dbDir = path.join(tmpDir, 'scdata');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'secureclaw.db'), '');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);

    const { run } = await import('./verify.js');

    try {
      await run([]);
    } catch {
      // 预期的 process.exit
    }

    expect(emitStatus).toHaveBeenCalledWith(
      'VERIFY',
      expect.objectContaining({
        DB_INTEGRITY: 'ok',
      }),
    );

    exitSpy.mockRestore();
  });
});
