/**
 * 步骤：verify — 6 项验证清单
 * 1. 服务状态  2. 容器运行时  3. 凭证  4. 通道认证  5. 已注册群组  6. 数据库完整性
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  getPlatform,
  getServiceManager,
  isRoot,
  commandExists,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  // 1. 服务状态
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      if (output.includes('com.secureclaw')) {
        const line = output.split('\n').find(l => l.includes('com.secureclaw'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl 不可用
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active secureclaw`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, { encoding: 'utf-8' });
        if (output.includes('secureclaw')) {
          service = 'stopped';
        }
      } catch {
        // systemctl 不可用
      }
    }
  } else {
    // nohup PID 检查
    const pidFile = path.join(projectRoot, 'secureclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        if (pid) {
          execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }

  // 2. 容器运行时
  let containerRuntime = 'none';
  if (commandExists('container')) {
    containerRuntime = 'apple-container';
  } else {
    try {
      execSync('docker info', { stdio: 'ignore' });
      containerRuntime = 'docker';
    } catch {
      // 无运行时
    }
  }

  // 3. 凭证
  let credentials = 'missing';
  const envFile = path.join(projectRoot, 'secureclaw.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    if (/^ANTHROPIC_API_KEY=sk-ant-.+/m.test(content)) {
      credentials = 'configured';
    }
  }

  // 4. 通道认证（WhatsApp）
  let channelAuth = 'not_found';
  const authDir = path.join(projectRoot, 'scdata', 'whatsapp-auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth = 'authenticated';
  }

  // 5. 已注册群组
  let registeredGroups = 0;
  const dbPath = path.join(projectRoot, 'scdata', 'secureclaw.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM sc_groups')
        .get() as { count: number } | undefined;
      if (row) registeredGroups = row.count;
      db.close();
    } catch {
      // 表可能不存在
    }
  }

  // 6. 数据库完整性
  let dbIntegrity = 'not_checked';
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      dbIntegrity = result[0]?.integrity_check === 'ok' ? 'ok' : 'corrupted';
      db.close();
    } catch {
      dbIntegrity = 'error';
    }
  }

  // 判断整体状态
  const status =
    service === 'running' &&
    containerRuntime !== 'none' &&
    credentials !== 'missing' &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CHANNEL_AUTH: channelAuth,
    REGISTERED_GROUPS: registeredGroups,
    DB_INTEGRITY: dbIntegrity,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
