/**
 * 去重器（Deduplicator）
 *
 * 使用 LRU 缓存防止重复数据写入数据库，确保数据唯一性
 * 性能目标：去重速度 > 200,000 msg/s
 */

import { UnifiedMessage } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const sqliteLogger = new Logger('Deduplicator');

/**
 * 计算消息的内容指纹（content fingerprint）
 *
 * 用于在 ID 去重之外进行内容级去重。
 * Gateway 的 subagent_announce 机制可能在后续 run 中重新注入已完成 subagent 的报告，
 * 产生新的 event ID 但内容完全相同。此指纹用于检测这类"不同 ID、相同内容"的重复。
 *
 * 格式：sessionKey:messageType:content前200字符
 * 只取前 200 字符是因为 subagent 报告通常较长，但重复时内容完全一致，
 * 200 字符已足够区分不同消息。
 */
export function contentFingerprint(sessionKey: string, messageType: string, content: string | undefined): string {
  return `${sessionKey}:${messageType}:${(content ?? '').substring(0, 200)}`;
}

/**
 * 去重器配置
 */
export interface DeduplicatorConfig {
    /**
     * 缓存大小（条目数）
     * @default 10000
     */
    cacheSize?: number;
}

/**
 * 去重统计信息
 */
export interface DeduplicationStats {
    /** 总消息数 */
    total: number;
    /** 重复消息数 */
    duplicates: number;
    /** 唯一消息数 */
    unique: number;
    /** 命中率（重复率） */
    hitRate: number;
}

/**
 * LRU 缓存节点
 */
interface CacheNode {
    /** 键：消息 ID */
    key: string;
    /** 值：已处理标记 */
    value: boolean;
    /** 前驱节点 */
    prev: CacheNode | null;
    /** 后继节点 */
    next: CacheNode | null;
}

/**
 * LRU 缓存实现
 *
 * 使用 Map + 双向链表实现 O(1) 时间复杂度的 get/set/has 操作
 */
class LRUCache {
    private cache: Map<string, CacheNode>;
    private head: CacheNode | null = null;
    private tail: CacheNode | null = null;
    private capacity: number;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.cache = new Map<string, CacheNode>();
    }

    /**
     * 获取缓存值
     * 如果存在，移动到链表头部（最近使用）
     */
    get(key: string): boolean | undefined {
        const node = this.cache.get(key);
        if (!node) {
            return undefined;
        }

        // 移动到头部
        this.moveToHead(node);
        return node.value;
    }

    /**
     * 设置缓存值
     * 如果缓存已满，删除尾部节点（最久未使用）
     */
    set(key: string, value: boolean): void {
        const existingNode = this.cache.get(key);

        if (existingNode) {
            // 更新已存在的节点
            existingNode.value = value;
            this.moveToHead(existingNode);
        } else {
            // 创建新节点
            const newNode: CacheNode = {
                key,
                value,
                prev: null,
                next: null,
            };

            // 添加到缓存
            this.cache.set(key, newNode);
            this.addToHead(newNode);

            // 如果缓存已满，删除尾部节点
            if (this.cache.size > this.capacity) {
                this.removeTail();
            }
        }
    }

    /**
     * 检查键是否存在
     * 如果存在，移动到链表头部（最近使用）
     */
    has(key: string): boolean {
        const exists = this.cache.has(key);
        if (exists) {
            // 移动到头部，更新访问顺序
            const node = this.cache.get(key)!;
            this.moveToHead(node);
        }
        return exists;
    }

    /**
     * 获取缓存大小
     */
    size(): number {
        return this.cache.size;
    }

    /**
     * 清空缓存
     */
    clear(): void {
        this.cache.clear();
        this.head = null;
        this.tail = null;
    }

    /**
     * 添加节点到链表头部
     */
    private addToHead(node: CacheNode): void {
        node.prev = null;
        node.next = this.head;

        if (this.head) {
            this.head.prev = node;
        }
        this.head = node;

        if (!this.tail) {
            this.tail = node;
        }
    }

    /**
     * 移动节点到链表头部
     */
    private moveToHead(node: CacheNode): void {
        if (node === this.head) {
            return; // 已经在头部
        }

        // 从当前位置移除
        this.removeNode(node);

        // 添加到头部
        this.addToHead(node);
    }

    /**
     * 从链表中移除节点
     */
    private removeNode(node: CacheNode): void {
        if (node.prev) {
            node.prev.next = node.next;
        } else {
            this.head = node.next;
        }

        if (node.next) {
            node.next.prev = node.prev;
        } else {
            this.tail = node.prev;
        }
    }

    /**
     * 移除尾部节点（最久未使用）
     */
    private removeTail(): void {
        if (!this.tail) {
            return;
        }

        const tailKey = this.tail.key;
        this.removeNode(this.tail);
        this.cache.delete(tailKey);
    }
}

/**
 * 去重器
 *
 * 使用 LRU 缓存实现消息去重，确保每条消息只被处理一次
 *
 * @example
 * const deduplicator = new Deduplicator({ cacheSize: 10000 });
 *
 * // 单个消息检查
 * if (!deduplicator.isDuplicate(msg.id)) {
 *   deduplicator.markAsProcessed(msg.id);
 *   // 处理消息...
 * }
 *
 * // 批量过滤
 * const uniqueMessages = deduplicator.filterDuplicates(messages);
 */
