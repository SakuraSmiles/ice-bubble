/**
 * Cron 检测逻辑
 * 检测消息是否为定时任务（[cron:...] 格式）
 */

/**
 * 检测消息内容是否为 cron 格式
 */
export function isCronMessage(content: string): boolean {
  return content.startsWith('[cron:');
}

/**
 * 从 cron 消息中提取实际内容
 * 输入: "[cron:0 30 9 * * ?] 实际任务内容"
 * 输出: "实际任务内容"
 */
export function extractCronContent(content: string): string {
  if (!isCronMessage(content)) return content;
  const cronEnd = content.indexOf(']');
  const afterCron = cronEnd > 0 ? content.substring(cronEnd + 1).trim() : content;
  return afterCron || content;
}
