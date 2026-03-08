// src/execution/host-backend.test.ts
// 新增工具（9个）+ 辅助函数的单元测试
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cleanModelOutput, extractToolCalls, executeTool } from './host-backend';
import { SecureClawDB } from '../db/db';
import { TrustLevel } from '../core/types';

// ── 测试用临时目录 ──────────────────────────────────────────────

let tmpDir: string;
let homeDir: string;
let projectRoot: string;
let db: SecureClawDB;
const GROUP_ID = 'test-group-001';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-'));
  homeDir = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(path.join(homeDir, 'Desktop'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'groups', GROUP_ID), { recursive: true });

  // 创建测试文件
  fs.writeFileSync(path.join(homeDir, 'Desktop', 'hello.txt'), 'Hello World');
  fs.writeFileSync(path.join(homeDir, 'Desktop', 'data.csv'), 'a,b,c');
  fs.writeFileSync(path.join(homeDir, '.hidden'), 'secret');

  // 创建内存数据库
  db = new SecureClawDB(path.join(tmpDir, 'test.db'));
  db.createGroup({
    id: GROUP_ID,
    name: 'Test Group',
    channel_type: 'discord',
    channel_id: 'ch-001',
    trust_level: TrustLevel.ADMIN,
    network_policy: 'trusted',
    is_admin_group: 1,
  });
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// cleanModelOutput
// ══════════════════════════════════════════════════════════════════

