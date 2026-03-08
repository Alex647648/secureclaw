// src/channels/channel-manager.ts
// 通道管理器 — 管理所有通道适配器的生命周期 + 出站消息路由
import type { OutboundMessage } from '../core/types';
import type { SecureClawDB } from '../db/db';
import type { AuditBackend } from '../audit/backend/interface';
import type { MessagePipeline } from '../integration/message-pipeline';
import type { ChannelAdapter, OnMessageCallback } from './interface';
import { generateId } from '../core/utils';

// ── 配置 ───────────────────────────────────────────────────────

export interface ChannelManagerConfig {
  /** 启用的通道列表 */
  adapters: ChannelAdapter[];
}

// ── ChannelManager ────────────────────────────────────────────

export class ChannelManager {
  private adapters: Map<string, ChannelAdapter> = new Map();
  private db: SecureClawDB;
  private audit: AuditBackend;
  private pipeline: MessagePipeline | null = null;

  constructor(
    config: ChannelManagerConfig,
    db: SecureClawDB,
    audit: AuditBackend,
  ) {
    this.db = db;
    this.audit = audit;

    for (const adapter of config.adapters) {
      this.adapters.set(adapter.channelType, adapter);
    }
  }

  /**
   * 设置消息管线。
   * 必须在 connectAll() 之前调用。
   */
  setPipeline(pipeline: MessagePipeline): void {
    this.pipeline = pipeline;
  }

  /**
   * 连接所有适配器。
   * 每个适配器失败不影响其他适配器。
   */
  async connectAll(): Promise<void> {
    if (!this.pipeline) {
      throw new Error('Pipeline must be set before connecting channels');
    }

    const pipelineRef = this.pipeline;

    const onMessage: OnMessageCallback = async (raw) => {
      try {
        await pipelineRef.process(raw);
      } catch (err: any) {
        console.error(`[ChannelManager] Pipeline error: ${err.message}`);
      }
    };

    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.connect(onMessage);
        console.log(`[ChannelManager] ${type} adapter connected`);
      } catch (err: any) {
        console.error(`[ChannelManager] Failed to connect ${type}: ${err.message}`);
        await this.audit.append({
          entryId: generateId(),
          timestamp: Date.now(),
          eventType: 'security_alert',
          actorId: 'channel-manager',
          payload: {
            alert: 'channel_connect_failed',
            channelType: type,
            error: err.message,
          },
        }).catch(() => {});
      }
    }
  }

  /**
   * 发送出站消息。
   * 根据 OutboundMessage.channelType 路由到对应适配器。
   */
  async send(msg: OutboundMessage): Promise<void> {
    // 验证消息内容非空
    if (!msg.content) {
      console.warn('[ChannelManager] Empty message content, skipping send');
      return;
    }

    const adapter = this.adapters.get(msg.channelType);
    if (!adapter) {
      console.warn(`[ChannelManager] No adapter for channel type: ${msg.channelType}`);
      return;
    }

    if (!adapter.connected) {
      console.warn(`[ChannelManager] ${msg.channelType} adapter not connected, skipping send`);
      return;
    }

    // 从数据库查找 group 的 channel_id
    const group = this.db.getGroup(msg.groupId);
    if (!group) {
      console.warn(`[ChannelManager] Group not found: ${msg.groupId}`);
      return;
    }

    // 验证 channel_id 非空
    if (!group.channel_id) {
      console.warn(`[ChannelManager] Group ${msg.groupId} has empty channel_id`);
      return;
    }

    await adapter.send(msg, group.channel_id);
  }

  /**
   * 断开所有适配器。
   */
  async disconnectAll(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
        console.log(`[ChannelManager] ${type} adapter disconnected`);
      } catch (err: any) {
        console.error(`[ChannelManager] Error disconnecting ${type}: ${err.message}`);
      }
    }
  }

  /** 获取指定通道的适配器 */
  getAdapter(channelType: string): ChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  /** 已注册的通道类型列表 */
  get channelTypes(): string[] {
    return Array.from(this.adapters.keys());
  }

  /** 已连接的通道数 */
  get connectedCount(): number {
    let count = 0;
    for (const adapter of this.adapters.values()) {
      if (adapter.connected) count++;
    }
    return count;
  }

  /** 获取已连接通道的 Bot 信息（用于自动设置触发词） */
  getBotInfo(): { id: string; username: string } | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.connected && adapter.botInfo) {
        return adapter.botInfo;
      }
    }
    return undefined;
  }
}
