/**
 * AttachmentStorage — 保存用户发送的图片附件到磁盘 + DB 记录
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { Logger } from '../../utils/logger.js';

const logger = new Logger('AttachmentStorage');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface AttachmentInput {
  type: string;
  mimeType: string;
  fileName?: string;
  content: string; // base64
}

export interface AttachmentRecord {
  id: string;
  session_key: string;
  message_content: string | null;
  file_path: string;
  mime_type: string;
  file_size: number;
  created_at: string;
}

const EXT_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export class AttachmentStorage {
  private dir: string;
  private db: Database;

  constructor(attachmentsDir: string, db: Database) {
    this.dir = attachmentsDir;
    this.db = db;
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 保存附件（fire-and-forget 风格，调用方无需 await）
   */
  async saveAttachments(sessionKey: string, attachments: AttachmentInput[], messageContent?: string): Promise<void> {
    if (!sessionKey || !Array.isArray(attachments) || attachments.length === 0) return;

    for (const att of attachments) {
      if (att.type !== 'image' || !att.content) continue;
      try {
        this.saveOne(sessionKey, att, messageContent);
      } catch (err) {
        logger.warn('[AttachmentStorage] Failed to save attachment', {
          error: err instanceof Error ? err.message : String(err),
          fileName: att.fileName,
        });
      }
    }
  }

  private saveOne(sessionKey: string, att: AttachmentInput, messageContent?: string): void {
    const buffer = Buffer.from(att.content, 'base64');
    if (buffer.length > MAX_FILE_SIZE) {
      logger.warn('[AttachmentStorage] Attachment too large, skipping', { size: buffer.length });
      return;
    }

    const ext = EXT_MAP[att.mimeType] || 'bin';
    const fileName = `${Date.now()}_${randomUUID().replace(/-/g, '').substring(0, 8)}.${ext}`;
    const filePath = join(this.dir, fileName);
    writeFileSync(filePath, buffer);

    const id = randomUUID();
    const contentSnippet = (messageContent || '').substring(0, 100);
    this.db.prepare(`
      INSERT INTO attachments (id, session_key, message_content, file_path, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionKey, contentSnippet, fileName, att.mimeType, buffer.length);

    logger.info('[AttachmentStorage] Saved', { id, fileName, size: buffer.length });
  }

  /**
   * 查询某条消息关联的附件
   */
  getAttachments(sessionKey: string): AttachmentRecord[] {
    return this.db.prepare(`
      SELECT * FROM attachments WHERE session_key = ? ORDER BY created_at DESC
    `).all(sessionKey) as AttachmentRecord[];
  }

  /**
   * 按 session_key + 时间窗口（±30秒）查询附件
   */
  getAttachmentsByTimestamp(sessionKey: string, messageTimestamp: string): AttachmentRecord[] {
    const msgTime = new Date(messageTimestamp).getTime();
    if (isNaN(msgTime)) return [];
    const from = new Date(msgTime - 30_000).toISOString();
    const to = new Date(msgTime + 30_000).toISOString();
    return this.db.prepare(`
      SELECT * FROM attachments WHERE session_key = ? AND created_at BETWEEN ? AND ?
      ORDER BY created_at DESC
    `).all(sessionKey, from, to) as AttachmentRecord[];
  }
}
