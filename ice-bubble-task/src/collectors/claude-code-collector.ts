/**
 * ClaudeCode 任务采集器（桩代码）
 *
 * TODO: 实现 ClaudeCode 平台任务采集
 *
 * 预留扩展点，计划接入：
 * - 读取 ClaudeCode 本地任务存储文件
 * - 或调用 ClaudeCode CLI/API 获取任务数据
 * - 转换为 TaskInsert 格式
 * - 调用 repository.upsertTasks() 写入
 *
 * 示例采集逻辑：
 * ```ts
 * async collect(): Promise<CollectResult> {
 *   const storePath = expandPath(this.taskStorePath);
 *   const content = readFileSync(storePath, 'utf-8');
 *   const data = JSON.parse(content);
 *   const tasks = data.items.map(this.transform.bind(this));
 *   const count = this.repository.upsertTasks(tasks);
 *   return { collected: count, updated: count, errors: [] };
 * }
 * ```
 */

import type { CollectorInterface } from './collector-interface.js';
import type { CollectResult } from '../types/task.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('ClaudeCodeCollector');

export class ClaudeCodeCollector implements CollectorInterface {
  readonly name = 'claudeCode';

  constructor(
    private _taskStorePath: string,
    private _repo: unknown
  ) {
    void this._taskStorePath;
    void this._repo;
  }

  async isAvailable(): Promise<boolean> {
    // TODO: 实现可用性检查
    return false;
  }

  async collect(): Promise<CollectResult> {
    logger.warn('ClaudeCodeCollector not implemented, skip');
    return { collected: 0, updated: 0, errors: ['ClaudeCodeCollector not implemented'] };
  }
}

export function createClaudeCodeCollector(taskStorePath: string, repository: unknown): CollectorInterface {
  return new ClaudeCodeCollector(taskStorePath, repository);
}
