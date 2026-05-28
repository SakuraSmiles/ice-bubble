/**
 * Collector 接口
 *
 * 所有 Collector 模块必须实现此接口。
 */
export interface Collector {
    /** 启动采集器 */
    start(): Promise<void>;

    /** 停止采集器 */
    stop(): Promise<void>;
}

/**
 * Collector 运行统计
 */
export interface CollectorStats {
    sessionCount: number;
    messageCount: number;
    agentCount: number;
    lastUpdated: string | null;
}
