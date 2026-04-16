/**
 * API 性能监控模块
 * 记录每次 API 请求的延迟，支持统计分析和趋势展示
 */

export interface LatencyRecord {
  timestamp: number;
  endpoint: string;
  method: string;
  latency: number;      // 延迟（ms）
  success: boolean;
  error?: string;
}

export interface EndpointStats {
  endpoint: string;
  count: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  successRate: number;
  lastLatency: number;
}

export interface MonitorStats {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  currentLatency: number;   // 最近一次延迟
  avgLatency: number;       // 平均延迟
  minLatency: number;       // 最小延迟
  maxLatency: number;       // 最大延迟
}

const MAX_RECORDS = 100;

class ApiMonitor {
  private records: LatencyRecord[] = [];
  private endpointMap: Map<string, LatencyRecord[]> = new Map();

  /**
   * 记录一次 API 请求
   */
  record(endpoint: string, method: string, latency: number, success: boolean, error?: string): void {
    const record: LatencyRecord = {
      timestamp: Date.now(),
      endpoint,
      method,
      latency,
      success,
      error
    };

    // 添加到总记录（环形缓冲区）
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.shift();
    }

    // 添加到端点记录
    if (!this.endpointMap.has(endpoint)) {
      this.endpointMap.set(endpoint, []);
    }
    const epRecords = this.endpointMap.get(endpoint)!;
    epRecords.push(record);
    if (epRecords.length > MAX_RECORDS) {
      epRecords.shift();
    }
  }

  /**
   * 获取总体统计
   */
  getStats(): MonitorStats {
    if (this.records.length === 0) {
      return {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        currentLatency: 0,
        avgLatency: 0,
        minLatency: 0,
        maxLatency: 0
      };
    }

    const latencies = this.records.map(r => r.latency);
    const successCount = this.records.filter(r => r.success).length;

    return {
      totalRequests: this.records.length,
      successCount,
      failureCount: this.records.length - successCount,
      successRate: Math.round((successCount / this.records.length) * 10000) / 100,
      currentLatency: latencies[latencies.length - 1],
      avgLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies)
    };
  }

  /**
   * 获取各端点统计
   */
  getEndpointStats(): EndpointStats[] {
    const stats: EndpointStats[] = [];

    for (const [endpoint, records] of this.endpointMap) {
      if (records.length === 0) continue;

      const latencies = records.map(r => r.latency);
      const successCount = records.filter(r => r.success).length;

      stats.push({
        endpoint,
        count: records.length,
        avgLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        minLatency: Math.min(...latencies),
        maxLatency: Math.max(...latencies),
        successRate: Math.round((successCount / records.length) * 10000) / 100,
        lastLatency: latencies[latencies.length - 1]
      });
    }

    // 按平均延迟排序
    return stats.sort((a, b) => a.avgLatency - b.avgLatency);
  }

  /**
   * 获取最近 N 条记录（用于趋势图）
   */
  getRecentRecords(count: number = 50): LatencyRecord[] {
    return this.records.slice(-count);
  }

  /**
   * 清除所有记录
   */
  clear(): void {
    this.records = [];
    this.endpointMap.clear();
  }
}

// 单例导出
export const apiMonitor = new ApiMonitor();
