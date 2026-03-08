// src/ingress/normalizer.test.ts
import { describe, it, expect } from 'vitest';
import {
  shouldProcess,
  stripTriggerWord,
  normalize,
  extractChannelId,
  type WhatsAppPayload,
  type TelegramPayload,
  type SlackPayload,
  type DiscordPayload,
} from './normalizer';
import type { RawMessage } from '../core/types';

// ── shouldProcess ──────────────────────────────────────────────

describe('shouldProcess', () => {
  it('should return true when trigger word is empty', () => {
    expect(shouldProcess('any content', '')).toBe(true);
  });

  it('should return true when content starts with trigger word', () => {
    expect(shouldProcess('@Andy 帮我看看', '@Andy')).toBe(true);
  });

  it('should handle leading whitespace', () => {
    expect(shouldProcess('  @Andy 帮我看看', '@Andy')).toBe(true);
  });

  it('should return false when trigger word not present', () => {
    expect(shouldProcess('hello world', '@Andy')).toBe(false);
  });

  it('should return false when trigger word is in middle', () => {
    expect(shouldProcess('hello @Andy there', '@Andy')).toBe(false);
  });

  it('should be case-sensitive', () => {
    expect(shouldProcess('@andy help', '@Andy')).toBe(false);
  });
});

// ── stripTriggerWord ──────────────────────────────────────────

describe('stripTriggerWord', () => {
  it('should remove trigger word and trim', () => {
    expect(stripTriggerWord('@Andy 帮我查天气', '@Andy')).toBe('帮我查天气');
  });

  it('should trim when no trigger word', () => {
    expect(stripTriggerWord('  hello  ', '')).toBe('hello');
  });

  it('should handle trigger word at start with no space', () => {
    expect(stripTriggerWord('@Andyhelp', '@Andy')).toBe('help');
  });

  it('should return original trimmed if no match', () => {
    expect(stripTriggerWord('hello world', '@Andy')).toBe('hello world');
  });

  it('should handle trigger word only', () => {
    expect(stripTriggerWord('@Andy', '@Andy')).toBe('');
  });
});

// ── WhatsApp normalize ────────────────────────────────────────

describe('normalize: WhatsApp', () => {
  function makeWhatsAppRaw(payload: WhatsAppPayload): RawMessage {
    return { channelType: 'whatsapp', rawPayload: payload, receivedAt: Date.now() };
  }

  it('should normalize WhatsApp conversation message', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: '12345@g.us', participant: 'sender@s.whatsapp.net', id: 'msg-1' },
      pushName: 'Alice',
      message: { conversation: '@Andy 帮我看看' },
    };
    const result = normalize(makeWhatsAppRaw(payload), '@Andy');

    expect(result).not.toBeNull();
    expect(result!.content).toBe('帮我看看');
    expect(result!.senderId).toBe('sender@s.whatsapp.net');
    expect(result!.senderName).toBe('Alice');
    expect(result!.channelType).toBe('whatsapp');
    expect(result!.contentType).toBe('text');
  });

  it('should normalize WhatsApp extendedTextMessage', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: '12345@g.us', id: 'msg-2' },
      message: {
        extendedTextMessage: {
          text: '@Andy hello',
          contextInfo: { stanzaId: 'reply-to-id' },
        },
      },
    };
    const result = normalize(makeWhatsAppRaw(payload), '@Andy');

    expect(result).not.toBeNull();
    expect(result!.content).toBe('hello');
    expect(result!.replyToId).toBe('reply-to-id');
  });

  it('should return null for non-trigger WhatsApp message', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: '12345@g.us', id: 'msg-3' },
      message: { conversation: 'hello without trigger' },
    };
    expect(normalize(makeWhatsAppRaw(payload), '@Andy')).toBeNull();
  });

  it('should return null for empty WhatsApp message', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: '12345@g.us', id: 'msg-4' },
      message: {},
    };
    expect(normalize(makeWhatsAppRaw(payload), '@Andy')).toBeNull();
  });

  it('should use remoteJid as senderId when no participant', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: 'direct@s.whatsapp.net', id: 'msg-5' },
      message: { conversation: '@Andy hi' },
    };
    const result = normalize(makeWhatsAppRaw(payload), '@Andy');
    expect(result!.senderId).toBe('direct@s.whatsapp.net');
  });
});

// ── Telegram normalize ────────────────────────────────────────

