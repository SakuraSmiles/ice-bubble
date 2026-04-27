/**
 * 渠道（source_channel）检测逻辑
 * 从 Sender metadata 块中提取消息来源渠道
 */

/**
 * 检测消息是否包含 Sender metadata 块
 */
export function hasSenderMetadata(content: string): boolean {
  return content.startsWith('Sender (untrusted metadata)');
}

/**
 * 从 Sender metadata 块中提取 source_channel
 * 匹配 JSON 中的 "label" 字段
 */
export function extractSourceChannel(content: string): string | null {
  const senderMatch = content.match(/```json\s*\{[\s\S]*?"label"\s*:\s*"([^"]+)"[\s\S]*?\}\s*```/);
  return senderMatch ? senderMatch[1] : null;
}

/**
 * 从包含 Sender metadata 的消息中提取实际内容
 * 移除 Sender metadata 块和时间戳前缀
 */
export function extractContentAfterSenderMetadata(content: string): string {
  const pattern = /^Sender \(untrusted metadata\):\n```json\n[\s\S]*?\n```\n*\n*/;
  const afterMeta = content.replace(pattern, '').trim();
  const afterTime = afterMeta.replace(/^\[[^\]]+\]\s*/, '').trim();
  return afterTime || content;
}
