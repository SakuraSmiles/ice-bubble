/**
 * Session helpers — 分段摘要算法与工具函数
 */

/**
 * 将 ISO UTC 时间戳转为北京时间 HH:MM
 */
export function toBeijingTime(isoTimestamp: string): string {
  const dt = new Date(isoTimestamp);
  const beijing = new Date(dt.getTime() + 8 * 60 * 60 * 1000);
  return `${String(beijing.getHours()).padStart(2, '0')}:${String(beijing.getMinutes()).padStart(2, '0')}`;
}

export interface RawMessage {
  id: number;
  type: string;
  content: string | null;
  timestamp: string;
  beijing_time?: string;
}

export interface Segment {
  index: number;
  from: string;
  to: string;
  messages?: RawMessage[];
  needs_regenerate?: boolean;
  text?: string;
  existing_text?: string;
}

/**
 * 分段规则常量
 */
export const SEG_RULES = {
  idleThresholdMs: 2 * 60 * 60 * 1000,      // 2 小时空闲
  minSegmentDurationMs: 15 * 60 * 1000,      // 最小段 15 分钟
  maxMessagesPerSegment: 80,
  maxSegmentDurationMs: 4 * 60 * 60 * 1000, // 最大段 4 小时
} as const;

/**
 * 分段算法：将消息数组按规则切分为段
 * 边界优先在 user 消息处切割
 */
export function segmentMessages(messages: RawMessage[]): Segment[] {
  if (messages.length === 0) return [];

  const segments: Segment[] = [];
  let current: RawMessage[] = [];
  let segStartTs: number | null = null;
  let lastUserTs: number | null = null;

  function pushSegment() {
    if (current.length === 0) return;
    const from = toBeijingTime(current[0].timestamp);
    const to = toBeijingTime(current[current.length - 1].timestamp);
    segments.push({
      index: segments.length,
      from,
      to,
      messages: [...current],
    });
    current = [];
    segStartTs = null;
    lastUserTs = null;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTs = new Date(msg.timestamp).getTime();

    if (msg.type !== 'user') {
      current.push(msg);
      continue;
    }

    // 非首条 user 消息 → 判断是否分段
    if (segStartTs !== null) {
      const timeSinceSegStart = msgTs - segStartTs!;
      const timeSinceLastUser = msgTs - lastUserTs!;
      let shouldSplit = false;

      // 规则 1: 空闲 > 2h + 规则 2: 最小段时长 >= 15min
      if (timeSinceLastUser > SEG_RULES.idleThresholdMs && timeSinceSegStart >= SEG_RULES.minSegmentDurationMs) {
        shouldSplit = true;
      }
      // 规则 3: 容量超限
      if (current.length >= SEG_RULES.maxMessagesPerSegment) {
        shouldSplit = true;
      }
      // 规则 4: 时长超限
      if (timeSinceSegStart >= SEG_RULES.maxSegmentDurationMs) {
        shouldSplit = true;
      }

      if (shouldSplit) {
        pushSegment();
      }
    }

    current.push(msg);
    if (segStartTs === null) segStartTs = msgTs;
    lastUserTs = msgTs;
  }

  if (current.length > 0) pushSegment();
  return segments;
}

/**
 * 增量合并：将新分段与已有 summary 段落合并
 */
