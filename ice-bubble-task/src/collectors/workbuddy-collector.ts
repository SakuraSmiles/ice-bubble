/**
 * WorkBuddy 任务采集器（桩代码）
 *
 * TODO: 实现 WorkBuddy 平台任务采集
 *
 * 预留扩展点，计划接入：
 * - 从 WorkBuddy REST API 获取任务数据
 * - 转换为 TaskInsert 格式
 * - 调用 repository.upsertTasks() 写入
 *
 * 示例采集逻辑：
 * ```ts
 * async collect(): Promise<CollectResult> {
 *   const response = await fetch(`${this.baseUrl}/api/tasks`);
 *   const data = await response.json();
 *   const tasks = data.tasks.map(this.transform.bind(this));
 *   const count = this.repository.upsertTasks(tasks);
 *   return { collected: count, updated: count, errors: [] };
 * }
 * ```
 */

import type { CollectorInterface } from './collector-interface.js';
import type { CollectResult } from '../types/task.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('WorkBuddyCollector');

export class WorkBuddyCollector implements CollectorInterface {
  readonly name = 'workbuddy';

  constructor(
    private _baseUrl: string,
    private _repo: unknown
  ) {
    void this._baseUrl;
    void this._repo;
  }

  async isAvailable(): Promise<boolean> {
    // TODO: 实现连接检查
    return false;
  }

  async collect(): Promise<CollectResult> {
    logger.warn('WorkBuddyCollector not implemented, skip');
    return { collected: 0, updated: 0, errors: ['WorkBuddyCollector not implemented'] };
  }
}

export function createWorkBuddyCollector(baseUrl: string, repository: unknown): CollectorInterface {
  return new WorkBuddyCollector(baseUrl, repository);
}
