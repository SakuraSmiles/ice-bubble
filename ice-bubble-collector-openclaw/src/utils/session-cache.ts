/**
 * SessionCache - Session 缓存管理器
 * 
 * 解决 Session 重复创建问题，避免多次数据库查询
 * 
 * 功能：
 * 1. 内存缓存已存在的 Session
 * 2. 批量检查 Session 是否存在
 * 3. 自动清理过期缓存
 * 
 * @module SessionCache
 */

import { Logger } from './logger.js';
import { SQLiteManager } from '../storage/sqlite-manager.js';

const logger = new Logger('SessionCache');

/**
 * Session 缓存项
 */
interface CacheItem {
  sessionKey: string;
  exists: boolean;
  lastChecked: Date;
}

/**
 * Session 缓存配置
 */
export interface SessionCacheConfig {
  /** 缓存最大容量 */
  maxSize: number;
  /** 缓存过期时间（毫秒） */
  ttl: number;
  /** 是否启用缓存 */
  enabled: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: SessionCacheConfig = {
  maxSize: 10000,
  ttl: 5 * 60 * 1000, // 5分钟
  enabled: true
};

/**
 * Session 缓存管理器
 */
export class SessionCache {
  /** 缓存存储 */
  private cache = new Map<string, CacheItem>();
  
  /** 配置 */
  private config: SessionCacheConfig;
  
  /** SQLite 管理器引用 */
  private sqliteManager: SQLiteManager;
  
  /** 清理定时器 */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(sqliteManager: SQLiteManager, config?: Partial<SessionCacheConfig>) {
    this.sqliteManager = sqliteManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    if (this.config.enabled) {
      this.startCleanupTimer();
    }
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // 每30秒清理一次过期缓存
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 30000);
  }

  /**
   * 检查 Session 是否存在（带缓存）
   */
  async ensureSession(sessionKey: string): Promise<boolean> {
    if (!this.config.enabled) {
      // 缓存禁用，直接查询数据库
      return this.checkSessionInDb(sessionKey);
    }

    // 检查缓存
    const cached = this.cache.get(sessionKey);
    if (cached) {
      if (this.isExpired(cached)) {
        // 缓存过期，重新查询
        this.cache.delete(sessionKey);
      } else {
        // 缓存命中
        logger.debug(`缓存命中: ${sessionKey}`);
        return cached.exists;
      }
    }

    // 查询数据库
    const exists = await this.checkSessionInDb(sessionKey);
    
    // 更新缓存
    this.setCache(sessionKey, exists);
    
    return exists;
  }

  /**
   * 批量检查 Session 是否存在
   */
  async ensureSessions(sessionKeys: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    
    if (!this.config.enabled || sessionKeys.length === 0) {
      return result;
    }

    // 分离缓存命中和未命中的
    const cachedResults = new Map<string, boolean>();
    const toCheck: string[] = [];

    for (const sessionKey of sessionKeys) {
      const cached = this.cache.get(sessionKey);
      if (cached && !this.isExpired(cached)) {
        cachedResults.set(sessionKey, cached.exists);
      } else {
        toCheck.push(sessionKey);
      }
    }

    logger.debug(`批量检查: 缓存命中 ${cachedResults.size} 个，需要查询 ${toCheck.length} 个`);

    // 批量查询数据库
    if (toCheck.length > 0) {
      const dbResults = await this.batchCheckSessionsInDb(toCheck);
      
      // 更新缓存
      for (const [sessionKey, exists] of dbResults) {
        this.setCache(sessionKey, exists);
        result.set(sessionKey, exists);
      }
    }

    // 合并结果
    for (const [sessionKey, exists] of cachedResults) {
      result.set(sessionKey, exists);
    }

    return result;
  }

  /**
   * 检查 Session 在数据库中是否存在
   */
  private async checkSessionInDb(sessionKey: string): Promise<boolean> {
    try {
      const session = await this.sqliteManager.getSession(sessionKey);
      return !!session;
    } catch (error) {
      logger.error(`检查 Session 失败: ${sessionKey}`, error);
      return false;
    }
  }

  /**
   * 批量检查 Session 在数据库中是否存在
   */
  private async batchCheckSessionsInDb(sessionKeys: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    
    try {
      // 批量查询数据库
      // 这里需要根据实际的 SQLiteManager 接口调整
      for (const sessionKey of sessionKeys) {
        const exists = await this.checkSessionInDb(sessionKey);
        result.set(sessionKey, exists);
      }
    } catch (error) {
      logger.error('批量检查 Session 失败', error);
      // 失败时默认返回 false
      for (const sessionKey of sessionKeys) {
        result.set(sessionKey, false);
      }
    }
    
    return result;
  }

  /**
   * 设置缓存
   */
  private setCache(sessionKey: string, exists: boolean): void {
    if (this.cache.size >= this.config.maxSize) {
      // 缓存满，清理最旧的
      this.evictOldest();
    }
    
    this.cache.set(sessionKey, {
      sessionKey,
      exists,
      lastChecked: new Date()
    });
  }

  /**
   * 检查缓存是否过期
   */
  private isExpired(item: CacheItem): boolean {
    const now = new Date();
    const age = now.getTime() - item.lastChecked.getTime();
    return age > this.config.ttl;
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpired(): void {
    let expiredCount = 0;
    
    for (const [key, item] of this.cache.entries()) {
      if (this.isExpired(item)) {
        this.cache.delete(key);
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      logger.debug(`清理过期缓存: ${expiredCount} 个`);
    }
  }

  /**
   * 淘汰最旧的缓存项
   */
  private evictOldest(): void {
    if (this.cache.size === 0) return;
    
    let oldestKey: string | null = null;
    let oldestTime = new Date();
    
    for (const [key, item] of this.cache.entries()) {
      if (item.lastChecked < oldestTime) {
        oldestTime = item.lastChecked;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
      logger.debug(`淘汰最旧缓存: ${oldestKey}`);
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    size: number;
    hitRate: number;
    config: SessionCacheConfig;
  } {
    // 这里可以添加命中率统计
    return {
      size: this.cache.size,
      hitRate: 0, // 需要添加命中统计
      config: this.config
    };
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    logger.info('缓存已清空');
  }

  /**
   * 停止缓存管理器
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    this.clear();
    logger.info('SessionCache 已停止');
  }
}