// src/channels/channel-manager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChannelManager } from './channel-manager';
import { SecureClawDB } from '../db/db';
import { LocalAuditBackend } from '../audit/backend/local-audit';
import { TrustLevel, type OutboundMessage, type RawMessage } from '../core/types';
import type { ChannelAdapter, OnMessageCallback } from './interface';
import type { MessagePipeline, PipelineResult } from '../integration/message-pipeline';

const tmpDir = path.join(os.tmpdir(), 'secureclaw-chman-test-' + Date.now());
let db: SecureClawDB;
let audit: LocalAuditBackend;

// ── Mock Adapter ─────────────────────────────────────────────────

function createMockAdapter(
  channelType: string,
  overrides?: Partial<ChannelAdapter>,
): ChannelAdapter & { sentMessages: Array<{ msg: OutboundMessage; channelId: string }>; receivedCallback: OnMessageCallback | null } {
  let _connected = false;
  let _callback: OnMessageCallback | null = null;
  const sentMessages: Array<{ msg: OutboundMessage; channelId: string }> = [];

  const adapter: any = {
    channelType,
    get connected() { return _connected; },
    async connect(onMessage: OnMessageCallback) {
      _callback = onMessage;
      _connected = true;
    },
    async send(msg: OutboundMessage, channelId: string) {
      sentMessages.push({ msg, channelId });
    },
    async disconnect() {
      _connected = false;
      _callback = null;
    },
    sentMessages,
    get receivedCallback() { return _callback; },
    ...overrides,
  };

  return adapter;
}

// ── Mock Pipeline ────────────────────────────────────────────────