describe('cleanModelOutput', () => {
  it('应返回普通文本不变', () => {
    expect(cleanModelOutput('Hello World')).toBe('Hello World');
  });

  it('应提取 JSON {"result":"..."} 包装', () => {
    expect(cleanModelOutput('{"status":"success","result":"Hello"}')).toBe('Hello');
  });

  it('应剥离 SECURECLAW_OUTPUT_START/END 标记', () => {
    expect(cleanModelOutput('SECURECLAW_OUTPUT_START\nHello\nSECURECLAW_OUTPUT_END'))
      .toBe('Hello');
  });

  it('应处理嵌套情况：JSON 包装 + 标记', () => {
    const raw = '{"result":"SECURECLAW_OUTPUT_START\\nHello\\nSECURECLAW_OUTPUT_END"}';
    const result = cleanModelOutput(raw);
    expect(result).not.toContain('SECURECLAW_OUTPUT_START');
    expect(result).toContain('Hello');
  });

  it('应将字面 \\n 转换为真正的换行', () => {
    expect(cleanModelOutput('Line1\\nLine2')).toBe('Line1\nLine2');
  });

  it('应去除首尾空白', () => {
    expect(cleanModelOutput('  Hello  ')).toBe('Hello');
  });

  it('应处理 {"status":"success","result":"..."} 格式', () => {
    expect(cleanModelOutput('{"status":"success","result":"OK"}')).toBe('OK');
  });

  it('应处理空字符串', () => {
    expect(cleanModelOutput('')).toBe('');
  });

  it('应处理只有标记没有内容', () => {
    expect(cleanModelOutput('SECURECLAW_OUTPUT_START\nSECURECLAW_OUTPUT_END')).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
// extractToolCalls
// ══════════════════════════════════════════════════════════════════

describe('extractToolCalls', () => {
  it('应提取单个工具调用', () => {
    const text = 'Some text\n<tool_call>\n{"name":"list_files","input":{"path":"~/Desktop"}}\n</tool_call>\nMore text';
    const { toolCalls, cleanText } = extractToolCalls(text);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('list_files');
    expect(toolCalls[0].input).toEqual({ path: '~/Desktop' });
    expect(cleanText).toBe('Some text\n\nMore text');
  });

  it('应提取多个工具调用', () => {
    const text = '<tool_call>\n{"name":"read_file","input":{"path":"a.txt"}}\n</tool_call>\n<tool_call>\n{"name":"write_file","input":{"path":"b.txt","content":"hi"}}\n</tool_call>';
    const { toolCalls } = extractToolCalls(text);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe('read_file');
    expect(toolCalls[1].name).toBe('write_file');
  });

  it('无工具调用时返回空数组', () => {
    const { toolCalls, cleanText } = extractToolCalls('Hello World');
    expect(toolCalls).toHaveLength(0);
    expect(cleanText).toBe('Hello World');
  });

  it('应跳过格式错误的 JSON', () => {
    const text = '<tool_call>\n{bad json}\n</tool_call>';
    const { toolCalls } = extractToolCalls(text);
    expect(toolCalls).toHaveLength(0);
  });

  it('缺少 name 字段时应跳过', () => {
    const text = '<tool_call>\n{"input":{"path":"/"}}\n</tool_call>';
    const { toolCalls } = extractToolCalls(text);
    expect(toolCalls).toHaveLength(0);
  });

  it('缺少 input 字段时应补空对象', () => {
    const text = '<tool_call>\n{"name":"list_files"}\n</tool_call>';
    const { toolCalls } = extractToolCalls(text);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].input).toEqual({});
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 基础文件工具（验证基础设施可用）
// ══════════════════════════════════════════════════════════════════

describe('executeTool - 基础工具', () => {
  it('list_files: 应列出目录内容', () => {
    const result = executeTool('list_files', { path: path.join(homeDir, 'Desktop') }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('hello.txt');
    expect(result).toContain('data.csv');
  });

  it('list_files: 隐藏文件默认不显示', () => {
    const result = executeTool('list_files', { path: homeDir }, homeDir, projectRoot, GROUP_ID);
    expect(result).not.toContain('.hidden');
  });

  it('list_files: show_hidden=true 应显示隐藏文件', () => {
    const result = executeTool('list_files', { path: homeDir, show_hidden: true }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('.hidden');
  });

  it('read_file: 应读取文件内容', () => {
    const result = executeTool('read_file', { path: path.join(homeDir, 'Desktop', 'hello.txt') }, homeDir, projectRoot, GROUP_ID);
    expect(result).toBe('Hello World');
  });

  it('write_file: 应写入文件', () => {
    const testPath = path.join(tmpDir, 'write-test.txt');
    const result = executeTool('write_file', { path: testPath, content: 'test content' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Wrote');
    expect(fs.readFileSync(testPath, 'utf8')).toBe('test content');
  });

  it('write_file: append 模式', () => {
    const testPath = path.join(tmpDir, 'append-test.txt');
    fs.writeFileSync(testPath, 'first');
    executeTool('write_file', { path: testPath, content: '-second', append: true }, homeDir, projectRoot, GROUP_ID);
    expect(fs.readFileSync(testPath, 'utf8')).toBe('first-second');
  });

  it('unknown tool: 应返回错误', () => {
    const result = executeTool('nonexistent', {}, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Unknown tool');
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 新增工具 #1: run_applescript
// ══════════════════════════════════════════════════════════════════

describe('executeTool - run_applescript', () => {
  it('应执行简单 AppleScript 并返回结果', () => {
    // "return 42" 是最简单的 AppleScript
    const result = executeTool('run_applescript', { script: 'return 42' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toBe('42');
  });

  it('应执行字符串拼接', () => {
    const result = executeTool('run_applescript', { script: 'return "hello" & " " & "world"' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toBe('hello world');
  });

  it('缺少 script 参数应返回错误', () => {
    const result = executeTool('run_applescript', {}, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Error');
    expect(result).toContain('script');
  });

  it('无效脚本应返回错误', () => {
    const result = executeTool('run_applescript', { script: 'this is not valid applescript @@!!!' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Error');
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 新增工具 #2: ensure_tool
// ══════════════════════════════════════════════════════════════════

describe('executeTool - ensure_tool', () => {
  it('已安装的工具应返回成功', () => {
    const result = executeTool('ensure_tool', { name: 'node' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('✅');
    expect(result).toContain('node');
    expect(result).toContain('already installed');
  });

  it('ls 也应被识别为已安装', () => {
    const result = executeTool('ensure_tool', { name: 'ls' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('✅');
  });

  it('缺少 name 参数应返回错误', () => {
    const result = executeTool('ensure_tool', {}, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Error');
    expect(result).toContain('name');
  });

  it('不存在的工具 + 自定义安装命令失败应返回 ❌', () => {
    // 用一个必定失败的安装命令，避免触发 brew/npm 超时
    const result = executeTool('ensure_tool', {
      name: 'zzz_nonexistent_tool_12345',
      install_cmd: 'false',  // 立即返回非零退出码
    }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('❌');
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 新增工具 #3: http_request (异步)
// ══════════════════════════════════════════════════════════════════

describe('executeTool - http_request', () => {
  it('缺少 url 参数应返回错误', () => {
    const result = executeTool('http_request', {}, homeDir, projectRoot, GROUP_ID);
    expect(result).toBe('Error: url parameter is required');
  });

  it('应返回 Promise', () => {
    const result = executeTool('http_request', { url: 'http://localhost:9090/health' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toBeInstanceOf(Promise);
  });

  it('本地 health 端点应返回 200', async () => {
    const result = executeTool('http_request', { url: 'http://localhost:9090/health' }, homeDir, projectRoot, GROUP_ID);
    const output = await (result as Promise<string>);
    expect(output).toContain('HTTP 200');
    expect(output).toContain('"status":"ok"');
  });

  it('无效 URL 应返回错误', async () => {
    const result = executeTool('http_request', { url: 'http://localhost:1/nope', method: 'GET' }, homeDir, projectRoot, GROUP_ID);
    const output = await (result as Promise<string>);
    expect(output).toContain('Error');
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 新增工具 #4: web_search (异步)
// ══════════════════════════════════════════════════════════════════

describe('executeTool - web_search', () => {
  it('缺少 query 参数应返回错误', () => {
    const result = executeTool('web_search', {}, homeDir, projectRoot, GROUP_ID);
    expect(result).toBe('Error: query parameter is required');
  });

  it('未配置 SEARCH_API_KEY 应返回提示错误', () => {
    const origKey = process.env.SEARCH_API_KEY;
    delete process.env.SEARCH_API_KEY;
    const result = executeTool('web_search', { query: 'test' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('SEARCH_API_KEY');
    if (origKey) process.env.SEARCH_API_KEY = origKey;
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 新增工具 #5-8: 结构化记忆工具
// ══════════════════════════════════════════════════════════════════

describe('executeTool - 结构化记忆 (remember/recall/forget/list_memories)', () => {
  beforeEach(() => {
    // 清理记忆表
    try { db.deleteMemoryEntry(GROUP_ID, 'test-key'); } catch { /* ignore */ }
    try { db.deleteMemoryEntry(GROUP_ID, 'color'); } catch { /* ignore */ }
    try { db.deleteMemoryEntry(GROUP_ID, 'name'); } catch { /* ignore */ }
  });

  // ── remember ──────────────────────────────────────────────────

  it('remember: 应存储键值对', () => {
    const result = executeTool('remember', { key: 'color', value: 'blue' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('✅');
    expect(result).toContain('color');
    expect(result).toContain('blue');
  });

  it('remember: 带 tags 应存储', () => {
    const result = executeTool('remember', { key: 'name', value: 'Alice', tags: 'user,profile' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('✅');
    expect(result).toContain('tags: user,profile');
  });

  it('remember: 缺少参数应返回错误', () => {
    expect(executeTool('remember', { key: 'a' }, homeDir, projectRoot, GROUP_ID, db)).toContain('Error');
    expect(executeTool('remember', { value: 'b' }, homeDir, projectRoot, GROUP_ID, db)).toContain('Error');
  });

  it('remember: 无 db 应返回错误', () => {
    const result = executeTool('remember', { key: 'a', value: 'b' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('database not available');
  });

  it('remember: UPSERT 应更新已有 key', () => {
    executeTool('remember', { key: 'color', value: 'blue' }, homeDir, projectRoot, GROUP_ID, db);
    executeTool('remember', { key: 'color', value: 'red' }, homeDir, projectRoot, GROUP_ID, db);
    const memories = db.listMemory(GROUP_ID);
    const colorEntry = memories.find(m => m.key === 'color');
    expect(colorEntry?.value).toBe('red');
  });

  // ── recall ────────────────────────────────────────────────────

  it('recall: 应按关键词搜索', () => {
    executeTool('remember', { key: 'color', value: 'blue' }, homeDir, projectRoot, GROUP_ID, db);
    executeTool('remember', { key: 'name', value: 'Alice' }, homeDir, projectRoot, GROUP_ID, db);
    const result = executeTool('recall', { query: 'color' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('color');
    expect(result).toContain('blue');
  });

  it('recall: 应搜索 value 字段', () => {
    executeTool('remember', { key: 'pet', value: 'golden retriever' }, homeDir, projectRoot, GROUP_ID, db);
    const result = executeTool('recall', { query: 'golden' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('golden retriever');
    // 清理
    db.deleteMemoryEntry(GROUP_ID, 'pet');
  });

  it('recall: 应搜索 tags 字段', () => {
    executeTool('remember', { key: 'name', value: 'Alice', tags: 'important' }, homeDir, projectRoot, GROUP_ID, db);
    const result = executeTool('recall', { query: 'important' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('name');
  });

  it('recall: 无匹配应返回提示', () => {
    const result = executeTool('recall', { query: 'zzz_notfound' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('No memories found');
  });

  it('recall: 缺少 query 应返回错误', () => {
    expect(executeTool('recall', {}, homeDir, projectRoot, GROUP_ID, db)).toContain('Error');
  });

  // ── forget ────────────────────────────────────────────────────

  it('forget: 应删除指定 key', () => {
    executeTool('remember', { key: 'color', value: 'blue' }, homeDir, projectRoot, GROUP_ID, db);
    const result = executeTool('forget', { key: 'color' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('Forgot');
    const search = executeTool('recall', { query: 'color' }, homeDir, projectRoot, GROUP_ID, db);
    expect(search).toContain('No memories found');
  });

  it('forget: 不存在的 key 应返回提示', () => {
    const result = executeTool('forget', { key: 'nonexistent_key_xyz' }, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('No memory found');
  });

  it('forget: 缺少 key 应返回错误', () => {
    expect(executeTool('forget', {}, homeDir, projectRoot, GROUP_ID, db)).toContain('Error');
  });

  // ── list_memories ─────────────────────────────────────────────

  it('list_memories: 空状态应返回提示', () => {
    const result = executeTool('list_memories', {}, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('No memories stored');
  });

  it('list_memories: 应列出所有记忆', () => {
    executeTool('remember', { key: 'color', value: 'blue' }, homeDir, projectRoot, GROUP_ID, db);
    executeTool('remember', { key: 'name', value: 'Alice' }, homeDir, projectRoot, GROUP_ID, db);
    const result = executeTool('list_memories', {}, homeDir, projectRoot, GROUP_ID, db);
    expect(result).toContain('color');
    expect(result).toContain('blue');
    expect(result).toContain('name');
    expect(result).toContain('Alice');
  });

  it('list_memories: 无 db 应返回错误', () => {
    const result = executeTool('list_memories', {}, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('database not available');
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 新增工具 #9: ask_confirmation
// ══════════════════════════════════════════════════════════════════

describe('executeTool - ask_confirmation', () => {
  it('应返回 CONFIRMATION_REQUESTED 标识', () => {
    const result = executeTool('ask_confirmation', { question: '确定删除吗？' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('CONFIRMATION_REQUESTED');
    expect(result).toContain('确定删除吗？');
  });

  it('缺少 question 参数应返回错误', () => {
    const result = executeTool('ask_confirmation', {}, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Error');
    expect(result).toContain('question');
  });
});

// ══════════════════════════════════════════════════════════════════
// executeTool — 其他基础工具补充
// ══════════════════════════════════════════════════════════════════

describe('executeTool - 其他工具', () => {
  it('run_command: 应执行 shell 命令', () => {
    const result = executeTool('run_command', { command: 'echo hello' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toBe('hello');
  });

  it('run_command: 带 cwd 参数', () => {
    const result = executeTool('run_command', { command: 'pwd', cwd: tmpDir }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain(tmpDir.replace(/\/private/, '')); // macOS /private/tmp
  });

  it('move_file: 应移动文件', () => {
    const src = path.join(tmpDir, 'move-src.txt');
    const dst = path.join(tmpDir, 'move-dst.txt');
    fs.writeFileSync(src, 'move me');
    const result = executeTool('move_file', { source: src, destination: dst }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Moved');
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
  });

  it('delete_file: 应删除文件', () => {
    const p = path.join(tmpDir, 'del-test.txt');
    fs.writeFileSync(p, 'delete me');
    const result = executeTool('delete_file', { path: p }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Deleted');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('create_directory: 应递归创建目录', () => {
    const dir = path.join(tmpDir, 'deep', 'nested', 'dir');
    const result = executeTool('create_directory', { path: dir }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Created');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('search_files: 应按模式搜索', () => {
    const result = executeTool('search_files', { pattern: '*.txt', directory: homeDir }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('hello.txt');
  });

  it('save_memory: 应保存到 CLAUDE.md', () => {
    const result = executeTool('save_memory', { content: '我是 Sophi' }, homeDir, projectRoot, GROUP_ID);
    expect(result).toContain('Memory saved');
    const memPath = path.join(projectRoot, 'groups', GROUP_ID, 'CLAUDE.md');
    expect(fs.readFileSync(memPath, 'utf8')).toBe('我是 Sophi');
  });
});
