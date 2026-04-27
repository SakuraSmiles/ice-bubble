/**
 * Admin 服务连接状态管理
 * 管理 desktop 与 admin 的连接状态，支持配置、检测、状态通知
 */

import { isValidUrl } from './validators';

// ============ 类型定义 ============

export type ConnectionState =
  | 'UNCONFIGURED'   // 未配置
  | 'CONFIGURING'    // 正在测试连接
  | 'CONFIG_ERROR'   // 地址格式错误
  | 'CONN_FAILED'    // 连接失败
  | 'CONNECTED'      // 已连接
  | 'DISCONNECTED';  // 断开

export interface AdminConfig {
  url: string;
  lastConnected?: number;
}

type StateChangeCallback = (state: ConnectionState) => void;

// ============ 常量 ============

const STORAGE_KEY = 'ice-bubble-admin-config';
const HEALTH_CHECK_INTERVAL = 30000; // 30秒心跳检测

// ============ 内部工具 ============

// 通过 Desktop 代理访问 Admin API（避免跨域 CORS 问题）
async function fetchAdminApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'include'
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

// ============ 状态机类 ============

class AdminConnection {
  private state: ConnectionState = 'UNCONFIGURED';
  private config: AdminConfig | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private subscribers: Set<StateChangeCallback> = new Set();
  private currentUrl: string = '';

  constructor() {
    this.loadConfig();
  }

  // ============ 配置管理 ============

  private loadConfig(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.config = JSON.parse(raw) as AdminConfig;
        this.currentUrl = this.config!.url;
        // 有配置则尝试检测连接
        this.detectConnection();
      } else {
        this.state = 'UNCONFIGURED';
      }
    } catch {
      this.config = null;
      this.state = 'UNCONFIGURED';
    }
  }

  private saveConfig(url: string): void {
    this.config = {
      url,
      lastConnected: Date.now()
    };
    this.currentUrl = url;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
  }

  // ============ 状态转换 ============

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.notifySubscribers();
    }
  }

  private notifySubscribers(): void {
    this.subscribers.forEach(cb => cb(this.state));
  }

  // ============ 连接检测 ============

  private async detectConnection(): Promise<boolean> {
    if (!this.config?.url) {
      this.setState('UNCONFIGURED');
      return false;
    }

    this.setState('CONFIGURING');
    try {
      // 优先调用 /stats 接口检测
      await fetchAdminApi<any>('/stats');
      this.saveConfig(this.config.url);
      this.setState('CONNECTED');
      this.startHealthCheck();
      return true;
    } catch {
      this.setState('CONN_FAILED');
      return false;
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(async () => {
      if (!this.config?.url) return;
      try {
        await fetchAdminApi<any>('/stats');
        if (this.state !== 'CONNECTED') {
          this.setState('CONNECTED');
        }
      } catch {
        if (this.state === 'CONNECTED') {
          this.setState('DISCONNECTED');
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // ============ 公开 API ============

  /**
   * 获取当前连接状态
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * 获取当前配置的 URL
   */
  getCurrentUrl(): string {
    return this.currentUrl;
  }

  /**
   * 获取配置
   */
  getConfig(): AdminConfig | null {
    return this.config;
  }

  /**
   * 配置并测试连接
   * @param url Admin 服务地址
   * @returns 是否连接成功
   */
  async configure(url: string): Promise<boolean> {
    // URL 格式校验
    if (!isValidUrl(url)) {
      this.currentUrl = url;
      this.setState('CONFIG_ERROR');
      return false;
    }

    this.setState('CONFIGURING');
    try {
      await fetchAdminApi<any>('/stats');
      this.saveConfig(url);
      this.setState('CONNECTED');
      this.startHealthCheck();
      return true;
    } catch {
      this.saveConfig(url);
      this.setState('CONN_FAILED');
      return false;
    }
  }

  /**
   * 执行一次健康检测
   */
  async checkHealth(): Promise<boolean> {
    if (!this.config?.url) {
      this.setState('UNCONFIGURED');
      return false;
    }
    try {
      await fetchAdminApi<any>('/stats');
      this.setState('CONNECTED');
      return true;
    } catch {
      this.setState('DISCONNECTED');
      return false;
    }
  }

  /**
   * 订阅状态变化
   * @param callback 状态变化回调
   * @returns 取消订阅函数
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this.subscribers.add(callback);
    // 立即通知当前状态
    callback(this.state);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * 销毁，清理定时器
   */
  destroy(): void {
    this.stopHealthCheck();
    this.subscribers.clear();
  }
}

// 单例导出
export const adminConnection = new AdminConnection();
