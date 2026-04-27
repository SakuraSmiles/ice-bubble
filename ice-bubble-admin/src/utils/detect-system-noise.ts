/**
 * 系统噪音检测逻辑
 * 检测 user/agent/tool 消息中的系统噪音模式
 */

// ==================== User 消息噪音模式 ====================

const USER_NOISE_PATTERNS = [
  // heartbeat 响应
  { pattern: (c: string) => c === 'HEARTBEAT_OK' || c === 'NO_REPLY', label: 'heartbeat' },
  // cron 消息（整体标记为噪音，不在这里检测）
  // System: / System(...) 格式
  { pattern: (c: string) => /^System[ :(]/.test(c) && c.length > 10, label: 'system-exec' },
  // Read HEARTBEAT.md
  { pattern: (c: string) => /^Read HEARTBEAT\.md/.test(c), label: 'heartbeat-poll' },
  // Exec completed/failed
  { pattern: (c: string) => /^(Exec completed|Exec failed)/.test(c), label: 'exec-notify' },
  // git commit / 编译输出
  { pattern: (c: string) => /^\[[a-z0-9]+\]/.test(c) && (/(added \d+ files?|modules transformed|built in)/.test(c) || /^(feat|fix|style|refactor|chore|docs|test)\(/.test(c)), label: 'git-compile' },
  // 异步命令完成
  { pattern: (c: string) => c.startsWith('An async command completion event was triggered'), label: 'async-complete' },
  // 预压缩内存写入
  { pattern: (c: string) => c.startsWith('Pre-compaction memory flush'), label: 'memory-flush' },
  // OpenClaw 内部上下文
  { pattern: (c: string) => c.startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'), label: 'internal-context' },
];

/**
 * 检测 user 消息是否为系统噪音
 */
export function isUserSystemNoise(content: string): boolean {
  // [date] 前缀检测（需先移除日期前缀再判断）
  if (/^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2}/.test(content)) {
    const afterDate = content.replace(/^\[[^\]]+\]\s*/, '').trim();
    if (!afterDate || afterDate === 'HEARTBEAT_OK' || afterDate === 'NO_REPLY') return true;
    // 有内容但仍是 [date] 格式的截断版，视为噪音
    return true;
  }

  for (const { pattern } of USER_NOISE_PATTERNS) {
    if (pattern(content)) return true;
  }
  return false;
}

/**
 * 清洗 user 消息内容，移除系统噪音部分
 */
export function cleanUserContent(content: string): string {
  // [cron:...] 格式
  if (content.startsWith('[cron:')) {
    const cronEnd = content.indexOf(']');
    return cronEnd > 0 ? content.substring(cronEnd + 1).trim() : content;
  }
  // System: / System(...) 格式
  if (/^System[ :(]/.test(content) && content.length > 10) {
    return content.replace(/^System[ :]\([^)]*\)/g, '').replace(/^System[ :]/g, '').trim() || content.substring(0, 150);
  }
  // Read HEARTBEAT.md
  if (/^Read HEARTBEAT\.md/.test(content)) {
    return content.substring(0, 100);
  }
  // Exec completed/failed
  if (/^(Exec completed|Exec failed)/.test(content)) {
    return content.substring(0, 100);
  }
  // git/编译输出
  if (/^\[[a-z0-9]+\]/.test(content) && (/(added \d+ files?|modules transformed|built in)/.test(content) || /^(feat|fix|style|refactor|chore|docs|test)\(/.test(content))) {
    return content.substring(0, 100);
  }
  // 其他带 [date] 前缀的消息
  if (/^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[^\]]*\] /.test(content)) {
    const afterDate = content.replace(/^\[[^\]]+\]\s*/, '').trim();
    return afterDate;
  }
  return content;
}

// ==================== Agent 消息噪音模式 ====================

const AGENT_NOISE_PATTERNS = [
  { pattern: (c: string) => !c || c === 'NULL' || c === '', label: 'null-empty' },
  { pattern: (c: string) => c === 'HEARTBEAT_OK', label: 'heartbeat' },
  { pattern: (c: string) => /^(暂无活跃子任务|任务状态巡检完成)/.test(c), label: 'task-status' },
];

/**
 * 检测 agent 消息是否为系统噪音
 */
export function isAgentSystemNoise(content: string | null): boolean {
  for (const { pattern } of AGENT_NOISE_PATTERNS) {
    if (pattern(content || '')) return true;
  }
  return false;
}

// ==================== Tool 消息噪音模式 ====================

const TOOL_EMPTY_VALUES = ['{}', '[]', 'ok', 'null'];

/**
 * 检测 tool 消息是否为空噪音
 */
export function isToolSystemNoise(content: string | null): boolean {
  if (!content || content === 'NULL' || content === '') return true;
  return TOOL_EMPTY_VALUES.includes(content);
}
