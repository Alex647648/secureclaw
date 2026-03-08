/**
 * 步骤：container — 检测/选择运行时，构建镜像，测试运行
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

interface ContainerArgs {
  runtime: 'apple' | 'docker';
}

function parseArgs(args: string[]): ContainerArgs {
  const result: ContainerArgs = { runtime: 'docker' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime') {
      const val = args[++i];
      if (val === 'apple' || val === 'docker') {
        result.runtime = val;
      }
    }
  }

  return result;
}

function detectRuntime(): 'apple' | 'docker' | null {
  const platform = getPlatform();

  if (platform === 'macos' && commandExists('container')) {
    return 'apple';
  }
  if (commandExists('docker')) {
    try {
      execSync('docker info', { stdio: 'ignore' });
      return 'docker';
    } catch {
      return null;
    }
  }
  return null;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  // 如果没有指定运行时，自动检测
  const detectedRuntime = detectRuntime();
  const runtime = parsed.runtime || detectedRuntime;

  if (!runtime) {
    emitStatus('CONTAINER', {
      STATUS: 'failed',
      ERROR: 'no_runtime_found',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const runtimeCmd = runtime === 'apple' ? 'container' : 'docker';

  // 构建镜像
  const buildScript = path.join(projectRoot, 'container', 'build.sh');
  let buildOk = false;

  if (fs.existsSync(buildScript)) {
    try {
      execSync(`CONTAINER_RUNTIME=${runtimeCmd} bash ${JSON.stringify(buildScript)}`, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000, // 5 分钟
      });
      buildOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Build failed: ${msg}`);
    }
  } else {
    console.error(`Build script not found: ${buildScript}`);
  }

  // 测试运行（仅验证镜像能启动）
  let testOk = false;
  if (buildOk) {
    try {
      // 用缺失环境变量触发快速退出（预期 exit 1），仅验证镜像可加载
      execSync(
        `${runtimeCmd} run --rm --entrypoint node secureclaw-agent:latest -e "console.log('OK')"`,
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );
      testOk = true;
    } catch {
      // 测试运行失败
    }
  }

  emitStatus('CONTAINER', {
    RUNTIME: runtime,
    RUNTIME_CMD: runtimeCmd,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: buildOk ? 'success' : 'failed',
    LOG: 'logs/setup.log',
  });

  if (!buildOk) process.exit(1);
}
