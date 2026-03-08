// src/trust/injection-guard.ts
// Prompt Injection 检测 — 规则引擎 + 累积评分 + 信任级别阈值
import {
  type InjectionRule,
  type InjectionAnalysis,
  TrustLevel,
} from '../core/types';

// ── 扫描长度限制（防止 ReDoS） ──────────────────────────────────
const MAX_SCAN_LENGTH = 10_000;

// ── 注入规则表 ─────────────────────────────────────────────────
const INJECTION_RULES: InjectionRule[] = [
  // 直接指令覆盖（0.35–0.4）
  { pattern: /ignore (previous|all|above|prior) instructions/i, score: 0.4, flag: 'direct_override' },
  { pattern: /disregard (your|all) (guidelines|rules|instructions)/i, score: 0.4, flag: 'rule_disregard' },
  { pattern: /you are now (in )?(\w+ )?mode/i, score: 0.35, flag: 'mode_switch' },

  // 身份 / 角色切换（0.25–0.3）
  { pattern: /you are (now |actually |really )?a/i, score: 0.3, flag: 'identity_change' },
  { pattern: /act as (if |though )?(you are|you're)/i, score: 0.3, flag: 'persona_injection' },
  { pattern: /new (role|persona|identity|instructions|task)/i, score: 0.25, flag: 'role_change' },

  // 权威声称（0.35–0.4）
  { pattern: /(system|admin|administrator|developer|anthropic) (message|instruction|override|command)/i, score: 0.4, flag: 'authority_claim' },
  { pattern: /this is (an? )?(authorized|official|emergency)/i, score: 0.35, flag: 'authority_claim' },

  // 凭证 / 外渗意图（0.25–0.5）
  { pattern: /(api[_-]?key|secret|credential|password|token)/i, score: 0.3, flag: 'credential_request' },
  { pattern: /send (to|this to|it to) (http|https|ftp)/i, score: 0.5, flag: 'exfiltration_attempt' },
  { pattern: /curl|wget|fetch.*http/i, score: 0.25, flag: 'network_command' },

  // 隐藏 / 编码内容（0.15–0.2）
  { pattern: /\[hidden\]|\[invisible\]|<!--[^]*?-->/i, score: 0.2, flag: 'hidden_content' },
  { pattern: /base64|hex decode|rot13/i, score: 0.15, flag: 'encoding_trick' },
];

// ── 阈值配置 ───────────────────────────────────────────────────
// TRUSTED:  < 0.4 allow, 0.4–0.74 warn, >= 0.75 block
// ADMIN:    < 0.75 allow, >= 0.75 warn (不阻止)
// BLOCKED/UNTRUSTED: 始终 block（由 trust-engine 层处理）

function determineAction(
  score: number,
  trustLevel: TrustLevel,
): 'allow' | 'warn' | 'block' {
  if (trustLevel === TrustLevel.ADMIN) {
    return score >= 0.75 ? 'warn' : 'allow';
  }
  if (trustLevel === TrustLevel.TRUSTED) {
    if (score >= 0.75) return 'block';
    if (score >= 0.4) return 'warn';
    return 'allow';
  }
  // UNTRUSTED / BLOCKED — 由上层决策，这里保守处理
  if (score >= 0.75) return 'block';
  if (score >= 0.4) return 'warn';
  return 'allow';
}

// ── 核心分析函数 ───────────────────────────────────────────────

/**
 * 分析文本内容的注入风险。
 * - 截断到 MAX_SCAN_LENGTH 防止 ReDoS
 * - 累积匹配规则的分数，上限 1.0
 * - 根据 trustLevel 决定动作（allow / warn / block）
 */
export function analyze(
  content: string,
  trustLevel: TrustLevel = TrustLevel.TRUSTED,
): InjectionAnalysis {
  // 滑动窗口扫描：覆盖全部内容，防止截断绕过
  // 每个窗口 MAX_SCAN_LENGTH 字符，重叠 500 字符以防边界切割
  const OVERLAP = 500;
  let score = 0;
  const flagSet = new Set<string>();

  for (let offset = 0; offset < content.length; offset += MAX_SCAN_LENGTH - OVERLAP) {
    const window = content.slice(offset, offset + MAX_SCAN_LENGTH);

    for (const rule of INJECTION_RULES) {
      if (!flagSet.has(rule.flag) && rule.pattern.test(window)) {
        score += rule.score;
        flagSet.add(rule.flag);
      }
    }

    // 如果内容短于一个窗口，无需继续
    if (offset + MAX_SCAN_LENGTH >= content.length) break;
  }

  // 分数上限 1.0
  score = Math.min(score, 1.0);

  return {
    score,
    flags: Array.from(flagSet),
    action: determineAction(score, trustLevel),
  };
}

/**
 * 用于 memory write 的严格分析（阈值 0.5，无信任级别加成）。
 * 返回的 action 固定为 block（score >= 0.5）或 allow。
 */
export function analyzeForMemoryWrite(content: string): InjectionAnalysis {
  const result = analyze(content, TrustLevel.TRUSTED);
  return {
    ...result,
    action: result.score >= 0.5 ? 'block' : 'allow',
  };
}

/** 暴露规则表（测试用） */
export function getRules(): readonly InjectionRule[] {
  return INJECTION_RULES;
}

/** 暴露扫描长度（测试用） */
export const MAX_SCAN = MAX_SCAN_LENGTH;
