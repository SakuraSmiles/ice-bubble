/**
 * ice-bubble Admin - Session Groups API
 *
 * 会话分组管理 API
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { GatewayProxy } from '../gateway/index.js';
import { logger } from '../utils/index.js';

export interface SessionGroupsRouterConfig {
  db: DatabaseType;
  gatewayProxy?: GatewayProxy | null;
}

export function createSessionGroupsRouter(config: SessionGroupsRouterConfig): Router {
  const { db, gatewayProxy } = config;
  const router = Router();

  // ── GET /api/session-groups ──
  router.get('/session-groups', (_req: Request, res: Response) => {
    const groups = db
      .prepare(`SELECT id, name, icon, sort_order, created_at, updated_at FROM session_groups ORDER BY sort_order ASC, id ASC`)
      .all() as Array<Record<string, unknown>>;

    // Load members for each group
    const membersStmt = db.prepare(
      `SELECT id, group_id, session_key, sort_order, created_at FROM session_group_members ORDER BY sort_order ASC, id ASC`
    );
    const allMembers = membersStmt.all() as Array<{ group_id: number; session_key: string; sort_order: number; id: number; created_at: string }>;

    const memberMap = new Map<number, typeof allMembers>();
    for (const m of allMembers) {
      const list = memberMap.get(m.group_id) || [];
      list.push(m);
      memberMap.set(m.group_id, list);
    }

    const result = groups.map((g) => ({
      ...g,
      members: memberMap.get(g.id as number) || [],
    }));

    res.json({ groups: result });
  });

  // ── POST /api/session-groups ──
  router.post('/session-groups', (req: Request, res: Response) => {
    const { name, icon } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const stmt = db.prepare(
      `INSERT INTO session_groups (name, icon, sort_order) VALUES (?, ?, 0)`
    );
    const info = stmt.run(name, icon || '📁');
    const group = db
      .prepare(`SELECT * FROM session_groups WHERE id = ?`)
      .get(info.lastInsertRowid) as Record<string, unknown>;

    logger.info(`[SessionGroups] Group created: ${name} (id=${info.lastInsertRowid})`);
    res.status(201).json({ group, members: [] });
  });

  // ── PATCH /api/session-groups/:id ──
  router.patch('/session-groups/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const existing = db.prepare(`SELECT * FROM session_groups WHERE id = ?`).get(id);
    if (!existing) {
      res.status(404).json({ error: 'group not found' });
      return;
    }

    const { name, icon, sort_order } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }

    if (updates.length === 0) {
      res.status(400).json({ error: 'no fields to update' });
      return;
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE session_groups SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const group = db.prepare(`SELECT * FROM session_groups WHERE id = ?`).get(id) as Record<string, unknown>;

    // Load members
    const members = db
      .prepare(`SELECT * FROM session_group_members WHERE group_id = ? ORDER BY sort_order ASC, id ASC`)
      .all(id) as Array<Record<string, unknown>>;

    logger.info(`[SessionGroups] Group updated: id=${id}`);
    res.json({ group, members });
  });

  // ── DELETE /api/session-groups/:id ──
  router.delete('/session-groups/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const existing = db.prepare(`SELECT * FROM session_groups WHERE id = ?`).get(id);
    if (!existing) {
      res.status(404).json({ error: 'group not found' });
      return;
    }

    db.prepare(`DELETE FROM session_group_members WHERE group_id = ?`).run(id);
    db.prepare(`DELETE FROM session_groups WHERE id = ?`).run(id);

    logger.info(`[SessionGroups] Group deleted: id=${id}`);
    res.json({ success: true });
  });

  // ── POST /api/session-groups/:id/members ──
  router.post('/session-groups/:id/members', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid group id' });
      return;
    }

    const group = db.prepare(`SELECT * FROM session_groups WHERE id = ?`).get(id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }

    const { session_key, sort_order } = req.body;
    if (!session_key || typeof session_key !== 'string') {
      res.status(400).json({ error: 'session_key is required' });
      return;
    }

    const stmt = db.prepare(
      `INSERT OR IGNORE INTO session_group_members (group_id, session_key, sort_order) VALUES (?, ?, ?)`
    );
    stmt.run(id, session_key, sort_order ?? 0);

    const member = db
      .prepare(`SELECT * FROM session_group_members WHERE group_id = ? AND session_key = ?`)
      .get(id, session_key) as Record<string, unknown>;

    logger.info(`[SessionGroups] Member added: group=${id}, session=${session_key}`);
    res.status(201).json({ member });
  });

  // ── DELETE /api/session-groups/:id/members/:sessionKey ──
  router.delete('/session-groups/:id/members/:sessionKey', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const sessionKey = req.params.sessionKey;
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid group id' });
      return;
    }

    const result = db
      .prepare(`DELETE FROM session_group_members WHERE group_id = ? AND session_key = ?`)
      .run(id, sessionKey);

    if (result.changes === 0) {
      res.status(404).json({ error: 'member not found' });
      return;
    }

    logger.info(`[SessionGroups] Member removed: group=${id}, session=${sessionKey}`);
    res.json({ success: true });
  });

  // ── POST /api/sessions (create via Gateway RPC) ──
  router.post('/sessions', async (req: Request, res: Response) => {
    const { agentId, key, label } = req.body;
    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    if (!gatewayProxy) {
      res.status(503).json({ error: 'Gateway not available' });
      return;
    }

    try {
      const result = await gatewayProxy.request<Record<string, unknown>>('sessions.create', {
        agentId,
        key: key || undefined,
        label: label || undefined,
      });
      logger.info(`[SessionGroups] Session created via Gateway: agent=${agentId}`);
      res.status(201).json(result);
    } catch (err) {
      logger.error('[SessionGroups] sessions.create failed', { error: err });
      res.status(502).json({ error: 'Gateway request failed' });
    }
  });

  return router;
}
