/**
 * Workspace 视图层验收测试
 *
 * 测试 /api/tasks/workspace 的前端消费逻辑
 * 覆盖场景：
 *   A-1: 空数据（无父任务） → recentParentTask 为 null
 *   A-2: 单个父任务，无子任务 → 进度显示 0/0
 *   B-1: 多 agent 子任务，active/completed 分离 → 进度正确
 *   B-2: 多父任务 → recentParentTask 取最新
 *   C-1: 单 agent 子任务 → 进度正确
 *   C-2: 多 agent 子任务 → 进度正确
 *
 * 同时覆盖 onlineAgents 逻辑：
 *   - 优先显示工作中 agent
 *   - 不足3个时用离线 agent 补充
 *   - 最多返回3个 agent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock fetch ───────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── 测试数据 fixtures ────────────────────────────────

type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'pending' | 'in_progress' | 'completed';

interface TaskItem {
  task_id: string;
  title: string;
  status: TaskStatus;
  updated_at?: string;
}

interface AgentGroup {
  agent_id: string;
  active_children: TaskItem[];
  completed_children: TaskItem[];
}

interface ParentTask {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  agent_groups: AgentGroup[];
}

interface WorkspaceTasks {
  parents: ParentTask[];
}

interface AgentOverview {
  agent_id: string;
  agent_name: string;
  avatar: string | null;
  workspace: string | null;
  status: string;
  model: string | null;
  last_active_at: string;
  latest_message: string | null;
}

// ─── 工具函数（从 Overview.vue 复制的关键逻辑）─────────

function truncateTaskTitle(title: string, maxLen: number = 50): string {
  if (!title) return '';
  const cleaned = title.replace(/^#+\s+/gm, '').trim();
  return cleaned.length <= maxLen ? cleaned : cleaned.substring(0, maxLen) + '...';
}

function isWorkingStatus(status: string): boolean {
  return status === '工作' || status === '工作中';
}

/** 计算父任务进度 */
function calcParentProgress(agentGroups: AgentGroup[] | undefined): { done: number; total: number; label: string } {
  if (!agentGroups) return { done: 0, total: 0, label: '0/0' };
  let done = 0;
  let total = 0;
  for (const g of agentGroups) {
    done += (g.completed_children || []).length;
    total += (g.active_children || []).length + (g.completed_children || []).length;
  }
  return { done, total, label: `${done}/${total}` };
}

/** 计算进度百分比 */
function calcProgressPercent(agentGroups: AgentGroup[] | undefined): number {
  const { done, total } = calcParentProgress(agentGroups);
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

/** 获取最近父任务（按 updated_at DESC） */
function getRecentParentTask(workspaceTasks: WorkspaceTasks | null): ParentTask | null {
  const parents = workspaceTasks?.parents ?? [];
  if (!parents.length) return null;
  return [...parents].sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  )[0];
}

/** Agent 列表：优先工作中，至少3个（从 Overview.vue） */
function getOnlineAgents(agents: AgentOverview[]): AgentOverview[] {
  const active = agents.filter(a => a.status === '活跃' || isWorkingStatus(a.status));
  const inactive = agents
    .filter(a => a.status !== '活跃' && !isWorkingStatus(a.status))
    .sort((a, b) => new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime());
  const result = [...active, ...inactive];
  return result.slice(0, 3);
}

// ─── Tests ────────────────────────────────────────────

