// src/channels/slack-adapter.ts
// Slack 通道适配器 — 基于 @slack/bolt v4.6（Socket Mode）
import { App } from '@slack/bolt';
import type { OutboundMessage } from '../core/types';
import type { ChannelAdapter, OnMessageCallback } from './interface';

// ── 配置 ───────────────────────────────────────────────────────

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
}

// ── 适配器实现 ─────────────────────────────────────────────────

export class SlackAdapter implements ChannelAdapter {
  readonly channelType = 'slack';
  private config: SlackAdapterConfig;
  private app: App | null = null;
  private _connected = false;

  constructor(config: SlackAdapterConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(onMessage: OnMessageCallback): Promise<void> {
    // 防止重复连接 — 先清理旧连接
    if (this.app || this._connected) {
      await this.disconnect();
    }

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
    });

    // 监听所有文本消息
    this.app.message(async ({ message }) => {
      // 过滤子类型消息（编辑、删除等）
      if ((message as any).subtype) return;

      const m = message as any;
      if (!m.text) return;

      try {
        await onMessage({
          channelType: 'slack',
          rawPayload: {
            channel: m.channel,
            user: m.user,
            text: m.text,
            ts: m.ts,
            thread_ts: m.thread_ts,
          },
          receivedAt: Date.now(),
        });
      } catch (err: any) {
        console.error(`[Slack] Message processing error: ${err.message}`);
      }
    });

    await this.app.start();
    this._connected = true;
    console.log('[Slack] App started (Socket Mode)');
  }

  async send(msg: OutboundMessage, channelId: string): Promise<void> {
    if (!this.app) {
      throw new Error('Slack adapter not connected');
    }

    const postArgs: Record<string, unknown> = {
      channel: channelId,
      text: msg.content,
    };

    // 在同一线程回复
    if (msg.replyToId) {
      postArgs.thread_ts = msg.replyToId;
    }

    await this.app.client.chat.postMessage(postArgs as any);
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // 忽略停止错误
      }
      this.app = null;
    }
    this._connected = false;
  }
}
