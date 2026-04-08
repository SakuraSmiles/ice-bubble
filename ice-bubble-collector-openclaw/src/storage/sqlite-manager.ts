/**
 * SQLite 管理器
 *
 * 主存储：持久化存储所有采集的数据
 */

export class SQLiteManager {
    async init(): Promise<void> {
        // TODO: 实现数据库初始化
        console.log('[SQLiteManager] Initializing...');
    }

    async close(): Promise<void> {
        // TODO: 实现数据库关闭
        console.log('[SQLiteManager] Closing...');
    }
}
