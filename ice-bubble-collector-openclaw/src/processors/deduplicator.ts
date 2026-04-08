/**
 * 去重器
 *
 * 使用 Redis LRU 缓存去重消息
 */

export class Deduplicator {
    async exists(key: string): Promise<boolean> {
        // TODO: 实现去重检查
        return false;
    }

    async mark(key: string): Promise<void> {
        // TODO: 实现标记已处理
    }
}