describe('normalize: Telegram', () => {
  function makeTelegramRaw(payload: TelegramPayload): RawMessage {
    return { channelType: 'telegram', rawPayload: payload, receivedAt: Date.now() };
  }

  it('should normalize Telegram message', () => {
    const payload: TelegramPayload = {
      message_id: 100,
      chat: { id: -1001234, title: 'Test Group' },
      from: { id: 999, first_name: 'Bob', last_name: 'Smith', username: 'bobsmith' },
      text: '@Andy 查天气',
    };
    const result = normalize(makeTelegramRaw(payload), '@Andy');

    expect(result).not.toBeNull();
    expect(result!.content).toBe('查天气');
    expect(result!.senderId).toBe('999');
    expect(result!.senderName).toBe('Bob Smith');
    expect(result!.channelType).toBe('telegram');
  });

  it('should handle Telegram reply', () => {
    const payload: TelegramPayload = {
      message_id: 101,
      chat: { id: -1001234 },
      from: { id: 999, first_name: 'Bob' },
      text: '@Andy reply',
      reply_to_message: { message_id: 50 },
    };
    const result = normalize(makeTelegramRaw(payload), '@Andy');
    expect(result!.replyToId).toBe('50');
  });

  it('should return null for non-trigger Telegram message', () => {
    const payload: TelegramPayload = {
      message_id: 102,
      chat: { id: -1001234 },
      text: 'regular message',
    };
    expect(normalize(makeTelegramRaw(payload), '@Andy')).toBeNull();
  });

  it('should use username when no first/last name', () => {
    const payload: TelegramPayload = {
      message_id: 103,
      chat: { id: -1001234 },
      from: { id: 888, username: 'anon_user' },
      text: '@Andy hi',
    };
    const result = normalize(makeTelegramRaw(payload), '@Andy');
    expect(result!.senderName).toBe('anon_user');
  });

  // BUG-7 回归：频道消息无 from 时 senderId 应有前缀区分
  it('should prefix senderId with channel_ when from is missing', () => {
    const payload: TelegramPayload = {
      message_id: 200,
      chat: { id: -1009999 },
      // no 'from' field — channel message
      text: '@Andy channel post',
    };
    const result = normalize(makeTelegramRaw(payload), '@Andy');
    expect(result).not.toBeNull();
    expect(result!.senderId).toBe('channel_-1009999');
  });

  it('should use numeric from.id as senderId when from exists', () => {
    const payload: TelegramPayload = {
      message_id: 201,
      chat: { id: -1009999 },
      from: { id: 12345, first_name: 'User' },
      text: '@Andy normal msg',
    };
    const result = normalize(makeTelegramRaw(payload), '@Andy');
    expect(result!.senderId).toBe('12345');
  });
});

// ── Slack normalize ───────────────────────────────────────────

describe('normalize: Slack', () => {
  function makeSlackRaw(payload: SlackPayload): RawMessage {
    return { channelType: 'slack', rawPayload: payload, receivedAt: Date.now() };
  }

  it('should normalize Slack message', () => {
    const payload: SlackPayload = {
      channel: 'C1234',
      user: 'U5678',
      text: '@Andy deploy',
      ts: '1234567890.123456',
    };
    const result = normalize(makeSlackRaw(payload), '@Andy');

    expect(result).not.toBeNull();
    expect(result!.content).toBe('deploy');
    expect(result!.senderId).toBe('U5678');
    expect(result!.channelType).toBe('slack');
  });

  it('should handle Slack thread', () => {
    const payload: SlackPayload = {
      channel: 'C1234',
      user: 'U5678',
      text: '@Andy reply',
      ts: '1234567890.123456',
      thread_ts: '1234567890.000000',
    };
    const result = normalize(makeSlackRaw(payload), '@Andy');
    expect(result!.replyToId).toBe('1234567890.000000');
  });

  it('should return null for non-trigger Slack message', () => {
    const payload: SlackPayload = {
      channel: 'C1234',
      user: 'U5678',
      text: 'just chatting',
      ts: '1234567890.123456',
    };
    expect(normalize(makeSlackRaw(payload), '@Andy')).toBeNull();
  });
});

// ── Discord normalize ─────────────────────────────────────────

