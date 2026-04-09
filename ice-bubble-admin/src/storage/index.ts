/**
 * ice-bubble Admin - 存储层入口
 *
 * 导出数据库管理器和模块存储仓库
 */

export * from './db-manager.js';
export * from './module-repository.js';
export * from './data-repository.js';

/**
 * 存储层配置
 */
export interface StorageConfig {
  /**
   * 数据库配置
   */
  database: {
    /**
     * 数据库文件路径
     * @default '../data/admin.db'
     */
    path: string;

    /**
     * 是否启用 WAL 模式
     * @default true
     */
    walMode?: boolean;

    /**
     * 是否启用外键约束
     * @default true
     */
    foreignKeys?: boolean;

    /**
     * 性能优化配置
     */
    performance?: {
      /**
       * 缓存大小 (KB)
       * @default -64000 (64MB)
       */
      cacheSize?: number;

      /**
       * 内存映射大小 (bytes)
       * @default 268435456 (256MB)
       */
      mmapSize?: number;

      /**
       * 页面大小 (bytes)
       * @default 4096
       */
      pageSize?: number;

      /**
       * 繁忙超时 (ms)
       * @default 5000
       */
      busyTimeout?: number;
    };
  };

  /**
   * 数据清理配置
   */
  cleanup?: {
    /**
     * 是否启用自动清理
     * @default true
     */
    enabled: boolean;

    /**
     * 健康数据保留天数
     * @default 30
     */
    healthDaysToKeep: number;

    /**
     * 事件数据保留天数
     * @default 90
     */
    eventDaysToKeep: number;

    /**
     * 统计数据保留天数
     * @default 365
     */
    statsDaysToKeep: number;

    /**
     * 清理计划 (cron 表达式)
     * @default '0 2 * * *' (每天凌晨2点)
     */
    schedule: string;
  };
}

/**
 * 默认存储配置
 */
export const defaultStorageConfig: StorageConfig = {
  database: {
    path: '../data/admin.db',
    walMode: true,
    foreignKeys: true,
    performance: {
      cacheSize: -64000,        // 64MB
      mmapSize: 268435456,      // 256MB
      pageSize: 4096,
      busyTimeout: 5000         // 5秒
    }
  },
  cleanup: {
    enabled: true,
    healthDaysToKeep: 30,
    eventDaysToKeep: 90,
    statsDaysToKeep: 365,
    schedule: '0 2 * * *'       // 每天凌晨2点
  }
};