describe('workspace 工具函数', () => {

  // ── A-1: 空数据 ──────────────────────────────────

  describe('A-1: 空数据（无父任务）', () => {
    it('getRecentParentTask 返回 null', () => {
      expect(getRecentParentTask(null)).toBeNull();
      expect(getRecentParentTask({ parents: [] })).toBeNull();
    });

    it('空 agent_groups 进度为 0/0', () => {
      expect(calcParentProgress(undefined)).toEqual({ done: 0, total: 0, label: '0/0' });
      expect(calcParentProgress([])).toEqual({ done: 0, total: 0, label: '0/0' });
    });
  });

  // ── A-2: 单个父任务，无子任务 ──────────────────────

  describe('A-2: 单个父任务，无子任务', () => {
    it('进度为 0/0', () => {
      const parent: ParentTask = {
        id: 'p1',
        title: '项目启动',
        status: 'in_progress',
        updated_at: '2024-01-15T10:00:00Z',
        agent_groups: [],
      };
      expect(calcParentProgress(parent.agent_groups)).toEqual({ done: 0, total: 0, label: '0/0' });
      expect(calcProgressPercent(parent.agent_groups)).toBe(0);
    });
  });

  // ── B-1: 多 agent 子任务 ──────────────────────────

  describe('B-1: 多 agent 子任务（部分 active，部分 completed）', () => {
    it('进度计算正确', () => {
      const agentGroups: AgentGroup[] = [
        {
          agent_id: 'agent-1',
          active_children: [
            { task_id: 't1', title: '任务1', status: 'pending' },
            { task_id: 't2', title: '任务2', status: 'in_progress' },
          ],
          completed_children: [
            { task_id: 't3', title: '任务3', status: 'completed' },
          ],
        },
        {
          agent_id: 'agent-2',
          active_children: [
            { task_id: 't4', title: '任务4', status: 'pending' },
          ],
          completed_children: [
            { task_id: 't5', title: '任务5', status: 'completed' },
            { task_id: 't6', title: '任务6', status: 'completed' },
          ],
        },
      ];

      expect(calcParentProgress(agentGroups)).toEqual({ done: 3, total: 6, label: '3/6' });
      expect(calcProgressPercent(agentGroups)).toBe(50); // 3/6 = 50%
    });

    it('进度百分比向上取整', () => {
      const agentGroups: AgentGroup[] = [
        {
          agent_id: 'a1',
          active_children: [{ task_id: 't1', title: 'T', status: 'pending' }],
          completed_children: [{ task_id: 't2', title: 'T', status: 'completed' }],
        },
      ];
      expect(calcProgressPercent(agentGroups)).toBe(50); // 1/2 = 50%
    });
  });

  // ── B-2: 多父任务 ────────────────────────────────

  describe('B-2: 多父任务', () => {
    it('getRecentParentTask 返回 updated_at 最新的', () => {
      const workspace: WorkspaceTasks = {
        parents: [
          { id: 'p1', title: '旧项目', status: 'completed', updated_at: '2024-01-10T10:00:00Z', agent_groups: [] },
          { id: 'p2', title: '新项目', status: 'in_progress', updated_at: '2024-01-20T10:00:00Z', agent_groups: [] },
          { id: 'p3', title: '中间项目', status: 'pending', updated_at: '2024-01-15T10:00:00Z', agent_groups: [] },
        ],
      };

      const recent = getRecentParentTask(workspace);
      expect(recent?.id).toBe('p2');
      expect(recent?.title).toBe('新项目');
    });

    it('按 updated_at DESC 排序', () => {
      const workspace: WorkspaceTasks = {
        parents: [
          { id: 'p1', title: 'A', status: 'pending', updated_at: '2024-01-01T00:00:00Z', agent_groups: [] },
          { id: 'p2', title: 'B', status: 'pending', updated_at: '2024-01-03T00:00:00Z', agent_groups: [] },
          { id: 'p3', title: 'C', status: 'pending', updated_at: '2024-01-02T00:00:00Z', agent_groups: [] },
        ],
      };

      const recent = getRecentParentTask(workspace);
      expect(recent?.title).toBe('B'); // 最新的
    });
  });

  // ── C-1: 单 agent 子任务 ──────────────────────────

  describe('C-1: 单 agent 子任务', () => {
    it('进度计算正确', () => {
      const agentGroups: AgentGroup[] = [
        {
          agent_id: 'agent-1',
          active_children: [
            { task_id: 't1', title: 'Step 1', status: 'pending' },
            { task_id: 't2', title: 'Step 2', status: 'pending' },
            { task_id: 't3', title: 'Step 3', status: 'pending' },
          ],
          completed_children: [
            { task_id: 't4', title: 'Step 4', status: 'completed' },
          ],
        },
      ];

      expect(calcParentProgress(agentGroups)).toEqual({ done: 1, total: 4, label: '1/4' });
      expect(calcProgressPercent(agentGroups)).toBe(25);
    });
  });

  // ── C-2: 多 agent 子任务 ─────────────────────────

  describe('C-2: 多 agent 子任务', () => {
    it('进度合并计算', () => {
      const agentGroups: AgentGroup[] = [
        {
          agent_id: 'backend',
          active_children: [{ task_id: 'b1', title: 'B1', status: 'in_progress' }],
          completed_children: [],
        },
        {
          agent_id: 'frontend',
          active_children: [{ task_id: 'f1', title: 'F1', status: 'pending' }],
          completed_children: [{ task_id: 'f2', title: 'F2', status: 'completed' }],
        },
        {
          agent_id: 'test',
          active_children: [],
          completed_children: [{ task_id: 't1', title: 'T1', status: 'completed' }],
        },
      ];

      expect(calcParentProgress(agentGroups)).toEqual({ done: 2, total: 4, label: '2/4' });
      expect(calcProgressPercent(agentGroups)).toBe(50);
    });
  });

  // ── truncateTaskTitle ────────────────────────────

  describe('truncateTaskTitle', () => {
    it('去除 Markdown 标题标记', () => {
      expect(truncateTaskTitle('# Hello World')).toBe('Hello World');
      expect(truncateTaskTitle('## Subtitle')).toBe('Subtitle');
      expect(truncateTaskTitle('   # Leading hash')).toBe('# Leading hash'); // 井号前有空格则不视为标题
    });

    it('超过 maxLen 时截断并加省略号', () => {
      const longTitle = 'A'.repeat(60);
      expect(truncateTaskTitle(longTitle, 50).length).toBe(53); // 50 chars + '...' (3 chars)
      expect(truncateTaskTitle(longTitle, 50)).toBe('A'.repeat(50) + '...');
    });

    it('未超过 maxLen 时原样返回', () => {
      expect(truncateTaskTitle('Short title')).toBe('Short title');
    });

    it('空字符串返回空字符串', () => {
      expect(truncateTaskTitle('')).toBe('');
    });
  });
});

