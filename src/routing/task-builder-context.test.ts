// src/routing/task-builder-context.test.ts
// buildConversationContext 多轮上下文构建测试
import { describe, it, expect } from 'vitest';
import { buildConversationContext, buildHistoryContext } from './task-builder';
import type { ConversationTurn, Message } from '../core/types';

// ── 辅助 ────────────────────────────────────────────────────────

function makeTurn(
  overrides: Partial<ConversationTurn> & { role: 'user' | 'assistant'; content: string },
): ConversationTurn {
  const { role, content, ...rest } = overrides;
  return {
    id: `turn-${Math.random().toString(36).slice(2, 8)}`,
    group_id: 'test-group',
    sender_id: role === 'assistant' ? 'assistant' : 'user-001',
    sender_name: role === 'assistant' ? 'assistant' : rest.sender_name || 'Alice',
    timestamp: Date.now(),
    source_message_id: 'src-001',
    ...rest,
    role,
    content,
  };
}

// ══════════════════════════════════════════════════════════════════
// buildConversationContext
// ══════════════════════════════════════════════════════════════════

describe('buildConversationContext', () => {
  it('空轮次应返回空字符串', () => {
    expect(buildConversationContext([], 10)).toBe('');
  });

  it('应包含 user 和 assistant 标签', () => {
    const turns = [
      makeTurn({ role: 'user', content: '你好', sender_name: 'Alice' }),
      makeTurn({ role: 'assistant', content: '你好！' }),
    ];
    const result = buildConversationContext(turns, 10);
    expect(result).toContain('[Alice]: 你好');
    expect(result).toContain('[Assistant]: 你好！');
  });

  it('应包含 conversation 分隔标记', () => {
    const turns = [makeTurn({ role: 'user', content: 'hi' })];
    const result = buildConversationContext(turns, 10);
    expect(result).toContain('--- Recent conversation ---');
    expect(result).toContain('--- End conversation ---');
  });

  it('应遵守 maxTurns 限制', () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      makeTurn({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}`, timestamp: i })
    );
    const result = buildConversationContext(turns, 5);
    // 只应包含最后 5 条
    expect(result).toContain('msg-15');
    expect(result).toContain('msg-19');
    expect(result).not.toContain('msg-0');
    expect(result).not.toContain('msg-14');
  });

  it('应截断超过 500 字符的内容', () => {
    const longContent = 'x'.repeat(1000);
    const turns = [makeTurn({ role: 'user', content: longContent })];
    const result = buildConversationContext(turns, 10);
    expect(result).toContain('x'.repeat(500) + '...');
    expect(result).not.toContain('x'.repeat(501));
  });

  it('不超过 500 字符的内容不应被截断', () => {
    const content = 'y'.repeat(499);
    const turns = [makeTurn({ role: 'user', content })];
    const result = buildConversationContext(turns, 10);
    expect(result).toContain(content);
    expect(result).not.toContain('...');
  });

  it('应正确处理多轮 user-assistant 交替', () => {
    const turns = [
      makeTurn({ role: 'user', content: 'Q1', sender_name: 'Alice', timestamp: 1 }),
      makeTurn({ role: 'assistant', content: 'A1', timestamp: 2 }),
      makeTurn({ role: 'user', content: 'Q2', sender_name: 'Alice', timestamp: 3 }),
      makeTurn({ role: 'assistant', content: 'A2', timestamp: 4 }),
    ];
    const result = buildConversationContext(turns, 10);
    const lines = result.split('\n').filter(l => l.startsWith('['));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('[Alice]: Q1');
    expect(lines[1]).toContain('[Assistant]: A1');
    expect(lines[2]).toContain('[Alice]: Q2');
    expect(lines[3]).toContain('[Assistant]: A2');
  });

  it('sender_id 回退：无 sender_name 时使用 sender_id', () => {
    const turns = [makeTurn({ role: 'user', content: 'hi', sender_name: '', sender_id: 'uid-123' })];
    const result = buildConversationContext(turns, 10);
    expect(result).toContain('[uid-123]: hi');
  });

  it('应处理中文内容', () => {
    const turns = [
      makeTurn({ role: 'user', content: '帮我整理桌面', sender_name: '小明' }),
      makeTurn({ role: 'assistant', content: '已完成整理，共移动了 5 个文件' }),
    ];
    const result = buildConversationContext(turns, 10);
    expect(result).toContain('[小明]: 帮我整理桌面');
    expect(result).toContain('[Assistant]: 已完成整理');
  });
});

// ══════════════════════════════════════════════════════════════════
// buildHistoryContext（旧版，保留兼容性）
// ══════════════════════════════════════════════════════════════════

describe('buildHistoryContext（旧版兼容）', () => {
  it('空消息应返回空字符串', () => {
    expect(buildHistoryContext([], 10)).toBe('');
  });

  it('应格式化用户消息', () => {
    const msgs: Message[] = [{
      id: 'm1', group_id: 'g1', sender_id: 'u1', sender_name: 'Bob',
      content: 'hello', content_type: 'text', trust_level: 2,
      injection_score: 0, timestamp: 1000, processed: 0,
    }];
    const result = buildHistoryContext(msgs, 10);
    expect(result).toContain('[Bob]: hello');
  });

  it('应遵守 maxMessages 限制', () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, group_id: 'g1', sender_id: 'u1', sender_name: 'Bob',
      content: `msg-${i}`, content_type: 'text', trust_level: 2,
      injection_score: 0, timestamp: i * 1000, processed: 0,
    }));
    const result = buildHistoryContext(msgs, 3);
    expect(result).toContain('msg-7');
    expect(result).toContain('msg-9');
    expect(result).not.toContain('msg-0');
  });
});