describe('normalize: Discord', () => {
  function makeDiscordRaw(payload: DiscordPayload): RawMessage {
    return { channelType: 'discord', rawPayload: payload, receivedAt: Date.now() };
  }

  it('should normalize Discord message', () => {
    const payload: DiscordPayload = {
      id: 'msg-dc-1',
      channel_id: 'ch-1',
      author: { id: 'user-dc-1', username: 'gamer42' },
      content: '@Andy status',
    };
    const result = normalize(makeDiscordRaw(payload), '@Andy');

    expect(result).not.toBeNull();
    expect(result!.content).toBe('status');
    expect(result!.senderId).toBe('user-dc-1');
    expect(result!.senderName).toBe('gamer42');
    expect(result!.channelType).toBe('discord');
  });

  it('should handle Discord reply', () => {
    const payload: DiscordPayload = {
      id: 'msg-dc-2',
      channel_id: 'ch-1',
      author: { id: 'user-dc-1', username: 'gamer42' },
      content: '@Andy reply here',
      message_reference: { message_id: 'original-msg' },
    };
    const result = normalize(makeDiscordRaw(payload), '@Andy');
    expect(result!.replyToId).toBe('original-msg');
  });

  it('should return null for non-trigger Discord message', () => {
    const payload: DiscordPayload = {
      id: 'msg-dc-3',
      channel_id: 'ch-1',
      author: { id: 'user-dc-1', username: 'gamer42' },
      content: 'regular chat',
    };
    expect(normalize(makeDiscordRaw(payload), '@Andy')).toBeNull();
  });
});

// ── 通用标准化 ────────────────────────────────────────────────

describe('normalize: general', () => {
  it('should return null for unknown channel type', () => {
    const raw: RawMessage = {
      channelType: 'unknown' as any,
      rawPayload: {},
      receivedAt: Date.now(),
    };
    expect(normalize(raw, '@Andy')).toBeNull();
  });

  it('should process all messages when trigger word is empty', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: '12345@g.us', id: 'msg-all' },
      message: { conversation: 'any message without trigger' },
    };
    const result = normalize(
      { channelType: 'whatsapp', rawPayload: payload, receivedAt: Date.now() },
      '', // 空触发词 → 处理所有
    );
    expect(result).not.toBeNull();
    expect(result!.content).toBe('any message without trigger');
  });

  it('should set groupId to empty string (caller maps it)', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: '12345@g.us', id: 'msg-group' },
      message: { conversation: '@Andy test' },
    };
    const result = normalize(
      { channelType: 'whatsapp', rawPayload: payload, receivedAt: Date.now() },
      '@Andy',
    );
    expect(result!.groupId).toBe('');
  });

  it('should generate unique IDs for each message', () => {
    const payload: WhatsAppPayload = {
      key: { remoteJid: '12345@g.us', id: 'msg-uniq' },
      message: { conversation: '@Andy test' },
    };
    const raw: RawMessage = { channelType: 'whatsapp', rawPayload: payload, receivedAt: Date.now() };

    const r1 = normalize(raw, '@Andy');
    const r2 = normalize(raw, '@Andy');
    expect(r1!.id).not.toBe(r2!.id);
  });
});

// ── extractChannelId ─────────────────────────────────────────────

describe('extractChannelId', () => {
  it('should extract WhatsApp JID', () => {
    const raw: RawMessage = {
      channelType: 'whatsapp',
      rawPayload: { key: { remoteJid: '12345@g.us', id: 'x' }, message: { conversation: 'test' } },
      receivedAt: Date.now(),
    };
    expect(extractChannelId(raw)).toBe('12345@g.us');
  });

  it('should extract Telegram chat ID', () => {
    const raw: RawMessage = {
      channelType: 'telegram',
      rawPayload: { message_id: 1, chat: { id: -100123 }, text: 'test' } as TelegramPayload,
      receivedAt: Date.now(),
    };
    expect(extractChannelId(raw)).toBe('-100123');
  });

  it('should extract Slack channel', () => {
    const raw: RawMessage = {
      channelType: 'slack',
      rawPayload: { channel: 'C01ABC', user: 'U01', text: 'test', ts: '123' } as SlackPayload,
      receivedAt: Date.now(),
    };
    expect(extractChannelId(raw)).toBe('C01ABC');
  });

  it('should extract Discord channel_id', () => {
    const raw: RawMessage = {
      channelType: 'discord',
      rawPayload: { id: '1', channel_id: 'ch-999', author: { id: 'u', username: 'n' }, content: 'test' } as DiscordPayload,
      receivedAt: Date.now(),
    };
    expect(extractChannelId(raw)).toBe('ch-999');
  });

  it('should return empty string for unknown channel', () => {
    const raw: RawMessage = {
      channelType: 'unknown' as any,
      rawPayload: {},
      receivedAt: Date.now(),
    };
    expect(extractChannelId(raw)).toBe('');
  });
});
