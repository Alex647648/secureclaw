// src/channels/adapters.test.ts
// 通道适配器接口契约测试 — 使用模拟实现验证 ChannelAdapter 接口行为
import { describe, it, expect } from 'vitest';
import type { ChannelAdapter, OnMessageCallback } from './interface';
import type { OutboundMessage, RawMessage } from '../core/types';

// ── 辅助：可配置的测试适配器 ────────────────────────────────────

class TestAdapter implements ChannelAdapter {
  readonly channelType: string;
  private _connected = false;
  private onMessage: OnMessageCallback | null = null;
  sentMessages: Array<{ msg: OutboundMessage; channelId: string }> = [];
  connectError: Error | null = null;
  sendError: Error | null = null;

  constructor(channelType: string) {
    this.channelType = channelType;
  }

  get connected(): boolean { return this._connected; }

  async connect(onMessage: OnMessageCallback): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.onMessage = onMessage;
    this._connected = true;
  }

  async send(msg: OutboundMessage, channelId: string): Promise<void> {
    if (this.sendError) throw this.sendError;
    if (!this._connected) throw new Error('Not connected');
    this.sentMessages.push({ msg, channelId });
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.onMessage = null;
  }

  // 测试辅助：模拟收到消息
  async simulateMessage(raw: RawMessage): Promise<void> {
    if (this.onMessage) {
      await this.onMessage(raw);
    }
  }
}

// ── 接口契约测试 ────────────────────────────────────────────────

