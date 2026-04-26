/**
 * Workspace API 验收测试
 *
 * 测试 GET /api/tasks/workspace 端点在不同数据场景下的响应格式
 * 覆盖场景：
 *   A-1: 空数据（无父任务）
 *   A-2: 单个父任务，无子任务
 *   B-1: 单个父任务，含多个 agent 子任务（部分 active，部分 completed）
 *   B-2: 多个父任务，每个含不同 agent 分组
 *   C-1: 父任务含单个 agent 的子任务
 *   C-2: 父任务含多个 agent 的子任务
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTasksRouter } from '../src/api/tasks.js';
import type { Task, TaskRepository } from '../src/storage/task-repository.js';

// ─── Mock Repository ───────────────────────────────────

function createMockRepository() {
  return {
    findLatestParentTasks: vi.fn<[limit: number], Task[]>(),
    findByParentId: vi.fn<[parent_id: string], Task[]>(),
    findTasks: vi.fn(),
    findById: vi.fn(),
    findByAgentId: vi.fn(),
    upsertTask: vi.fn(),
    upsertTasks: vi.fn(),
    getStats: vi.fn(),
    updateTaskStatus: vi.fn(),
    findParentTasks: vi.fn(),
    getTasksOlderThan: vi.fn(),
  };
}

// ─── Test Data Fixtures ────────────────────────────────

const makeTask = (overrides: Partial<Task> & { id: string; title: string; agent_id: string }): Task =>
  ({
    id: overrides.id,
    title: overrides.title,
    status: 'pending',
    priority: 'medium',
    agent_id: overrides.agent_id,
    type: 'TODO',
    parent_id: null,
    children_ids: [],
    description: '',
    loop_target: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    terminated_by: null,
    ...overrides,
  } as Task);

// ─── App Setup Helper ─────────────────────────────────

function createApp(repository: TaskRepository) {
  const app = express();
  app.use(express.json());
  app.use('/api', createTasksRouter(repository, '/fake/task-store.json'));
  return app;
}

// ─── Tests ────────────────────────────────────────────

describe('GET /api/tasks/workspace', () => {

  // ── A-1: 空数据（无父任务）─────────────────────────────

  describe('A-1: 空数据', () => {
    it('返回空 parents 数组', async () => {
      const repo = createMockRepository();
      repo.findLatestParentTasks.mockReturnValue([]);

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ parents: [] });
      expect(repo.findLatestParentTasks).toHaveBeenCalledWith(3);
    });
  });

  // ── A-2: 单个父任务，无子任务 ──────────────────────────

  describe('A-2: 单个父任务，无子任务', () => {
    it('返回父任务基本信息，agent_groups 为空', async () => {
      const repo = createMockRepository();
      const parent = makeTask({
        id: 'parent-1',
        title: '重构登录模块',
        agent_id: 'agent-1',
        status: 'in_progress',
        parent_id: null,
        updated_at: '2024-01-15T10:00:00Z',
      });
      repo.findLatestParentTasks.mockReturnValue([parent]);
      repo.findByParentId.mockReturnValue([]);

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(200);
      expect(res.body.parents).toHaveLength(1);
      expect(res.body.parents[0]).toMatchObject({
        id: 'parent-1',
        title: '重构登录模块',
        status: 'in_progress',
        updated_at: '2024-01-15T10:00:00Z',
        agent_groups: [],
      });
    });
  });

  // ── B-1: 单个父任务，多个 agent 子任务（部分 active，部分 completed）───

  describe('B-1: 单父任务 + 多 agent 子任务', () => {
    it('正确分组 active 和 completed 子任务', async () => {
      const repo = createMockRepository();
      const parent = makeTask({
        id: 'parent-1',
        title: '开发用户模块',
        agent_id: 'agent-1',
        status: 'in_progress',
        parent_id: null,
        updated_at: '2024-01-15T12:00:00Z',
      });

      const children = [
        makeTask({ id: 'child-1', title: '实现注册 API', agent_id: 'agent-1', status: 'pending', parent_id: 'parent-1' }),
        makeTask({ id: 'child-2', title: '实现登录 API', agent_id: 'agent-1', status: 'in_progress', parent_id: 'parent-1' }),
        makeTask({ id: 'child-3', title: '实现登出 API', agent_id: 'agent-1', status: 'completed', parent_id: 'parent-1' }),
        // 不同 agent 的子任务
        makeTask({ id: 'child-4', title: '前端注册表单', agent_id: 'agent-2', status: 'pending', parent_id: 'parent-1' }),
        makeTask({ id: 'child-5', title: '前端登录表单', agent_id: 'agent-2', status: 'completed', parent_id: 'parent-1' }),
      ];

      repo.findLatestParentTasks.mockReturnValue([parent]);
      repo.findByParentId.mockReturnValue(children);

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(200);
      expect(res.body.parents).toHaveLength(1);

      const agentGroups = res.body.parents[0].agent_groups;
      expect(agentGroups).toHaveLength(2);

      // agent-1 分组
      const agent1Group = agentGroups.find((g: any) => g.agent_id === 'agent-1');
      expect(agent1Group.active_children).toHaveLength(2);
      expect(agent1Group.active_children.map((c: any) => c.id)).toEqual(['child-1', 'child-2']);
      expect(agent1Group.completed_children).toHaveLength(1);
      expect(agent1Group.completed_children[0].id).toBe('child-3');

      // agent-2 分组
      const agent2Group = agentGroups.find((g: any) => g.agent_id === 'agent-2');
      expect(agent2Group.active_children).toHaveLength(1);
      expect(agent2Group.active_children[0].id).toBe('child-4');
      expect(agent2Group.completed_children).toHaveLength(1);
      expect(agent2Group.completed_children[0].id).toBe('child-5');
    });
  });

  // ── B-2: 多个父任务，每个含不同 agent 分组 ───────────

  describe('B-2: 多父任务 + 不同 agent 分组', () => {
    it('返回多个父任务，各自正确分组', async () => {
      const repo = createMockRepository();

      const parent1 = makeTask({ id: 'p1', title: '项目A', agent_id: 'a1', status: 'in_progress', parent_id: null, updated_at: '2024-01-15T14:00:00Z' });
      const parent2 = makeTask({ id: 'p2', title: '项目B', agent_id: 'a2', status: 'pending', parent_id: null, updated_at: '2024-01-15T13:00:00Z' });

      const children1 = [
        makeTask({ id: 'c1', title: '任务1', agent_id: 'a1', status: 'pending', parent_id: 'p1' }),
        makeTask({ id: 'c2', title: '任务2', agent_id: 'a1', status: 'completed', parent_id: 'p1' }),
      ];
      const children2 = [
        makeTask({ id: 'c3', title: '任务3', agent_id: 'a2', status: 'in_progress', parent_id: 'p2' }),
      ];

      repo.findLatestParentTasks.mockReturnValue([parent1, parent2]);
      repo.findByParentId
        .mockReturnValueOnce(children1)
        .mockReturnValueOnce(children2);

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(200);
      expect(res.body.parents).toHaveLength(2);

      // 按 updated_at DESC 排序，p1 应该排第一
      expect(res.body.parents[0].id).toBe('p1');
      expect(res.body.parents[1].id).toBe('p2');

      expect(res.body.parents[0].agent_groups).toHaveLength(1);
      expect(res.body.parents[1].agent_groups).toHaveLength(1);
    });
  });

  // ── C-1: 父任务含单个 agent 的子任务 ─────────────────

  describe('C-1: 单 agent 子任务', () => {
    it('只有一个 agent 分组，active 和 completed 分离', async () => {
      const repo = createMockRepository();
      const parent = makeTask({
        id: 'parent-1',
        title: '单一 agent 项目',
        agent_id: 'agent-1',
        status: 'pending',
        parent_id: null,
        updated_at: '2024-01-15T15:00:00Z',
      });

      const children = [
        makeTask({ id: 'child-1', title: 'Step 1', agent_id: 'agent-1', status: 'pending', parent_id: 'parent-1' }),
        makeTask({ id: 'child-2', title: 'Step 2', agent_id: 'agent-1', status: 'pending', parent_id: 'parent-1' }),
        makeTask({ id: 'child-3', title: 'Step 3', agent_id: 'agent-1', status: 'completed', parent_id: 'parent-1' }),
      ];

      repo.findLatestParentTasks.mockReturnValue([parent]);
      repo.findByParentId.mockReturnValue(children);

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(200);
      const agentGroups = res.body.parents[0].agent_groups;
      expect(agentGroups).toHaveLength(1);
      expect(agentGroups[0].agent_id).toBe('agent-1');
      expect(agentGroups[0].active_children).toHaveLength(2);
      expect(agentGroups[0].completed_children).toHaveLength(1);
    });
  });

  // ── C-2: 父任务含多个 agent 的子任务 ─────────────────

  describe('C-2: 多 agent 子任务', () => {
    it('多个 agent 分组，各自独立', async () => {
      const repo = createMockRepository();
      const parent = makeTask({
        id: 'parent-1',
        title: '多 agent 协作项目',
        agent_id: 'agent-1',
        status: 'in_progress',
        parent_id: null,
        updated_at: '2024-01-15T16:00:00Z',
      });

      const children = [
        makeTask({ id: 'child-1', title: '后端 API', agent_id: 'agent-backend', status: 'in_progress', parent_id: 'parent-1' }),
        makeTask({ id: 'child-2', title: '前端界面', agent_id: 'agent-frontend', status: 'pending', parent_id: 'parent-1' }),
        makeTask({ id: 'child-3', title: '测试', agent_id: 'agent-test', status: 'completed', parent_id: 'parent-1' }),
      ];

      repo.findLatestParentTasks.mockReturnValue([parent]);
      repo.findByParentId.mockReturnValue(children);

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(200);
      const agentGroups = res.body.parents[0].agent_groups;
      expect(agentGroups).toHaveLength(3);

      const agentIds = agentGroups.map((g: any) => g.agent_id);
      expect(agentIds).toContain('agent-backend');
      expect(agentIds).toContain('agent-frontend');
      expect(agentIds).toContain('agent-test');
    });
  });

  // ── 子任务字段验证 ────────────────────────────────────

  describe('子任务字段格式', () => {
    it('active_children 包含 id, title, status, updated_at', async () => {
      const repo = createMockRepository();
      const parent = makeTask({
        id: 'p1', title: '项目', agent_id: 'a1', status: 'in_progress', parent_id: null, updated_at: '2024-01-15T10:00:00Z',
      });
      const child = makeTask({
        id: 'c1', title: '子任务标题', agent_id: 'a1', status: 'pending',
        parent_id: 'p1', updated_at: '2024-01-15T11:00:00Z',
      });

      repo.findLatestParentTasks.mockReturnValue([parent]);
      repo.findByParentId.mockReturnValue([child]);

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(200);
      const activeChild = res.body.parents[0].agent_groups[0].active_children[0];
      expect(activeChild).toHaveProperty('id', 'c1');
      expect(activeChild).toHaveProperty('title', '子任务标题');
      expect(activeChild).toHaveProperty('status', 'pending');
      expect(activeChild).toHaveProperty('updated_at', '2024-01-15T11:00:00Z');
    });
  });

  // ── 错误处理 ─────────────────────────────────────────

  describe('错误处理', () => {
    it('repository 抛出异常时返回 500', async () => {
      const repo = createMockRepository();
      repo.findLatestParentTasks.mockImplementation(() => {
        throw new Error('DB error');
      });

      const app = createApp(repo as unknown as TaskRepository);
      const res = await request(app).get('/api/tasks/workspace');

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: expect.any(String), code: 'WORKSPACE_TASKS_FAILED' });
    });
  });
});
