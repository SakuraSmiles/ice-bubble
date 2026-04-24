/**
 * Collector 接口定义
 *
 * 所有平台采集器需实现此接口。
 * Task 模块只做数据采集和存储，不调用 Admin API。
 */

import type { CollectResult } from '../types/task.js';

/**
 * 采集器接口
 */
export interface CollectorInterface {
  /** 采集器名称 */
  readonly name: string;

  /**
   * 执行一次采集
   * @returns 采集结果
   */
  collect(): Promise<CollectResult>;

  /**
   * 检查采集器是否可用
   */
  isAvailable(): Promise<boolean>;
}
