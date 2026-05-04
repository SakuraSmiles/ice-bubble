/**
 * ice-bubble Admin - Session Preferences API
 *
 * 会话偏好管理 API（侧栏置顶/隐藏）
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Database as DatabaseType } from 'better-sqlite3';
import { logger } from '../utils/index.js';

export interface SessionPreferencesRouterConfig {
  db: DatabaseType;
}

export interface SessionPreferencesData {
  pinned: string[];
  hidden: string[];
}

export function createSessionPreferencesRouter(config: SessionPreferencesRouterConfig): Router {
  const { db } = config;
  const router = Router();

  // ── GET /api/session-preferences ──
  router.get('/session-preferences', (_req: Request, res: Response) => {
    const row = db
      .prepare(`SELECT pinned, hidden, updated_at FROM session_preferences WHERE user_key = 'default'`)
      .get() as { pinned: string; hidden: string; updated_at: string } | undefined;

    if (!row) {
      res.json({ pinned: [], hidden: [] });
      return;
    }

    let pinned: string[] = [];
    let hidden: string[] = [];
    try {
      pinned = JSON.parse(row.pinned || '[]');
      hidden = JSON.parse(row.hidden || '[]');
    } catch {
      logger.warn('[SessionPreferences] Invalid JSON in preferences, resetting');
    }

    res.json({ pinned, hidden, updated_at: row.updated_at });
  });

  // ── PUT /api/session-preferences ──
  router.put('/session-preferences', (req: Request, res: Response) => {
    const { pinned, hidden } = req.body;

    if (!Array.isArray(pinned) || !Array.isArray(hidden)) {
      res.status(400).json({ error: 'pinned and hidden must be arrays' });
      return;
    }

    const pinnedJson = JSON.stringify(pinned);
    const hiddenJson = JSON.stringify(hidden);

    const existing = db
      .prepare(`SELECT id FROM session_preferences WHERE user_key = 'default'`)
      .get() as { id: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE session_preferences SET pinned = ?, hidden = ?, updated_at = datetime('now') WHERE id = ?
      `).run(pinnedJson, hiddenJson, existing.id);
    } else {
      db.prepare(`
        INSERT INTO session_preferences (user_key, pinned, hidden) VALUES ('default', ?, ?)
      `).run(pinnedJson, hiddenJson);
    }

    logger.info(`[SessionPreferences] Updated: pinned=${pinned.length}, hidden=${hidden.length}`);
    res.json({ pinned, hidden });
  });

  return router;
}
