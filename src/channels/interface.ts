// src/channels/interface.ts
// 通道适配器抽象接口
import type { RawMessage, OutboundMessage } from '../core/types';

// ── 消息回调 ───────────────────────────────────────────────────────

export type OnMessageCallback = (raw: RawMessage) => Promise<void>;

// ── 通道适配器接口 ─────────────────────────────────────────────────

export interface ChannelAdapter {
  /** 通道类型标识 */
  readonly channelType: string;

  /**
   * 连接到通道平台。
   * 连接成功后，收到的消息通过 onMessage 回调传递。
   */
  connect(onMessage: OnMessageCallback): Promise<void>;

  /**
   * 发送出站消息到指定群组。
   * @param msg 出站消息（包含 groupId、content、replyToId）
   * @param channelId 通道平台的群组 ID（如 JID、chat.id 等）
   */
  send(msg: OutboundMessage, channelId: string): Promise<void>;

  /**
   * 断开连接并清理资源。
   */
  disconnect(): Promise<void>;

  /** 是否已连接 */
  readonly connected: boolean;

  /** Bot 信息（连接后可用，仅部分通道支持） */
  readonly botInfo?: { id: string; username: string };
}
