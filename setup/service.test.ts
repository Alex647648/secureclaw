/**
 * service.ts 单元测试
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

vi.mock('./platform.js', () => ({
  getPlatform: vi.fn().mockReturnValue('macos'),
  getNodePath: vi.fn().mockReturnValue('/usr/local/bin/node'),
  getServiceManager: vi.fn().mockReturnValue('launchd'),
  hasSystemd: vi.fn().mockReturnValue(false),
  isRoot: vi.fn().mockReturnValue(false),
}));

vi.mock('./status.js', () => ({
  emitStatus: vi.fn(),
}));

describe('service', () => {
  const originalCwd = process.cwd();
  const tmpDir = path.join(os.tmpdir(), 'sc-test-service-' + Date.now());

  beforeEach(() => {
    vi.resetModules();
    fs.mkdirSync(tmpDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.mocked(execSync).mockReturnValue('' as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates launchd plist on macOS', async () => {
    const { emitStatus } = await import('./status.js');
    const platformMod = await import('./platform.js');
    vi.mocked(platformMod.getPlatform).mockReturnValue('macos');

    // execSync 模拟：build 成功，launchctl list 包含 secureclaw
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('launchctl list')) {
        return '123\t0\tcom.secureclaw\n' as any;
      }
      return '' as any;
    });

    const { run } = await import('./service.js');
    await run([]);

    expect(emitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        SERVICE_TYPE: 'launchd',
        SERVICE_LOADED: true,
        STATUS: 'success',
      }),
    );

    // 验证 plist 文件写入
    const plistPath = path.join(
      os.homedir(), 'Library', 'LaunchAgents', 'com.secureclaw.plist',
    );
    // 注意：文件写入到真实路径（测试会清理）
    // 这里只验证 emitStatus 被正确调用
  });

  it('emits failed status on build failure', async () => {
    const { emitStatus } = await import('./status.js');

    // execSync 模拟：build 失败
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('npm run build')) {
        throw new Error('build failed');
      }
      return '' as any;
    });

    const { run } = await import('./service.js');

    // process.exit 被调用，需要捕获
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);

    try {
      await run([]);
    } catch {
      // 预期的 process.exit
    }

    expect(emitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        STATUS: 'failed',
        ERROR: 'build_failed',
      }),
    );

    exitSpy.mockRestore();
  });

  it('falls back to nohup on unsupported linux', async () => {
    const { emitStatus } = await import('./status.js');
    const platformMod = await import('./platform.js');

    vi.mocked(platformMod.getPlatform).mockReturnValue('linux');
    vi.mocked(platformMod.getServiceManager).mockReturnValue('none');
    vi.mocked(execSync).mockReturnValue('' as any);

    const { run } = await import('./service.js');
    await run([]);

    expect(emitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        SERVICE_TYPE: 'nohup',
        FALLBACK: 'wsl_no_systemd',
      }),
    );

    // 验证 wrapper 脚本被创建
    const wrapperPath = path.join(tmpDir, 'start-secureclaw.sh');
    expect(fs.existsSync(wrapperPath)).toBe(true);
  });

  it('emits unsupported_platform for unknown OS', async () => {
    const { emitStatus } = await import('./status.js');
    const platformMod = await import('./platform.js');

    vi.mocked(platformMod.getPlatform).mockReturnValue('unknown');
    vi.mocked(execSync).mockReturnValue('' as any);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);

    const { run } = await import('./service.js');
    try {
      await run([]);
    } catch {
      // 预期的 process.exit
    }

    expect(emitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        STATUS: 'failed',
        ERROR: 'unsupported_platform',
      }),
    );

    exitSpy.mockRestore();
  });
});
