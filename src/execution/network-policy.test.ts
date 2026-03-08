// src/execution/network-policy.test.ts
import { describe, it, expect } from 'vitest';
import { getNetworkArgs, createFilterProxy, PROXY_CONFIG } from './network-policy';
import type { NetworkPolicy } from '../core/types';

describe('getNetworkArgs', () => {
  it('isolated: should add --network none', () => {
    const result = getNetworkArgs({ preset: 'isolated' }, 'apple');
    expect(result.containerArgs).toEqual(['--network', 'none']);
    expect(result.envArgs).toHaveLength(0);
  });

  it('claude_only (apple): should set HTTPS_PROXY with host.containers.internal', () => {
    const result = getNetworkArgs({ preset: 'claude_only' }, 'apple');
    expect(result.containerArgs).toHaveLength(0);
    expect(result.envArgs).toHaveLength(1);
    expect(result.envArgs[0]).toContain('host.containers.internal:18080');
  });

  it('claude_only (docker): should set HTTPS_PROXY with host-gateway', () => {
    const result = getNetworkArgs({ preset: 'claude_only' }, 'docker');
    expect(result.envArgs[0]).toContain('host-gateway:18080');
  });

  it('trusted: should have no restrictions', () => {
    const result = getNetworkArgs({ preset: 'trusted' }, 'apple');
    expect(result.containerArgs).toHaveLength(0);
    expect(result.envArgs).toHaveLength(0);
  });

  it('open: should have no restrictions', () => {
    const result = getNetworkArgs({ preset: 'open' }, 'docker');
    expect(result.containerArgs).toHaveLength(0);
    expect(result.envArgs).toHaveLength(0);
  });

  it('unknown preset: should default to isolated', () => {
    const result = getNetworkArgs({ preset: 'unknown' as any }, 'apple');
    expect(result.containerArgs).toEqual(['--network', 'none']);
  });
});

describe('createFilterProxy', () => {
  it('should create an HTTP server', () => {
    const server = createFilterProxy();
    expect(server).toBeDefined();
    expect(typeof server.listen).toBe('function');
    // 不实际启动，避免端口冲突
  });

  it('should expose correct proxy config', () => {
    expect(PROXY_CONFIG.ALLOWED_HOST).toBe('api.anthropic.com');
    expect(PROXY_CONFIG.ALLOWED_PORT).toBe(443);
    expect(PROXY_CONFIG.PROXY_PORT).toBe(18080);
  });

  it('should set maxConnections limit', () => {
    const server = createFilterProxy();
    expect(server.maxConnections).toBe(256);
  });
});