describe('ChannelAdapter interface contract', () => {
  it('should start disconnected', () => {
    const adapter = new TestAdapter('test');
    expect(adapter.connected).toBe(false);
  });

  it('should be connected after connect()', async () => {
    const adapter = new TestAdapter('test');
    await adapter.connect(async () => {});
    expect(adapter.connected).toBe(true);
  });

  it('should be disconnected after disconnect()', async () => {
    const adapter = new TestAdapter('test');
    await adapter.connect(async () => {});
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
  });

  it('should deliver messages via onMessage callback', async () => {
    const adapter = new TestAdapter('whatsapp');
    const received: RawMessage[] = [];

    await adapter.connect(async (raw) => { received.push(raw); });

    const testMsg: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: { key: { remoteJid: '123@g.us', id: 'x' }, message: { conversation: 'hi' } },
      receivedAt: Date.now(),
    };
    await adapter.simulateMessage(testMsg);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(testMsg);
  });

  it('should send messages when connected', async () => {
    const adapter = new TestAdapter('telegram');
    await adapter.connect(async () => {});

    const msg: OutboundMessage = {
      groupId: 'grp-1',
      content: 'Hello',
      channelType: 'telegram',
    };
    await adapter.send(msg, '-1001234');

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0].channelId).toBe('-1001234');
  });

  it('should throw when sending while disconnected', async () => {
    const adapter = new TestAdapter('slack');
    const msg: OutboundMessage = { groupId: 'g', content: 'test', channelType: 'slack' };

    await expect(adapter.send(msg, 'C01')).rejects.toThrow('Not connected');
  });

  it('should propagate connect errors', async () => {
    const adapter = new TestAdapter('discord');
    adapter.connectError = new Error('Auth failed');

    await expect(adapter.connect(async () => {})).rejects.toThrow('Auth failed');
    expect(adapter.connected).toBe(false);
  });

  it('should propagate send errors', async () => {
    const adapter = new TestAdapter('whatsapp');
    await adapter.connect(async () => {});
    adapter.sendError = new Error('Network error');

    const msg: OutboundMessage = { groupId: 'g', content: 'test', channelType: 'whatsapp' };
    await expect(adapter.send(msg, '123@g.us')).rejects.toThrow('Network error');
  });

  it('should handle replyToId in outbound messages', async () => {
    const adapter = new TestAdapter('whatsapp');
    await adapter.connect(async () => {});

    const msg: OutboundMessage = {
      groupId: 'g',
      content: 'Reply',
      channelType: 'whatsapp',
      replyToId: 'orig-msg-123',
    };
    await adapter.send(msg, '123@g.us');

    expect(adapter.sentMessages[0].msg.replyToId).toBe('orig-msg-123');
  });

  it('should expose channelType as readonly', () => {
    const wa = new TestAdapter('whatsapp');
    const tg = new TestAdapter('telegram');
    const slack = new TestAdapter('slack');
    const dc = new TestAdapter('discord');

    expect(wa.channelType).toBe('whatsapp');
    expect(tg.channelType).toBe('telegram');
    expect(slack.channelType).toBe('slack');
    expect(dc.channelType).toBe('discord');
  });

  it('should not deliver messages after disconnect', async () => {
    const adapter = new TestAdapter('test');
    const received: RawMessage[] = [];

    await adapter.connect(async (raw) => { received.push(raw); });
    await adapter.disconnect();

    await adapter.simulateMessage({
      channelType: 'test' as any,
      rawPayload: {},
      receivedAt: Date.now(),
    });

    // disconnect 清除了 callback，消息不应被投递
    expect(received).toHaveLength(0);
  });

  it('should handle multiple messages in sequence', async () => {
    const adapter = new TestAdapter('whatsapp');
    const received: RawMessage[] = [];

    await adapter.connect(async (raw) => { received.push(raw); });

    for (let i = 0; i < 5; i++) {
      await adapter.simulateMessage({
        channelType: 'whatsapp',
        rawPayload: { key: { remoteJid: '123@g.us', id: `msg-${i}` }, message: { conversation: `msg ${i}` } },
        receivedAt: Date.now(),
      });
    }

    expect(received).toHaveLength(5);
  });

  it('should allow reconnect after disconnect', async () => {
    const adapter = new TestAdapter('test');
    const received1: RawMessage[] = [];
    const received2: RawMessage[] = [];

    await adapter.connect(async (raw) => { received1.push(raw); });
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);

    await adapter.connect(async (raw) => { received2.push(raw); });
    expect(adapter.connected).toBe(true);

    await adapter.simulateMessage({
      channelType: 'test' as any,
      rawPayload: {},
      receivedAt: Date.now(),
    });

    expect(received1).toHaveLength(0);
    expect(received2).toHaveLength(1);
  });

  // ── BUG-FIX 回归：双重连接 / 双重断开 ─────────────────────

  it('should handle double connect() safely by disconnecting first', async () => {
    const adapter = new TestAdapter('test');
    const cb1: RawMessage[] = [];
    const cb2: RawMessage[] = [];

    await adapter.connect(async (raw) => { cb1.push(raw); });
    expect(adapter.connected).toBe(true);

    // 再次 connect — 应不抛出（安全覆盖）
    await adapter.connect(async (raw) => { cb2.push(raw); });
    expect(adapter.connected).toBe(true);

    await adapter.simulateMessage({
      channelType: 'test' as any,
      rawPayload: {},
      receivedAt: Date.now(),
    });

    // 第二次连接的回调生效
    expect(cb2).toHaveLength(1);
  });

  it('should handle double disconnect() without throwing', async () => {
    const adapter = new TestAdapter('test');
    await adapter.connect(async () => {});

    await adapter.disconnect();
    expect(adapter.connected).toBe(false);

    // 再次 disconnect — 不应抛出
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
  });

  it('should handle disconnect() when never connected', async () => {
    const adapter = new TestAdapter('test');
    expect(adapter.connected).toBe(false);

    // 从未连接就断开 — 不应抛出
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
  });

  it('should handle send with empty replyToId gracefully', async () => {
    const adapter = new TestAdapter('whatsapp');
    await adapter.connect(async () => {});

    const msg: OutboundMessage = {
      groupId: 'g',
      content: 'test',
      channelType: 'whatsapp',
      replyToId: undefined,
    };
    await adapter.send(msg, '123@g.us');

    expect(adapter.sentMessages[0].msg.replyToId).toBeUndefined();
  });

  it('should handle send with very long content', async () => {
    const adapter = new TestAdapter('telegram');
    await adapter.connect(async () => {});

    const longContent = 'A'.repeat(100_000);
    const msg: OutboundMessage = {
      groupId: 'g',
      content: longContent,
      channelType: 'telegram',
    };
    await adapter.send(msg, '-1001234');

    expect(adapter.sentMessages[0].msg.content).toHaveLength(100_000);
  });
});