function createMockPipeline(
  processedResults?: PipelineResult[],
): MessagePipeline & { processedRaws: RawMessage[] } {
  const processedRaws: RawMessage[] = [];
  let callIdx = 0;

  return {
    processedRaws,
    async process(raw: RawMessage): Promise<PipelineResult> {
      processedRaws.push(raw);
      if (processedResults && callIdx < processedResults.length) {
        return processedResults[callIdx++];
      }
      return { accepted: true, taskId: 'mock-task-1' };
    },
  };
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  audit = new LocalAuditBackend(db.getDatabase());

  db.createGroup({
    id: 'wa-group',
    name: 'WhatsApp Group',
    channel_type: 'whatsapp',
    channel_id: '12345@g.us',
    trust_level: TrustLevel.TRUSTED,
    network_policy: 'claude_only',
    is_admin_group: 0,
  });

  db.createGroup({
    id: 'tg-group',
    name: 'Telegram Group',
    channel_type: 'telegram',
    channel_id: '-1001234',
    trust_level: TrustLevel.TRUSTED,
    network_policy: 'claude_only',
    is_admin_group: 0,
  });

  db.createGroup({
    id: 'slack-group',
    name: 'Slack Group',
    channel_type: 'slack',
    channel_id: 'C01ABC',
    trust_level: TrustLevel.TRUSTED,
    network_policy: 'claude_only',
    is_admin_group: 0,
  });

  db.createGroup({
    id: 'dc-group',
    name: 'Discord Group',
    channel_type: 'discord',
    channel_id: 'ch-999',
    trust_level: TrustLevel.TRUSTED,
    network_policy: 'claude_only',
    is_admin_group: 0,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────

describe('ChannelManager', () => {
  it('should register adapters by channelType', () => {
    const wa = createMockAdapter('whatsapp');
    const tg = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [wa, tg] }, db, audit);

    expect(manager.channelTypes).toEqual(['whatsapp', 'telegram']);
    expect(manager.getAdapter('whatsapp')).toBe(wa);
    expect(manager.getAdapter('telegram')).toBe(tg);
    expect(manager.getAdapter('slack')).toBeUndefined();
  });

  it('should throw if pipeline not set before connect', async () => {
    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);

    await expect(manager.connectAll()).rejects.toThrow('Pipeline must be set');
  });

  it('should connect all adapters and set pipeline callback', async () => {
    const wa = createMockAdapter('whatsapp');
    const tg = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [wa, tg] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    expect(wa.connected).toBe(true);
    expect(tg.connected).toBe(true);
    expect(manager.connectedCount).toBe(2);
  });

  it('should route inbound messages to pipeline', async () => {
    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    // 模拟收到 WhatsApp 消息
    const rawMsg: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: {
        key: { remoteJid: '12345@g.us', participant: 'user@s.whatsapp.net', id: 'msg-1' },
        pushName: 'Alice',
        message: { conversation: '@Andy hello' },
      },
      receivedAt: Date.now(),
    };
    await wa.receivedCallback!(rawMsg);

    expect(pipeline.processedRaws).toHaveLength(1);
    expect(pipeline.processedRaws[0]).toBe(rawMsg);
  });

  it('should send outbound messages to correct adapter', async () => {
    const wa = createMockAdapter('whatsapp');
    const tg = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [wa, tg] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    const msg: OutboundMessage = {
      groupId: 'wa-group',
      content: 'Hello from SecureClaw',
      channelType: 'whatsapp',
    };
    await manager.send(msg);

    expect(wa.sentMessages).toHaveLength(1);
    expect(wa.sentMessages[0].channelId).toBe('12345@g.us');
    expect(wa.sentMessages[0].msg.content).toBe('Hello from SecureClaw');
    expect(tg.sentMessages).toHaveLength(0);
  });

  it('should send to telegram adapter correctly', async () => {
    const tg = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [tg] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'tg-group',
      content: 'Telegram test',
      channelType: 'telegram',
    });

    expect(tg.sentMessages).toHaveLength(1);
    expect(tg.sentMessages[0].channelId).toBe('-1001234');
  });

  it('should send to slack adapter correctly', async () => {
    const slack = createMockAdapter('slack');
    const manager = new ChannelManager({ adapters: [slack] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'slack-group',
      content: 'Slack test',
      channelType: 'slack',
    });

    expect(slack.sentMessages).toHaveLength(1);
    expect(slack.sentMessages[0].channelId).toBe('C01ABC');
  });

  it('should send to discord adapter correctly', async () => {
    const discord = createMockAdapter('discord');
    const manager = new ChannelManager({ adapters: [discord] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'dc-group',
      content: 'Discord test',
      channelType: 'discord',
    });

    expect(discord.sentMessages).toHaveLength(1);
    expect(discord.sentMessages[0].channelId).toBe('ch-999');
  });

  it('should skip send when adapter not registered', async () => {
    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    // 尝试发送到未注册的 telegram
    await manager.send({
      groupId: 'tg-group',
      content: 'test',
      channelType: 'telegram',
    });

    // 不报错，静默跳过
    expect(wa.sentMessages).toHaveLength(0);
  });

  it('should skip send when adapter not connected', async () => {
    const wa = createMockAdapter('whatsapp', {
      async connect() { /* 不设 connected */ },
      get connected() { return false; },
    });
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'wa-group',
      content: 'test',
      channelType: 'whatsapp',
    });

    expect(wa.sentMessages).toHaveLength(0);
  });

  it('should skip send when group not found', async () => {
    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'nonexistent-group',
      content: 'test',
      channelType: 'whatsapp',
    });

    expect(wa.sentMessages).toHaveLength(0);
  });

  it('should include replyToId in outbound messages', async () => {
    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'wa-group',
      content: 'Reply test',
      channelType: 'whatsapp',
      replyToId: 'original-msg-id',
    });

    expect(wa.sentMessages[0].msg.replyToId).toBe('original-msg-id');
  });

  it('should disconnect all adapters', async () => {
    const wa = createMockAdapter('whatsapp');
    const tg = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [wa, tg] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();
    expect(manager.connectedCount).toBe(2);

    await manager.disconnectAll();
    expect(wa.connected).toBe(false);
    expect(tg.connected).toBe(false);
    expect(manager.connectedCount).toBe(0);
  });

  it('should continue connecting other adapters when one fails', async () => {
    const failAdapter = createMockAdapter('whatsapp', {
      async connect() { throw new Error('Auth failed'); },
    });
    const tg = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [failAdapter, tg] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    expect(tg.connected).toBe(true);
    expect(manager.connectedCount).toBe(1);

    // 应有审计记录
    const entries = await audit.query({ eventType: 'security_alert', limit: 10 });
    const connectError = entries.find(e =>
      (e.payload as any).alert === 'channel_connect_failed'
    );
    expect(connectError).toBeDefined();
    expect((connectError!.payload as any).channelType).toBe('whatsapp');
  });

  it('should handle empty adapter list', async () => {
    const manager = new ChannelManager({ adapters: [] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    expect(manager.connectedCount).toBe(0);
    expect(manager.channelTypes).toEqual([]);
  });

  it('should handle pipeline errors in onMessage callback', async () => {
    const wa = createMockAdapter('whatsapp');
    const errorPipeline: MessagePipeline = {
      async process() { throw new Error('Pipeline crash'); },
    };
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);

    manager.setPipeline(errorPipeline);
    await manager.connectAll();

    // 模拟收到消息 — 不应抛出
    const rawMsg: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: {
        key: { remoteJid: '12345@g.us', id: 'msg-1' },
        message: { conversation: 'test' },
      },
      receivedAt: Date.now(),
    };
    await expect(wa.receivedCallback!(rawMsg)).resolves.toBeUndefined();
  });

  it('should route multiple messages to correct adapters', async () => {
    const wa = createMockAdapter('whatsapp');
    const tg = createMockAdapter('telegram');
    const slack = createMockAdapter('slack');
    const manager = new ChannelManager({ adapters: [wa, tg, slack] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({ groupId: 'wa-group', content: 'msg1', channelType: 'whatsapp' });
    await manager.send({ groupId: 'tg-group', content: 'msg2', channelType: 'telegram' });
    await manager.send({ groupId: 'slack-group', content: 'msg3', channelType: 'slack' });

    expect(wa.sentMessages).toHaveLength(1);
    expect(tg.sentMessages).toHaveLength(1);
    expect(slack.sentMessages).toHaveLength(1);
    expect(wa.sentMessages[0].msg.content).toBe('msg1');
    expect(tg.sentMessages[0].msg.content).toBe('msg2');
    expect(slack.sentMessages[0].msg.content).toBe('msg3');
  });

  // ── BUG-FIX 回归测试 ────────────────────────────────────────

  it('should skip send when content is empty', async () => {
    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'wa-group',
      content: '',
      channelType: 'whatsapp',
    });

    expect(wa.sentMessages).toHaveLength(0);
  });

  it('should skip send when group has empty channel_id', async () => {
    // 创建一个 channel_id 为空的 group
    db.createGroup({
      id: 'empty-ch-group',
      name: 'Empty Channel',
      channel_type: 'whatsapp',
      channel_id: '',
      trust_level: TrustLevel.TRUSTED,
      network_policy: 'claude_only',
      is_admin_group: 0,
    });

    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.send({
      groupId: 'empty-ch-group',
      content: 'test',
      channelType: 'whatsapp',
    });

    expect(wa.sentMessages).toHaveLength(0);
  });

  it('should propagate adapter.send() errors to caller', async () => {
    const failSend = createMockAdapter('whatsapp', {
      async send() { throw new Error('Network timeout'); },
    });
    const manager = new ChannelManager({ adapters: [failSend] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await expect(manager.send({
      groupId: 'wa-group',
      content: 'test',
      channelType: 'whatsapp',
    })).rejects.toThrow('Network timeout');
  });

  it('should complete without throwing when all adapters fail in connectAll()', async () => {
    const fail1 = createMockAdapter('whatsapp', {
      async connect() { throw new Error('WA auth failed'); },
    });
    const fail2 = createMockAdapter('telegram', {
      async connect() { throw new Error('TG token invalid'); },
    });
    const fail3 = createMockAdapter('slack', {
      async connect() { throw new Error('Slack timeout'); },
    });
    const manager = new ChannelManager({ adapters: [fail1, fail2, fail3] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll(); // 不应抛出

    expect(manager.connectedCount).toBe(0);

    // 应有 3 条审计记录
    const entries = await audit.query({ eventType: 'security_alert', limit: 10 });
    const connectErrors = entries.filter(e =>
      (e.payload as any).alert === 'channel_connect_failed'
    );
    expect(connectErrors).toHaveLength(3);
  });

  it('should continue disconnecting when one adapter throws in disconnectAll()', async () => {
    let disconnectCalls = 0;
    const failDisc = createMockAdapter('whatsapp', {
      async disconnect() {
        disconnectCalls++;
        throw new Error('Disconnect crash');
      },
    });
    const goodDisc = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [failDisc, goodDisc] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.disconnectAll(); // 不应抛出

    expect(disconnectCalls).toBe(1);
    expect(goodDisc.connected).toBe(false);
  });

  it('should silently handle pipeline rejection (accepted=false) in onMessage', async () => {
    const wa = createMockAdapter('whatsapp');
    const rejectPipeline = createMockPipeline([
      { accepted: false, reason: 'trigger_word_not_matched' },
    ]);
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);

    manager.setPipeline(rejectPipeline);
    await manager.connectAll();

    const rawMsg: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: { key: { remoteJid: '12345@g.us', id: 'x' }, message: { conversation: 'hello' } },
      receivedAt: Date.now(),
    };
    await expect(wa.receivedCallback!(rawMsg)).resolves.toBeUndefined();
    expect(rejectPipeline.processedRaws).toHaveLength(1);
  });

  it('should handle concurrent send() calls without interference', async () => {
    const wa = createMockAdapter('whatsapp');
    const tg = createMockAdapter('telegram');
    const manager = new ChannelManager({ adapters: [wa, tg] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    // 并发发送 10 条消息
    const sends = [];
    for (let i = 0; i < 5; i++) {
      sends.push(manager.send({ groupId: 'wa-group', content: `wa-${i}`, channelType: 'whatsapp' }));
      sends.push(manager.send({ groupId: 'tg-group', content: `tg-${i}`, channelType: 'telegram' }));
    }
    await Promise.all(sends);

    expect(wa.sentMessages).toHaveLength(5);
    expect(tg.sentMessages).toHaveLength(5);
  });

  it('should keep last adapter when duplicate channelType registered', () => {
    const wa1 = createMockAdapter('whatsapp');
    const wa2 = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa1, wa2] }, db, audit);

    expect(manager.getAdapter('whatsapp')).toBe(wa2);
    expect(manager.channelTypes).toEqual(['whatsapp']);
  });

  it('should handle connectAll() called twice without leaking', async () => {
    let connectCount = 0;
    const wa = createMockAdapter('whatsapp', {
      async connect(cb: OnMessageCallback) { connectCount++; },
      get connected() { return true; },
    });
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();
    await manager.connectAll(); // 第二次

    expect(connectCount).toBe(2); // 被调用两次，适配器自己应处理重复
  });

  it('should handle disconnectAll() called twice safely', async () => {
    const wa = createMockAdapter('whatsapp');
    const manager = new ChannelManager({ adapters: [wa] }, db, audit);
    const pipeline = createMockPipeline();

    manager.setPipeline(pipeline);
    await manager.connectAll();

    await manager.disconnectAll();
    await manager.disconnectAll(); // 第二次不应抛出

    expect(wa.connected).toBe(false);
  });
});
