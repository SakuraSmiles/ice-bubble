/**
 * Session Chain 端点 — GET /api/sessions/chain
 *
 * 根据当前 session key，找出同一 agent 的连续对话链。
 * 算法：时间连续性 + agent_id 匹配 + user_msgs ≥ min_user_messages。
 */

import { Router, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import type { SessionsRouterConfig } from './index.js';

interface ChainSession {
  session_key: string;
  agent_id: string;
  agent_name: string | null;
  avatar: string | null;
  channel: string | null;
  message_count: number;
  user_message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  first_message: string | null;
  label: string | null;
}

interface SessionChainResponse {
  current: ChainSession;
  chain: ChainSession[];
  currentIndex: number;
  has_older: boolean;
}

/** 解析 agent_id from session key (Gateway 或 SQLite 格式) */
function extractAgentId(sessionKey: string): string | null {
  // Gateway 格式: "agent:main:main" 或 "agent:main:webchat:xxx"
  // SQLite 格式: "ses_agent_main_main_..." 或 "ses_agent_main_webchat_xxx_..."
  const gwMatch = sessionKey.match(/^agent:([^:]+)/);
  if (gwMatch) return gwMatch[1];

  const sqlMatch = sessionKey.match(/^ses_agent_([^_]+)/);
  if (sqlMatch) return sqlMatch[1];

  return null;
}

export function createChainRouter(config: SessionsRouterConfig): Router {
  const { repository } = config;
  const db: Database = repository.getDb();
  const router = Router();

  router.get('/sessions/chain', (req: Request, res: Response) => {
    const sessionKey = req.query.session_key ? String(req.query.session_key) : undefined;
    if (!sessionKey) {
      res.status(400).json({ error: 'session_key is required' });
      return;
    }

    const maxChainLength = Math.min(parseInt(String(req.query.max_chain_length ?? '5')), 10);
    const minUserMessages = Math.max(parseInt(String(req.query.min_user_messages ?? '2')), 1);
    const maxGapHours = Math.max(parseInt(String(req.query.max_gap_hours ?? '24')), 1);

    const agentId = extractAgentId(sessionKey);
    if (!agentId) {
      res.json({ current: null, chain: [], currentIndex: -1, has_older: false });
      return;
    }

    // 查同 agent 所有有实质对话的 session
    const candidateRows = db.prepare(`
      SELECT
        s.session_key,
        s.agent_id,
        a.agent_name,
        a.avatar,
        s.channel,
        s.message_count,
        s.first_message_at,
        s.last_message_at,
        s.label,
        (SELECT COUNT(*) FROM admin_messages m
         WHERE m.session_key = s.session_key
           AND m.message_type = 'user'
           AND m.content IS NOT NULL AND m.content != ''
           AND m.content NOT LIKE 'Sender (untrusted metadata)%'
           AND m.content NOT LIKE 'System (untrusted):%'
           AND m.content NOT LIKE 'System:%'
           AND instr(m.content, '[Subagent Context]') = 0
        ) as user_message_count,
        (SELECT m.content FROM admin_messages m
         WHERE m.session_key = s.session_key AND m.message_type = 'user'
           AND m.content IS NOT NULL AND m.content != ''
           AND m.content NOT LIKE 'Sender (untrusted metadata)%'
           AND m.content NOT LIKE 'System (untrusted):%'
           AND m.content NOT LIKE 'System:%'
           AND instr(m.content, '[Subagent Context]') = 0
         ORDER BY m.timestamp ASC LIMIT 1
        ) as first_message
      FROM admin_sessions s
      LEFT JOIN admin_agents a ON a.agent_id = s.agent_id
      WHERE s.agent_id = ?
        AND s.session_key NOT LIKE '%.trajectory'
        AND s.session_key NOT LIKE '%.checkpoint'
        AND s.session_key NOT LIKE 'agent:daily-reporter:%'
        AND s.message_count > 1
      ORDER BY s.last_message_at DESC
    `).all(agentId) as Array<{
      session_key: string;
      agent_id: string;
      agent_name: string | null;
      avatar: string | null;
      channel: string | null;
      message_count: number;
      user_message_count: number;
      first_message_at: string | null;
      last_message_at: string | null;
      label: string | null;
      first_message: string | null;
    }>;

    // 过滤 user_message_count >= minUserMessages
    const filtered: ChainSession[] = candidateRows
      .filter(r => r.user_message_count >= minUserMessages)
      .map(r => ({
        session_key: r.session_key,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        avatar: r.avatar,
        channel: r.channel,
        message_count: r.message_count,
        user_message_count: r.user_message_count,
        first_message_at: r.first_message_at,
        last_message_at: r.last_message_at,
        label: r.label,
        first_message: r.first_message,
      }));

    // 找到当前 session 在候选中的位置
    const currentIdx = filtered.findIndex(s => s.session_key === sessionKey);
    if (currentIdx === -1) {
      // 当前 session 不在链中（可能 user_message_count 不够），返回仅当前
      res.json({ current: null, chain: [], currentIndex: -1, has_older: filtered.length > 0 });
      return;
    }

    const current = filtered[currentIdx];
    const maxGapMs = maxGapHours * 3600 * 1000;

    // 贪心向前扩展（更早的 session）
    const chainSet = new Set<string>([current.session_key]);
    let frontier = current.first_message_at ? new Date(current.first_message_at).getTime() : Date.now();

    for (let i = currentIdx + 1; i < filtered.length && chainSet.size < maxChainLength; i++) {
      const candidate = filtered[i];
      if (chainSet.has(candidate.session_key)) continue;
      if (!candidate.last_message_at) continue;

      const gap = new Date(frontier).getTime() - new Date(candidate.last_message_at).getTime();
      if (gap <= maxGapMs) {
        chainSet.add(candidate.session_key);
        if (candidate.first_message_at) {
          frontier = new Date(candidate.first_message_at).getTime();
        }
      }
    }

    // 贪心向后扩展（更新的 session）——实际上 filtered 已按 last_message_at DESC，
    // 所以 filtered[0..currentIdx-1] 就是更新的 session
    for (let i = currentIdx - 1; i >= 0 && chainSet.size < maxChainLength; i--) {
      const candidate = filtered[i];
      if (chainSet.has(candidate.session_key)) continue;
      if (!candidate.last_message_at) continue;

      // 后向扩展：检查 candidate 的开始时间与 current 的结束时间间隔
      if (current.last_message_at && candidate.first_message_at) {
        const backwardGap = new Date(candidate.first_message_at).getTime() - new Date(current.last_message_at).getTime();
        if (backwardGap <= maxGapMs) {
          chainSet.add(candidate.session_key);
        }
      } else {
        chainSet.add(candidate.session_key);
      }
    }

    // 组装链并按 first_message_at ASC 排序
    const chain = filtered.filter(s => chainSet.has(s.session_key))
      .sort((a, b) => {
        const ta = a.first_message_at ? new Date(a.first_message_at).getTime() : 0;
        const tb = b.first_message_at ? new Date(b.first_message_at).getTime() : 0;
        return ta - tb;
      });

    const sortedCurrentIndex = chain.findIndex(s => s.session_key === sessionKey);

    // has_older: 是否还有更早的候选未加入链
    const earliestInChain = chain[0]?.first_message_at;
    let hasOlder = false;
    if (earliestInChain) {
      for (const c of filtered) {
        if (chainSet.has(c.session_key)) continue;
        if (!c.last_message_at) continue;
        if (new Date(earliestInChain).getTime() - new Date(c.last_message_at).getTime() <= maxGapMs) {
          hasOlder = true;
          break;
        }
      }
    } else {
      hasOlder = filtered.length > chain.length;
    }

    const response: SessionChainResponse = {
      current,
      chain,
      currentIndex: sortedCurrentIndex,
      has_older: hasOlder,
    };

    res.json(response);
  });

  return router;
}
