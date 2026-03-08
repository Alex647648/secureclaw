// src/channels/discord-adapter.ts
// Discord 通道适配器 — 基于 discord.js v14
import { Client, GatewayIntentBits, DiscordAPIError, type TextChannel } from 'discord.js';
import type { OutboundMessage } from '../core/types';
import type { ChannelAdapter, OnMessageCallback } from './interface';

// ── 配置 ───────────────────────────────────────────────────────

export interface DiscordAdapterConfig {
  botToken: string;
}

// ── 消息分段 ────────────────────────────────────────────────────

/**
 * 将超长消息按段落边界分割，每段不超过 maxLen 字符。
 */
function splitMessage(content: string, maxLen: number): string[] {
  if (content.length <= maxLen) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // 优先在换行符处截断
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) {
      // 没有换行符，在空格处截断
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt <= 0) {
      // 无合适断点，强制截断
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ── 适配器实现 ─────────────────────────────────────────────────

export class DiscordAdapter implements ChannelAdapter {
  readonly channelType = 'discord';
  private config: DiscordAdapterConfig;
  private client: Client | null = null;
  private _connected = false;
  private _botInfo: { id: string; username: string } | undefined;

  constructor(config: DiscordAdapterConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Bot 信息（连接后可用） */
  get botInfo(): { id: string; username: string } | undefined {
    return this._botInfo;
  }

  async connect(onMessage: OnMessageCallback): Promise<void> {
    // 防止重复连接 — 先清理旧连接
    if (this.client || this._connected) {
      await this.disconnect();
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // 等待 ready 事件确保 _connected 在 connect() 返回前设置
    const readyPromise = new Promise<void>((resolve) => {
      this.client!.on('ready', () => {
        this._connected = true;
        const user = this.client?.user;
        if (user) {
          this._botInfo = { id: user.id, username: user.username };
        }
        console.log(`[Discord] Bot ready as ${user?.tag}`);
        resolve();
      });
    });

    this.client.on('messageCreate', async (message) => {
      // 跳过 Bot 自身消息
      if (message.author.bot) return;

      // 将 Discord 原生提及 <@BOT_ID> 替换为 @BotUsername 格式
      // 使得触发词匹配逻辑可以统一处理
      let content = message.content;
      if (this._botInfo) {
        const mentionPattern = `<@${this._botInfo.id}>`;
        if (content.includes(mentionPattern)) {
          content = content.replace(mentionPattern, `@${this._botInfo.username}`);
        }
      }

      try {
        await onMessage({
          channelType: 'discord',
          rawPayload: {
            id: message.id,
            channel_id: message.channelId,
            author: {
              id: message.author.id,
              username: message.author.username,
            },
            content,
            message_reference: message.reference
              ? { message_id: message.reference.messageId ?? '' }
              : undefined,
          },
          receivedAt: Date.now(),
        });
      } catch (err: any) {
        console.error(`[Discord] Message processing error: ${err.message}`);
      }
    });

    await this.client.login(this.config.botToken);
    await readyPromise;
  }

  async send(msg: OutboundMessage, channelId: string): Promise<void> {
    if (!this.client || !this._connected) {
      throw new Error('Discord adapter not connected');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error('Discord channel not found or not text-based');
    }

    const textChannel = channel as TextChannel;

    // Discord 单条消息限制 2000 字符，超出时分段发送
    const chunks = splitMessage(msg.content, 2000);

    if (msg.replyToId) {
      try {
        const originalMsg = await textChannel.messages.fetch(msg.replyToId);
        // 第一段作为回复，后续段作为普通消息
        await originalMsg.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await textChannel.send(chunks[i]);
        }
        return;
      } catch (err: unknown) {
        // 仅对"消息不存在"(10008)降级为普通发送，其他错误向上传播
        if (err instanceof DiscordAPIError && err.code === 10008) {
          console.warn(`[Discord] Original message ${msg.replyToId} not found, sending without reply`);
        } else {
          throw err;
        }
      }
    }

    for (const chunk of chunks) {
      await textChannel.send(chunk);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.destroy();
      this.client = null;
    }
    this._connected = false;
  }
}