export class Deduplicator {
    private cache: LRUCache;
    private readonly config: Required<DeduplicatorConfig>;
    /**
     * 内容级去重缓存（content fingerprint → 最近处理时间戳）
     *
     * Gateway subagent_announce 会在后续 run 中重新注入已完成 subagent 的报告，
     * 产生不同 event ID 但内容完全相同的重复消息。ID 去重无法拦截，因此增加
     * 内容级去重：用 (sessionKey:messageType:content前200字符) 作为指纹，
     * 在 30 秒窗口内相同指纹视为重复。
     *
     * 使用独立 Map 而非复用 ID cache，因为两者淘汰策略不同：
     * ID cache 需要长期保留（防跨批次重复），指纹 cache 只需短期窗口。
     */
    private contentFingerprints: Map<string, number>;
    private static readonly CONTENT_DEDUP_WINDOW_MS = 30_000; // 30 秒窗口
    private static readonly CONTENT_CACHE_MAX = 5000;

    constructor(config?: DeduplicatorConfig) {
        this.config = {
            cacheSize: config?.cacheSize ?? 10000,
        };
        this.cache = new LRUCache(this.config.cacheSize);
        this.contentFingerprints = new Map();
    }

    /**
     * 检查消息是否重复
     *
     * @param messageId 消息 ID
     * @returns true 表示重复，false 表示不重复
     *
     * @example
     * const isDup = deduplicator.isDuplicate('msg-123');
     * if (!isDup) {
     *   // 处理新消息
     * }
     */
    isDuplicate(messageId: string): boolean {
        return this.cache.has(messageId);
    }

    /**
     * 标记消息为已处理
     *
     * 将消息 ID 添加到缓存，如果缓存已满，自动淘汰最久未使用的条目
     *
     * @param messageId 消息 ID
     *
     * @example
     * deduplicator.markAsProcessed('msg-123');
     */
    markAsProcessed(messageId: string): void {
        this.cache.set(messageId, true);
    }

    /**
     * 检查消息内容是否在最近 30 秒窗口内重复
     *
     * 与 isDuplicate（ID 级去重）不同，此方法比较消息的实际内容。
     * 用于拦截 Gateway subagent_announce 产生的同内容不同 ID 的重复消息。
     *
     * @param message - 待检查的 UnifiedMessage
     * @returns true 表示内容重复，应跳过
     */
    isContentDuplicate(message: UnifiedMessage): boolean {
        const fp = contentFingerprint(message.sessionKey, message.messageType, message.content);
        const now = Date.now();
        const lastSeen = this.contentFingerprints.get(fp);

        if (lastSeen !== undefined && (now - lastSeen) < Deduplicator.CONTENT_DEDUP_WINDOW_MS) {
            return true;
        }

        // 更新指纹时间戳（无论是否命中都更新，保持 LRU 效果）
        this.contentFingerprints.set(fp, now);

        // 淘汰超量条目（简单策略：超过上限时清空旧条目）
        if (this.contentFingerprints.size > Deduplicator.CONTENT_CACHE_MAX) {
            this.pruneContentFingerprints();
        }

        return false;
    }

    /**
     * 清理过期的内容指纹条目
     */
    private pruneContentFingerprints(): void {
        const cutoff = Date.now() - Deduplicator.CONTENT_DEDUP_WINDOW_MS;
        for (const [key, ts] of this.contentFingerprints) {
            if (ts < cutoff) {
                this.contentFingerprints.delete(key);
            }
        }
    }

    /**
     * 批量过滤，返回唯一消息
     *
     * 自动去重并标记已处理的消息（同时进行 ID 级和内容级去重）
     *
     * @param messages 消息列表
     * @returns 唯一消息列表
     */
    filterDuplicates(messages: UnifiedMessage[]): UnifiedMessage[] {
        const unique: UnifiedMessage[] = [];

        for (const message of messages) {
            if (!this.isDuplicate(message.id) && !this.isContentDuplicate(message)) {
                this.markAsProcessed(message.id);
                unique.push(message);
            }
        }

        return unique;
    }

    /**
     * 批量处理，返回唯一消息和统计信息
     *
     * @param messages 消息列表
     * @returns 唯一消息列表和统计信息
     */
    filterWithStats(messages: UnifiedMessage[]): {
        unique: UnifiedMessage[];
        stats: DeduplicationStats;
    } {
        const unique: UnifiedMessage[] = [];
        let duplicates = 0;

        for (const message of messages) {
            if (!this.isDuplicate(message.id) && !this.isContentDuplicate(message)) {
                this.markAsProcessed(message.id);
                unique.push(message);
            } else {
                duplicates++;
            }
        }

        const total = messages.length;
        const stats: DeduplicationStats = {
            total,
            duplicates,
            unique: unique.length,
            hitRate: total > 0 ? duplicates / total : 0,
        };

        return { unique, stats };
    }

    /**
     * 清空缓存（ID 缓存 + 内容指纹缓存）
     */
    clear(): void {
        this.cache.clear();
        this.contentFingerprints.clear();
    }

    /**
     * 获取缓存大小
     *
     * @returns 当前缓存中的条目数
     *
     * @example
     * const size = deduplicator.size();
     * console.log(`缓存中有 ${size} 条已处理消息`);
     */
    size(): number {
        return this.cache.size();
    }

    /**
     * 从数据库预热缓存
     *
     * 启动时从数据库加载已存在的 message_id，避免重启后重复消息走完整 pipeline
     * 只填充到缓存容量上限，超出的会被后续 LRU 淘汰
     *
     * @param messageIds - 数据库中已存在的 message_id 列表
     *
     * @example
     * // 启动时预热
     * const ids = await sqliteManager.getAllMessageIds();
     * deduplicator.preloadFromDatabase(ids);
     */
    preloadFromDatabase(messageIds: string[]): void {
        let loaded = 0;
        for (const id of messageIds) {
            this.cache.set(id, true);
            loaded++;
        }
        sqliteLogger.debug(`[Deduplicator] 预热完成: ${loaded} 条 message_id 已加载，缓存容量: ${this.config.cacheSize}`);
    }
}
