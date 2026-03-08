/**
 * 步骤：service — 生成并加载服务管理器配置
 * 支持 launchd (macOS) / systemd (Linux) / nohup 回退 (WSL)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  // 先编译
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, nodePath, homeDir);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

// ── macOS launchd ───────────────────────────────────────────────

function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const plistPath = path.join(
    homeDir, 'Library', 'LaunchAgents', 'com.secureclaw.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.secureclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/core/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/secureclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/secureclaw.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
  } catch {
    // 可能已加载
  }

  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes('com.secureclaw');
  } catch {
    // launchctl list 失败
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// ── Linux ───────────────────────────────────────────────────────

function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, nodePath, homeDir);
  } else {
    setupNohupFallback(projectRoot, nodePath, homeDir);
  }
}

// ── Linux systemd ───────────────────────────────────────────────

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();

  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = '/etc/systemd/system/secureclaw.service';
    systemctlPrefix = 'systemctl';
  } else {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      setupNohupFallback(projectRoot, nodePath, homeDir);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, 'secureclaw.service');
    systemctlPrefix = 'systemctl --user';
  }

  const unit = `[Unit]
Description=SecureClaw AI Agent Security Framework
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/core/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/secureclaw.log
StandardError=append:${projectRoot}/logs/secureclaw.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);

  // 检测 Docker 组过期
  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();

  // 停止孤儿进程
  killOrphanedProcesses(projectRoot);

  // 启用并启动
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch { /* ignore */ }

  try {
    execSync(`${systemctlPrefix} enable secureclaw`, { stdio: 'ignore' });
  } catch { /* ignore */ }

  try {
    execSync(`${systemctlPrefix} start secureclaw`, { stdio: 'ignore' });
  } catch { /* ignore */ }

  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active secureclaw`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // 未激活
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// ── nohup 回退 ──────────────────────────────────────────────────

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  _homeDir: string,
): void {
  const wrapperPath = path.join(projectRoot, 'start-secureclaw.sh');
  const pidFile = path.join(projectRoot, 'secureclaw.pid');

  const lines = [
    '#!/bin/bash',
    '# start-secureclaw.sh — Start SecureClaw without systemd',
    `# To stop: kill $(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing SecureClaw (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting SecureClaw..."',
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/core/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/secureclaw.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/secureclaw.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "SecureClaw started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/secureclaw.log"`,
  ];

  fs.writeFileSync(wrapperPath, lines.join('\n') + '\n', { mode: 0o755 });

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// ── 辅助函数 ────────────────────────────────────────────────────

function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/core/index\\.js' || true`, {
      stdio: 'ignore',
    });
  } catch {
    // pkill 不可用或无孤儿进程
  }
}

function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10_000,
    });
    return false;
  } catch {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5_000 });
      return true; // shell 下可用但 systemd session 不可用 → 组过期
    } catch {
      return false;
    }
  }
}
