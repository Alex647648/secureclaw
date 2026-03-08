// src/core/metrics.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Metrics } from './metrics';

let m: Metrics;

beforeEach(() => {
  m = new Metrics();
});

describe('Metrics', () => {
  it('should start with all counters at zero', () => {
    const s = m.snapshot();
    expect(s.tasks.total).toBe(0);
    expect(s.tasks.success).toBe(0);
    expect(s.tasks.failed).toBe(0);
    expect(s.queue.enqueued).toBe(0);
    expect(s.queue.rejected).toBe(0);
    expect(s.credentials.issued).toBe(0);
    expect(s.messages.received).toBe(0);
    expect(s.messages.sent).toBe(0);
    expect(s.messages.rateLimited).toBe(0);
    expect(s.messages.injectionBlocked).toBe(0);
  });

  it('should count successful tasks', () => {
    m.taskCompleted(true);
    m.taskCompleted(true);
    m.taskCompleted(false);

    const s = m.snapshot();
    expect(s.tasks.total).toBe(3);
    expect(s.tasks.success).toBe(2);
    expect(s.tasks.failed).toBe(1);
  });

  it('should count queue operations', () => {
    m.queueEnqueued();
    m.queueEnqueued();
    m.queueRejected();

    const s = m.snapshot();
    expect(s.queue.enqueued).toBe(2);
    expect(s.queue.rejected).toBe(1);
  });

  it('should count message operations', () => {
    m.messageReceived();
    m.messageReceived();
    m.messageSent();
    m.messageRateLimited();
    m.messageInjectionBlocked();

    const s = m.snapshot();
    expect(s.messages.received).toBe(2);
    expect(s.messages.sent).toBe(1);
    expect(s.messages.rateLimited).toBe(1);
    expect(s.messages.injectionBlocked).toBe(1);
  });

  it('should count credential issuance', () => {
    m.credentialIssued();
    m.credentialIssued();

    expect(m.snapshot().credentials.issued).toBe(2);
  });

  it('should reset all counters', () => {
    m.taskCompleted(true);
    m.queueEnqueued();
    m.messageReceived();
    m.credentialIssued();

    m.reset();

    const s = m.snapshot();
    expect(s.tasks.total).toBe(0);
    expect(s.queue.enqueued).toBe(0);
    expect(s.messages.received).toBe(0);
    expect(s.credentials.issued).toBe(0);
  });

  it('should return independent snapshots', () => {
    m.taskCompleted(true);
    const s1 = m.snapshot();

    m.taskCompleted(false);
    const s2 = m.snapshot();

    // s1 不应被 s2 影响
    expect(s1.tasks.total).toBe(1);
    expect(s2.tasks.total).toBe(2);
  });
});