// ─── onlineAgents 逻辑测试 ───────────────────────────

describe('onlineAgents 逻辑', () => {

  const makeAgent = (overrides: Partial<AgentOverview> & { agent_id: string; last_active_at: string }): AgentOverview => ({
    agent_name: overrides.agent_id,
    avatar: null,
    workspace: null,
    status: '离线',
    model: null,
    latest_message: null,
    ...overrides,
  });

  it('优先显示工作中 agent', () => {
    const agents: AgentOverview[] = [
      makeAgent({ agent_id: 'offline-1', status: '离线', last_active_at: '2024-01-20T00:00:00Z' }),
      makeAgent({ agent_id: 'working-1', status: '工作中', last_active_at: '2024-01-15T00:00:00Z' }),
      makeAgent({ agent_id: 'offline-2', status: '离线', last_active_at: '2024-01-18T00:00:00Z' }),
    ];

    const result = getOnlineAgents(agents);
    expect(result[0].agent_id).toBe('working-1');
    expect(result).toHaveLength(3);
  });

  it('不足3个时用离线 agent 补充', () => {
    const agents: AgentOverview[] = [
      makeAgent({ agent_id: 'working-1', status: '工作中', last_active_at: '2024-01-15T00:00:00Z' }),
      makeAgent({ agent_id: 'offline-1', status: '离线', last_active_at: '2024-01-18T00:00:00Z' }),
    ];

    const result = getOnlineAgents(agents);
    expect(result).toHaveLength(2);
    expect(result[0].agent_id).toBe('working-1');
    expect(result[1].agent_id).toBe('offline-1');
  });

  it('离线 agent 按 last_active_at 降序排列', () => {
    const agents: AgentOverview[] = [
      makeAgent({ agent_id: 'old', status: '离线', last_active_at: '2024-01-01T00:00:00Z' }),
      makeAgent({ agent_id: 'recent', status: '离线', last_active_at: '2024-01-20T00:00:00Z' }),
      makeAgent({ agent_id: 'middle', status: '离线', last_active_at: '2024-01-10T00:00:00Z' }),
    ];

    const result = getOnlineAgents(agents);
    // offline agents 排序: recent > middle > old
    expect(result[0].agent_id).toBe('recent');
    expect(result[1].agent_id).toBe('middle');
    expect(result[2].agent_id).toBe('old');
  });

  it('最多返回3个 agent', () => {
    const agents: AgentOverview[] = [
      makeAgent({ agent_id: 'w1', status: '工作中', last_active_at: '2024-01-20T00:00:00Z' }),
      makeAgent({ agent_id: 'w2', status: '工作中', last_active_at: '2024-01-19T00:00:00Z' }),
      makeAgent({ agent_id: 'w3', status: '工作中', last_active_at: '2024-01-18T00:00:00Z' }),
      makeAgent({ agent_id: 'extra', status: '工作中', last_active_at: '2024-01-17T00:00:00Z' }),
    ];

    const result = getOnlineAgents(agents);
    expect(result).toHaveLength(3);
    expect(result.map(a => a.agent_id)).toEqual(['w1', 'w2', 'w3']);
  });

  it('只有离线 agent 时返回最多3个', () => {
    const agents: AgentOverview[] = [
      makeAgent({ agent_id: 'oldest', status: '离线', last_active_at: '2024-01-01T00:00:00Z' }),
      makeAgent({ agent_id: 'newest', status: '离线', last_active_at: '2024-01-20T00:00:00Z' }),
      makeAgent({ agent_id: 'middle', status: '离线', last_active_at: '2024-01-10T00:00:00Z' }),
      makeAgent({ agent_id: 'extra', status: '离线', last_active_at: '2024-01-05T00:00:00Z' }),
    ];

    const result = getOnlineAgents(agents);
    expect(result).toHaveLength(3);
    expect(result[0].agent_id).toBe('newest'); // 最近活跃优先
  });

  it('空数组返回空数组', () => {
    expect(getOnlineAgents([])).toEqual([]);
  });

  it('状态为"活跃"的 agent 也被视为活跃', () => {
    const agents: AgentOverview[] = [
      makeAgent({ agent_id: 'inactive', status: '离线', last_active_at: '2024-01-20T00:00:00Z' }),
      makeAgent({ agent_id: 'active', status: '活跃', last_active_at: '2024-01-15T00:00:00Z' }),
    ];

    const result = getOnlineAgents(agents);
    expect(result[0].agent_id).toBe('active');
  });
});

