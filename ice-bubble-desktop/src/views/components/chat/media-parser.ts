/**
 * media-parser.ts
 *
 * 统一解析聊天消息中的附件/图片，支持两种来源：
 * 1. `[media attached: /path/to/inbound/xxx.png (image/png)]` — Gateway offload 大图片标记（实际格式）
 * 2. `[media attached: media://inbound/<id>]` — Gateway offload 大图片标记（兼容格式）
 * 3. 无标记的 inline images — 从 Gateway history 消息的 `images` 字段提取
 */

/**
 * 从 `[media attached:]` 标记中解析出的单个附件
 */
export interface MediaAttachment {
  /** 附件路径（完整文件路径或 media:// URI） */
  path: string;
  /** 从路径中提取的文件名（不含目录） */
  fileName: string;
  /** MIME 类型（从末尾 (image/png) 解析，如无则为 null） */
  mimeType: string | null;
  /** 多图时的序号（1-based），单张图片无此字段 */
  index?: number;
  /** 多图时的总数，单张图片无此字段 */
  total?: number;
}

/**
 * 从 Gateway history 消息 `images` 字段提取的内联图片
 */
export interface InlineImage {
  /** data URL，如 `data:image/png;base64,xxxxx` */
  dataUrl: string;
}

/**
 * 统一附件类型，合并两种来源
 */
export interface ParsedAttachment {
  /** 附件来源类型 */
  type: 'media_ref' | 'inline';
  /** 媒体 ID（type=media_ref 时存在） */
  mediaId?: string;
  /** data URL（type=inline 时存在） */
  dataUrl?: string;
  /** 完整 media 引用（type=media_ref 时存在） */
  mediaRef?: string;
}

/**
 * 从消息文本中解析 `[media attached:]` 标记，返回附件列表。
 *
 * 支持格式：
 * - 单张：`[media attached: media://inbound/abc123]`
 * - 多张：`[media attached 1/3: media://inbound/abc123]`
 * - 多文件简写：`[media attached: 3 files]`（不含 ID，自动跳过）
 *
 * @param text - 消息文本内容
 * @returns 解析到的附件列表
 */
export function parseMediaAttached(text: string): MediaAttachment[] {
  const results: MediaAttachment[] = [];
  // 兼容两种格式：
  // 格式1（实际）：[media attached: /path/to/inbound/xxx.png (image/png)]
  // 格式2（兼容）：[media attached: media://inbound/abc123]
  // 多张：[media attached 1/3: ...]
  // 多文件简写：[media attached: 3 files] — 跳过
  // 匹配 [media attached...] 标记，支持文件路径和 media:// URI 两种格式
  const regex = new RegExp(
    '\\[media attached(?:\\s+\\d+\\/\\d+)?:\\s*((?:media:\\/\\/inbound\\/[\\w.-]+|\\/[^\\]\\(]+?))(?:\\s+\\((\\w+\\/\\w+)\\))?\\]',
    'gi',
  );
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const rawPath = match[1].trim();
    // 跳过非路径内容（如 "3 files"）
    if (/^\d+\s+files?$/i.test(rawPath)) continue;
    // 跳过无效路径
    if (!rawPath) continue;

    const fileName = rawPath.split('/').pop() || rawPath;
    const mimeType = match[2] || null;

    const indexTotalMatch = match[0].match(/\[media attached\s+(\d+)\/(\d+):/i);
    const entry: MediaAttachment = { path: rawPath, fileName, mimeType };
    if (indexTotalMatch) {
      entry.index = parseInt(indexTotalMatch[1], 10);
      entry.total = parseInt(indexTotalMatch[2], 10);
    }
    results.push(entry);
  }

  return results;
}

/**
 * 从消息文本中移除所有 `[media attached:]` 标记行，返回纯文本内容。
 *
 * 一整行如果只包含 `[media attached...]` 标记则整行移除；
 * 如果标记嵌入在其他文字中间，则仅移除标记部分。
 *
 * @param text - 消息文本内容
 * @returns 移除标记后的纯文本
 */
export function stripMediaAttachedMarkers(text: string): string {
  // 移除整行匹配 `[media attached...]` 的行（可能前后有空白）
  const cleaned = text.replace(/^\s*\[media attached[^\]]*\]\s*\n?/gm, '');
  // 移除嵌入在文字中的标记（兜底）
  return cleaned.replace(/\[media attached[^\]]*\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从 Gateway history 消息对象中提取 inline images。
 *
 * Gateway 消息格式参考：
 * ```json
 * { "role": "user", "content": "文本", "images": ["base64data1"], "imageOrder": ["inline"] }
 * ```
 *
 * @param message - Gateway chat.history 返回的消息对象
 * @returns 内联图片列表
 */
export function detectInlineImages(message: { images?: string[] }): InlineImage[] {
  const images: string[] = message?.images ?? [];
  if (!Array.isArray(images) || images.length === 0) return [];

  return images.map((b64) => {
    // 如果已经是完整 data URL 则直接使用
    if (b64.startsWith('data:')) {
      return { dataUrl: b64 };
    }
    // 否则包装为 data URL（默认 PNG）
    return { dataUrl: `data:image/png;base64,${b64}` };
  });
}

/**
 * 统一入口：同时解析 `[media attached:]` 标记和 inline images，返回合并后的附件列表。
 *
 * @param message - Gateway 消息对象，需至少包含 `content` 字段；可选 `images` 字段
 * @returns 合并后的附件列表（media_ref 在前，inline 在后）
 */
export function parseAllAttachments(message: { content?: string; images?: string[] }): ParsedAttachment[] {
  const text = message?.content ?? '';
  const results: ParsedAttachment[] = [];

  // 解析 media attached 标记
  const mediaAttachments = parseMediaAttached(text);
  for (const ma of mediaAttachments) {
    results.push({
      type: 'media_ref',
      mediaId: ma.fileName,
      mediaRef: ma.path,
    });
  }

  // 解析 inline images
  const inlineImages = detectInlineImages(message);
  for (const img of inlineImages) {
    results.push({
      type: 'inline',
      dataUrl: img.dataUrl,
    });
  }

  return results;
}
