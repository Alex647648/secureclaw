/**
 * 跨平台检测工具 — OS / WSL / Node 版本 / 命令存在性 / 服务管理器
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// ── 类型定义 ────────────────────────────────────────────────────

export type Platform = 'macos' | 'linux' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'none';

// ── 平台检测 ────────────────────────────────────────────────────

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  return false;
}

// ── systemd 检测 ────────────────────────────────────────────────

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

// ── 服务管理器 ──────────────────────────────────────────────────

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
    return 'none';
  }
  return 'none';
}

// ── Node 检测 ───────────────────────────────────────────────────

export function getNodePath(): string {
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}

// ── 命令检测 ────────────────────────────────────────────────────

export function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── 浏览器打开（WSL 兼容）──────────────────────────────────────

export function openBrowser(url: string): boolean {
  try {
    const platform = getPlatform();
    if (platform === 'macos') {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
    if (platform === 'linux') {
      if (commandExists('xdg-open')) {
        execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      if (isWSL() && commandExists('wslview')) {
        execSync(`wslview ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      if (isWSL()) {
        try {
          execSync(`cmd.exe /c start "" ${JSON.stringify(url)}`, { stdio: 'ignore' });
          return true;
        } catch {
          // cmd.exe 不可用
        }
      }
    }
  } catch {
    // 打开失败
  }
  return false;
}
