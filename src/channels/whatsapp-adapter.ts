// src/channels/whatsapp-adapter.ts
// WhatsApp 通道适配器 — 基于 @whiskeysockets/baileys v7
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import * as fs from 'node:fs';
import type { OutboundMessage } from '../core/types';
import type { ChannelAdapter, OnMessageCallback } from './interface';

// ── 配置 ───────────────────────────────────────────────────────

export interface WhatsAppAdapterConfig {
  /** 认证信息存储目录 */
  authDir: string;
  /** 最大重连次数（默认 10） */
  maxReconnectAttempts?: number;
}

// ── 常量 ───────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 3_000;  // 3 秒
const MAX_RECONNECT_DELAY_MS = 120_000; // 2 分钟

// ── 适配器实现 ─────────────────────────────────────────────────

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelType = 'whatsapp';
  private config: WhatsAppAdapterConfig;
  private socket: WASocket | null = null;
  private _connected = false;
  private onMessage: OnMessageCallback | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isReconnecting = false;
  private maxReconnectAttempts: number;

  constructor(config: WhatsAppAdapterConfig) {
    this.config = config;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(onMessage: OnMessageCallback): Promise<void> {
    // 防止重复连接 — 先清理旧连接
    if (this.socket || this._connected) {
      await this.disconnect();
    }

    this.onMessage = onMessage;

    // 确保认证目录存在，限制为 0o700（仅 owner 可读写）
    fs.mkdirSync(this.config.authDir, { recursive: true, mode: 0o700 });

    await this.initSocket();
  }

  private async initSocket(): Promise<void> {
    // 清理旧 socket（防止重连时泄漏）
    this.cleanupSocket();

    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    // 使用 silent pino logger 替代 undefined as any
    const logger = pino({ level: 'silent' });

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: true,
      generateHighQualityLinkPreview: false,
    });

    // 保存认证信息
    this.socket.ev.on('creds.update', saveCreds);

    // 连接状态更新
    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        this._connected = true;
        this.reconnectAttempts = 0;  // 连接成功重置计数
        console.log('[WhatsApp] Connected successfully');
      }

      if (connection === 'close') {
        this._connected = false;
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

        if (reason === DisconnectReason.loggedOut) {
          console.error('[WhatsApp] Logged out. Delete auth dir and scan QR again.');
          return;
        }

        // 自动重连（非注销原因）
        console.log(`[WhatsApp] Disconnected (reason=${reason}), scheduling reconnect...`);
        this.scheduleReconnect();
      }
    });

    // 监听消息
    this.socket.ev.on('messages.upsert', async ({ messages }) => {
      if (!this.onMessage) return;

      for (const msg of messages) {
        // 跳过自己发的消息
        if (msg.key.fromMe) continue;
        // 跳过状态广播
        if (msg.key.remoteJid === 'status@broadcast') continue;

        try {
          await this.onMessage({
            channelType: 'whatsapp',
            rawPayload: msg,
            receivedAt: Date.now(),
          });
        } catch (err: any) {
          console.error(`[WhatsApp] Message processing error: ${err.message}`);
        }
      }
    });
  }

  /**
   * 清理当前 socket 及其事件监听器。
   */
  private cleanupSocket(): void {
    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.end(undefined);
      } catch {
        // 忽略清理错误
      }
      this.socket = null;
    }
  }

  /**
   * 带指数退避和最大重试次数的重连调度。
   */
  private scheduleReconnect(): void {
    // 防止重复调度或已断开时调度
    if (this.reconnectTimer || this.isReconnecting) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[WhatsApp] Max reconnect attempts (${this.maxReconnectAttempts}) exceeded, giving up.`);
      return;
    }

    // 指数退避: 3s, 6s, 12s, 24s, ... 最大 120s
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    console.log(`[WhatsApp] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      // 如果已经在重连或已调用 disconnect，放弃
      if (this.isReconnecting || !this.onMessage) return;

      this.isReconnecting = true;
      try {
        await this.initSocket();
      } catch (err: any) {
        console.error(`[WhatsApp] Reconnect failed: ${err.message}`);
        this.scheduleReconnect();
      } finally {
        this.isReconnecting = false;
      }
    }, delay);
  }

  async send(msg: OutboundMessage, channelId: string): Promise<void> {
    if (!this.socket || !this._connected) {
      throw new Error('WhatsApp adapter not connected');
    }

    const sendOptions: Record<string, unknown> = {};
    if (msg.replyToId) {
      sendOptions.quoted = {
        key: { remoteJid: channelId, id: msg.replyToId },
        message: {},
      };
    }

    await this.socket.sendMessage(channelId, { text: msg.content }, sendOptions);
  }

  async disconnect(): Promise<void> {
    // 清除重连计时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 清理 socket 及事件监听器
    this.cleanupSocket();

    this._connected = false;
    this.onMessage = null;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
  }
}
