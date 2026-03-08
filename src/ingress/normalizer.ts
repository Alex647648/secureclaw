// src/ingress/normalizer.ts
// 消息标准化 — 触发词过滤 + RawMessage → NormalizedMessage 转换
import {
  type RawMessage,
  type NormalizedMessage,
} from '../core/types';
import { generateId } from '../core/utils';

// ── 触发词检测 ─────────────────────────────────────────────────

/**
 * 判断消息是否应被处理。
 * - triggerWord 为空 → 处理所有消息
 * - content 以 triggerWord 开头 → 处理
 * - 否则 → 静默忽略（不写审计、不入队列）
 */
export function shouldProcess(content: string, triggerWord: string): boolean {
  if (!triggerWord) return true;
  return content.trimStart().startsWith(triggerWord);
}

/**
 * 从消息内容中移除触发词前缀并 trim。
 * 如果触发词为空或不匹配，原样返回。
 */
export function stripTriggerWord(content: string, triggerWord: string): string {
  if (!triggerWord) return content.trim();
  const trimmed = content.trimStart();
  if (trimmed.startsWith(triggerWord)) {
    return trimmed.slice(triggerWord.length).trim();
  }
  return content.trim();
}

// ── 标准化接口 ─────────────────────────────────────────────────

/**
 * WhatsApp 原始消息结构（baileys 格式精简版）
 */
export interface WhatsAppPayload {
  key: {
    remoteJid: string;
    participant?: string;
    id: string;
  };
  pushName?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: {
      text: string;
      contextInfo?: {
        stanzaId?: string;
      };
    };
  };
}

/**
 * Telegram 原始消息结构精简版
 */
export interface TelegramPayload {
  message_id: number;
  chat: { id: number; title?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  reply_to_message?: { message_id: number };
}

/**
 * Slack 原始消息结构精简版
 */
export interface SlackPayload {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

/**
 * Discord 原始消息结构精简版
 */
export interface DiscordPayload {
  id: string;
  channel_id: string;
  author: { id: string; username: string };
  content: string;
  message_reference?: { message_id: string };
}

// ── 通道特定标准化 ─────────────────────────────────────────────

function normalizeWhatsApp(
  payload: WhatsAppPayload,
  triggerWord: string,
  receivedAt: number,
): NormalizedMessage | null {
  // 提取文本内容
  const content =
    payload.message?.conversation ??
    payload.message?.extendedTextMessage?.text ??
    '';

  if (!content || !shouldProcess(content, triggerWord)) {
    return null;
  }

  const jid = payload.key.remoteJid;
  const senderId = payload.key.participant ?? jid;
  const replyToId = payload.message?.extendedTextMessage?.contextInfo?.stanzaId;

  return {
    id: generateId(),
    groupId: '', // 由调用方根据 channel_id 映射到 group
    senderId,
    senderName: payload.pushName ?? '',
    content: stripTriggerWord(content, triggerWord),
    contentType: 'text',
    timestamp: receivedAt,
    channelType: 'whatsapp',
    replyToId,
  };
}

function normalizeTelegram(
  payload: TelegramPayload,
  triggerWord: string,
  receivedAt: number,
): NormalizedMessage | null {
  const content = payload.text ?? '';
  if (!content || !shouldProcess(content, triggerWord)) {
    return null;
  }

  const firstName = payload.from?.first_name ?? '';
  const lastName = payload.from?.last_name ?? '';
  const senderName = `${firstName} ${lastName}`.trim() || payload.from?.username || '';

  return {
    id: generateId(),
    groupId: '',
    senderId: payload.from?.id ? String(payload.from.id) : `channel_${payload.chat.id}`,
    senderName,
    content: stripTriggerWord(content, triggerWord),
    contentType: 'text',
    timestamp: receivedAt,
    channelType: 'telegram',
    replyToId: payload.reply_to_message ? String(payload.reply_to_message.message_id) : undefined,
  };
}

function normalizeSlack(
  payload: SlackPayload,
  triggerWord: string,
  receivedAt: number,
): NormalizedMessage | null {
  if (!payload.text || !shouldProcess(payload.text, triggerWord)) {
    return null;
  }

  return {
    id: generateId(),
    groupId: '',
    senderId: payload.user,
    senderName: '', // Slack 需要额外 API 调用获取用户名
    content: stripTriggerWord(payload.text, triggerWord),
    contentType: 'text',
    timestamp: receivedAt,
    channelType: 'slack',
    replyToId: payload.thread_ts,
  };
}

function normalizeDiscord(
  payload: DiscordPayload,
  triggerWord: string,
  receivedAt: number,
): NormalizedMessage | null {
  if (!payload.content || !shouldProcess(payload.content, triggerWord)) {
    return null;
  }

  return {
    id: generateId(),
    groupId: '',
    senderId: payload.author.id,
    senderName: payload.author.username,
    content: stripTriggerWord(payload.content, triggerWord),
    contentType: 'text',
    timestamp: receivedAt,
    channelType: 'discord',
    replyToId: payload.message_reference?.message_id,
    platformMessageId: payload.id, // Discord snowflake ID，用于回复
  };
}

// ── 统一入口 ──────────────────────────────────────────────────

/**
 * 将 RawMessage 标准化为 NormalizedMessage。
 * 返回 null 表示消息不需要处理（触发词不匹配或内容为空）。
 */
export function normalize(
  raw: RawMessage,
  triggerWord: string,
): NormalizedMessage | null {
  switch (raw.channelType) {
    case 'whatsapp':
      return normalizeWhatsApp(raw.rawPayload as WhatsAppPayload, triggerWord, raw.receivedAt);
    case 'telegram':
      return normalizeTelegram(raw.rawPayload as TelegramPayload, triggerWord, raw.receivedAt);
    case 'slack':
      return normalizeSlack(raw.rawPayload as SlackPayload, triggerWord, raw.receivedAt);
    case 'discord':
      return normalizeDiscord(raw.rawPayload as DiscordPayload, triggerWord, raw.receivedAt);
    default:
      return null;
  }
}

/**
 * 从 RawMessage 提取 channel-specific 的群组标识符。
 * 用于 db.getGroupByChannelId() 查询。
 */
export function extractChannelId(raw: RawMessage): string {
  switch (raw.channelType) {
    case 'whatsapp':
      return (raw.rawPayload as WhatsAppPayload).key.remoteJid;
    case 'telegram':
      return String((raw.rawPayload as TelegramPayload).chat.id);
    case 'slack':
      return (raw.rawPayload as SlackPayload).channel;
    case 'discord':
      return (raw.rawPayload as DiscordPayload).channel_id;
    default:
      return '';
  }
}