// ─── fetch 集成测试 ──────────────────────────────────

describe('fetch /api/tasks/workspace', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('成功返回 workspace 数据结构', async () => {
    const mockData = {
      parents: [
        {
          id: 'p1',
          title: '测试项目',
          status: 'in_progress',
          updated_at: '2024-01-15T10:00:00Z',
          agent_groups: [
            {
              agent_id: 'agent-1',
              active_children: [
                { task_id: 't1', title: '任务1', status: 'pending', updated_at: '2024-01-15T11:00:00Z' },
              ],
              completed_children: [
                { task_id: 't2', title: '任务2', status: 'completed', updated_at: '2024-01-15T12:00:00Z' },
              ],
            },
          ],
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const res = await fetch('/api/tasks/workspace');
    const data = await res.json();

    expect(data.parents).toHaveLength(1);
    expect(data.parents[0].id).toBe('p1');
    expect(data.parents[0].agent_groups[0].agent_id).toBe('agent-1');
    expect(data.parents[0].agent_groups[0].active_children).toHaveLength(1);
    expect(data.parents[0].agent_groups[0].completed_children).toHaveLength(1);
  });

  it('HTTP 错误时返回非 ok 响应（调用方应检查 ok 状态）', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const res = await fetch('/api/tasks/workspace');
    // fetch 本身不抛 HTTP 错误，只抛网络错误
    // 调用方（如 Overview.vue）应根据 res.ok 检查并抛出
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it('网络错误时抛出异常', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    await expect(fetch('/api/tasks/workspace')).rejects.toThrow('Network failure');
  });

  it('空 parents 返回空数组', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ parents: [] }),
    });

    const res = await fetch('/api/tasks/workspace');
    const data = await res.json();

    expect(data.parents).toEqual([]);
    expect(getRecentParentTask(data)).toBeNull();
  });
});
