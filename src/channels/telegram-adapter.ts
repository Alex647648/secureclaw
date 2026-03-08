// src/channels/telegram-adapter.ts
// Telegram 通道适配器 — 基于 grammy v1.40
import { Bot, type Context } from 'grammy';
import type { OutboundMessage } from '../core/types';
import type { ChannelAdapter, OnMessageCallback } from './interface';

// ── 配置 ───────────────────────────────────────────────────────

export interface TelegramAdapterConfig {
  botToken: string;
}

// ── 适配器实现 ─────────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = 'telegram';
  private config: TelegramAdapterConfig;
  private bot: Bot | null = null;
  private _connected = false;
  private startPromise: Promise<void> | null = null;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(onMessage: OnMessageCallback): Promise<void> {
    // 防止重复连接 — 先清理旧连接
    if (this.bot || this._connected) {
      await this.disconnect();
    }

    this.bot = new Bot(this.config.botToken);

    // 监听所有文本消息
    this.bot.on('message:text', async (ctx: Context) => {
      const msg = ctx.message;
      if (!msg || !msg.text) return;

      try {
        await onMessage({
          channelType: 'telegram',
          rawPayload: {
            message_id: msg.message_id,
            chat: { id: msg.chat.id, title: (msg.chat as any).title },
            from: msg.from ? {
              id: msg.from.id,
              first_name: msg.from.first_name,
              last_name: msg.from.last_name,
              username: msg.from.username,
            } : undefined,
            text: msg.text,
            reply_to_message: msg.reply_to_message
              ? { message_id: msg.reply_to_message.message_id }
              : undefined,
          },
          receivedAt: Date.now(),
        });
      } catch (err: any) {
        console.error(`[Telegram] Message processing error: ${err.message}`);
      }
    });

    // 错误处理
    this.bot.catch((err) => {
      console.error(`[Telegram] Bot error: ${err.message}`);
    });

    // 等待 onStart 回调确保 _connected 在 connect() 返回前设置
    const startedPromise = new Promise<void>((resolve) => {
      this.startPromise = this.bot!.start({
        onStart: () => {
          this._connected = true;
          console.log('[Telegram] Bot started (long polling)');
          resolve();
        },
      });

      // 捕获 start 异步错误（如 token 无效）
      this.startPromise.catch((err: any) => {
        this._connected = false;
        console.error(`[Telegram] Bot start error: ${err.message}`);
        resolve(); // 错误时也 resolve 避免 connect() 永久阻塞
      });
    });

    await startedPromise;
  }

  async send(msg: OutboundMessage, channelId: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram adapter not connected');
    }

    const chatId = Number(channelId);
    if (!channelId || Number.isNaN(chatId) || chatId === 0) {
      throw new Error(`Invalid Telegram chat ID: "${channelId}"`);
    }

    const options: Record<string, unknown> = {};
    if (msg.replyToId) {
      const replyMsgId = Number(msg.replyToId);
      if (!Number.isNaN(replyMsgId) && replyMsgId > 0) {
        options.reply_parameters = { message_id: replyMsgId };
      }
    }

    await this.bot.api.sendMessage(chatId, msg.content, options);
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      try {
        await this.bot.stop();
      } catch {
        // 忽略停止错误（可能在 start() 完成前调用）
      }
      this.bot = null;
    }
    this._connected = false;
    this.startPromise = null;
  }
}
