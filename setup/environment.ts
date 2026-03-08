/**
 * 步骤：environment — 检查 Node≥20、npm、容器运行时、已有配置
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  commandExists,
  getNodeMajorVersion,
  getNodeVersion,
  getPlatform,
  isHeadless,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();

  // Node 版本检查
  const nodeVersion = getNodeVersion() || 'not_found';
  const nodeMajor = getNodeMajorVersion();
  const nodeOk = nodeMajor !== null && nodeMajor >= 20;

  // npm 检查
  const npmOk = commandExists('npm');

  // Apple Container 检查
  let appleContainer: 'installed' | 'not_found' = 'not_found';
  if (commandExists('container')) {
    appleContainer = 'installed';
  }

  // Docker 检查
  let docker: 'running' | 'installed_not_running' | 'not_found' = 'not_found';
  if (commandExists('docker')) {
    try {
      const { execSync } = await import('node:child_process');
      execSync('docker info', { stdio: 'ignore' });
      docker = 'running';
    } catch {
      docker = 'installed_not_running';
    }
  }

  // 已有配置检查
  const hasEnv = fs.existsSync(path.join(projectRoot, 'secureclaw.env'));
  const hasYaml = fs.existsSync(path.join(projectRoot, 'secureclaw.yaml'));

  // WhatsApp 认证检查
  const authDir = path.join(projectRoot, 'scdata', 'whatsapp-auth');
  const hasAuth = fs.existsSync(authDir) &&
    fs.readdirSync(authDir).length > 0;

  // 已注册群组检查（直接用 better-sqlite3）
  let hasRegisteredGroups = false;
  const dbPath = path.join(projectRoot, 'scdata', 'secureclaw.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM sc_groups')
        .get() as { count: number } | undefined;
      if (row && row.count > 0) hasRegisteredGroups = true;
      db.close();
    } catch {
      // 表可能不存在
    }
  }

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    NODE_VERSION: nodeVersion,
    NODE_OK: nodeOk,
    NPM_OK: npmOk,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    HAS_ENV: hasEnv,
    HAS_YAML: hasYaml,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