export function mergeWithExisting(newSegments: Segment[], existingSummary: string | null): Segment[] {
  if (!existingSummary || newSegments.length === 0) return newSegments;

  let existingSegments: Segment[] = [];
  try {
    const parsed = JSON.parse(existingSummary);
    if (parsed.segments) {
      existingSegments = parsed.segments;
    }
  } catch {
    // 解析失败，视为无已有段落
  }

  if (existingSegments.length === 0) return newSegments;

  // 检查新第一段与已有最后一段的间隔
  const lastExisting = existingSegments[existingSegments.length - 1];
  const lastEndTime = parseHHMM(lastExisting.to);
  const firstNewStart = parseHHMM(newSegments[0].from);

  // 计算分钟差（处理跨天情况：如果间隔 > 12h 视为跨天）
  let gapMinutes = firstNewStart - lastEndTime;
  if (gapMinutes < 0) gapMinutes += 24 * 60; // 跨天

  if (gapMinutes < SEG_RULES.idleThresholdMs / (60 * 1000)) {
    // 合并到最后一段
    const mergedLast: Segment & { messages?: RawMessage[] } = {
      index: 0,
      from: lastExisting.from,
      to: newSegments[0].to,
      messages: undefined,
      needs_regenerate: true,
      text: lastExisting.text,
      existing_text: lastExisting.text,
    };

    const result = existingSegments.slice(0, -1).map(s => ({ ...s }));
    mergedLast.index = result.length;
    result.push(mergedLast);

    // 剩余新段追加
    for (let i = 1; i < newSegments.length; i++) {
      const seg = { ...newSegments[i], index: result.length };
      result.push(seg);
    }
    return result;
  } else {
    // 不连续，全部追加
    const result = existingSegments.map(s => ({ ...s }));
    for (const seg of newSegments) {
      seg.index = result.length;
      result.push(seg);
    }
    return result;
  }
}

/**
 * 解析 HH:MM 字符串为当天分钟数
 */
function parseHHMM(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ============================================================================
// 智能截断函数
// ============================================================================

/**
 * 去掉消息时间戳前缀 [Mon 2026-05-18 08:21 GMT+8]
 */
export function stripTimestampPrefix(msg: string | null): string {
  if (!msg) return '';
  return msg.replace(/^\[[^\]]+\]\s*/, '');
}

/**
 * 从文本中提取第一个 ## 或 ### 标题（用于 subagent 任务标题）
 */
export function extractTaskTitle(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/^##\s+(.+)$/m) || text.match(/^###\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * 智能截断文本，优先在段落/行/句子边界截断，避免截断 markdown 语法中间
 */
export function smartTruncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text ?? '';

  const searchLen = maxLen + 50; // 多看 50 字符找边界
  const window = text.slice(0, Math.min(text.length, searchLen));

  // 1. 段落边界
  const paraIdx = window.lastIndexOf('\n\n', maxLen);
  if (paraIdx > maxLen * 0.4) {
    const trimmed = window.slice(0, paraIdx).replace(/\n+$/, '');
    if (trimmed.length > 0) return trimmed + '…';
  }

  // 2. 行边界
  const lineIdx = window.lastIndexOf('\n', maxLen);
  if (lineIdx > maxLen * 0.4) {
    return window.slice(0, lineIdx).replace(/\n+$/, '') + '…';
  }

  // 3. 句子边界
  const sentenceMatch = window.slice(0, maxLen + 50).match(/[。！？.!?]/g);
  if (sentenceMatch) {
    // 从 maxLen 附近往前找最近的句子结尾
    const re = /[。！？.!?]/g;
    let m: RegExpExecArray | null;
    let lastPos = -1;
    while ((m = re.exec(window)) !== null) {
      if (m.index <= maxLen) lastPos = m.index;
      else break;
    }
    if (lastPos > maxLen * 0.4) {
      return window.slice(0, lastPos + 1) + '…';
    }
  }

  // 4. 检查 markdown 语法完整性：避免在 ** 或 ` 中间截断
  let cutAt = maxLen;
  // 检查未闭合的 **
  const boldCount = (window.slice(0, cutAt).match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    // 往前找最近的 ** 开头，在其之前截断
    const lastBold = window.slice(0, cutAt).lastIndexOf('**');
    if (lastBold > 0 && lastBold > maxLen * 0.4) {
      cutAt = lastBold;
    }
  }
  // 检查未闭合的 `
  const backtickCount = (window.slice(0, cutAt).match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) {
    const lastTick = window.slice(0, cutAt).lastIndexOf('`');
    if (lastTick > 0 && lastTick > maxLen * 0.4) {
      cutAt = lastTick;
    }
  }

  return window.slice(0, cutAt) + '…';
}
