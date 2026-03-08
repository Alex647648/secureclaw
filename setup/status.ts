/**
 * 结构化状态输出 — 每个 setup 步骤发射一个 LLM 可解析的状态块
 */

export function emitStatus(
  step: string,
  fields: Record<string, string | number | boolean>,
): void {
  const lines = [`=== SECURECLAW SETUP: ${step} ===`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}
