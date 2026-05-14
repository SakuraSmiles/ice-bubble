/**
 * Admin 服务连接状态管理
 * 管理 desktop 与 admin 的连接状态，支持配置、检测、状态通知
 */

import { isValidUrl } from './validators';
import { setAdminUrl, setAdminAuthToken, getRawConfig } from '../config';
import { request } from '../api/client';

// ============ 类型定义 ============

export type ConnectionState =
  | 'UNCONFIGURED'   // 未配置
  | 'CONFIGURING'    // 正在测试连接
  | 'CONFIG_ERROR'   // 地址格式错误
  | 'AUTH_REQUIRED'  // 需要认证（401 + 无 token）
  | 'AUTH_FAILED'    // Token 错误
  | 'CONN_FAILED'    // 连接失败（网络/服务不可达）
  | 'CONNECTED'      // 已连接
  | 'DISCONNECTED';  // 断开（自动重连中）

export interface ConfigureResult {
  success: boolean;
  error?: 'NETWORK' | 'AUTH_REQUIRED' | 'AUTH_FAILED' | 'INVALID_URL' | 'SERVER_ERROR';
}

export interface AdminConfig {
  url: string;
  lastConnected?: number;
  authToken?: string;
}

type StateChangeCallback = (state: ConnectionState) => void;

// ============ 常量 ============

const HEALTH_CHECK_INTERVAL = 30000; // 30秒心跳检测
const DEFAULT_ADMIN_URL = 'http://localhost:13000';

// ============ 内部工具 ============

// 直接访问 Admin API（通过 request() 统一处理 auth）
async function fetchAdminApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await request(path, options);
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
  private autoDetecting = false;
  private reconnectFailCount = 0;

  constructor() {
    this.loadConfig();
  }

  // ============ 配置管理 ============

  private loadConfig(): void {
    const raw = getRawConfig();
    if (raw.url) {
      this.config = { url: raw.url, authToken: raw.authToken };
      this.currentUrl = raw.url;
      this.setState('CONFIGURING');
      this.detectConnection();
      return;
    }

    // 无配置：尝试默认地址自动检测（不保存到 Store，直到用户确认）
    this.currentUrl = DEFAULT_ADMIN_URL;
    this.autoDetectDefault();
  }

  /** 无配置时自动检测默认地址，成功则静默连接 */
  private async autoDetectDefault(): Promise<void> {
    if (this.autoDetecting) return;
    this.autoDetecting = true;
    this.setState('CONFIGURING');
    try {
      await this.fetchDirect<any>(`${DEFAULT_ADMIN_URL}/api/stats`);
      this.saveConfig(DEFAULT_ADMIN_URL);
      this.setState('CONNECTED');
      this.startHealthCheck();
    } catch {
      if (this.state === 'CONFIGURING') {
        this.currentUrl = '';
        this.setState('UNCONFIGURED');
      }
    } finally {
      this.autoDetecting = false;
    }
  }

  /** 直接 fetch 指定 URL（不依赖配置存储） */
  private async fetchDirect<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  private saveConfig(url: string): void {
    this.config = {
      url,
      lastConnected: Date.now(),
      authToken: this.config?.authToken,
    };
    this.currentUrl = url;
    setAdminUrl(url);
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
      await fetchAdminApi<any>('/stats');
      this.saveConfig(this.config.url);
      this.setState('CONNECTED');
      this.reconnectFailCount = 0;
      this.startHealthCheck();
      return true;
    } catch (err: any) {
      this.setState(this.classifyError(err));
      return false;
    }
  }

  /** 根据错误类型分类连接状态 */
  private classifyError(err: any): 'AUTH_REQUIRED' | 'AUTH_FAILED' | 'CONN_FAILED' {
    const msg = err?.message || '';
    if (msg.includes('401')) {
      return this.config?.authToken ? 'AUTH_FAILED' : 'AUTH_REQUIRED';
    }
    if (err instanceof TypeError) {
      // fetch 本身失败（网络不通）
      return 'CONN_FAILED';
    }
    return 'CONN_FAILED';
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(async () => {
      if (!this.config?.url) return;
      try {
        await fetchAdminApi<any>('/stats');
        this.reconnectFailCount = 0;
        if (this.state !== 'CONNECTED') {
          this.setState('CONNECTED');
        }
      } catch (err: any) {
        if (this.state === 'CONNECTED') {
          this.reconnectFailCount = 0;
          this.setState('DISCONNECTED');
        } else if (this.state === 'DISCONNECTED') {
          this.reconnectFailCount++;
          if (this.reconnectFailCount >= 5) {
            this.setState('CONN_FAILED');
          }
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

  getState(): ConnectionState {
    return this.state;
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  getConfig(): AdminConfig | null {
    return this.config;
  }

  getCurrentToken(): string {
    return this.config?.authToken || '';
  }

  getReconnectFailCount(): number {
    return this.reconnectFailCount;
  }

  /**
   * 配置并测试连接
   * @param url Admin 服务地址
   * @param authToken 可选的鉴权 token
   * @returns ConfigureResult 包含成功/失败及错误分类
   */
  async configure(url: string, authToken?: string): Promise<ConfigureResult> {
    if (!isValidUrl(url)) {
      this.currentUrl = url;
      this.setState('CONFIG_ERROR');
      return { success: false, error: 'INVALID_URL' };
    }

    this.setState('CONFIGURING');
    try {
      const headers: Record<string, string> = {};
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      await this.fetchDirect<any>(`${url.replace(/\/+$/, '')}/api/stats`, { headers });
      this.saveConfig(url);
      if (authToken) {
        setAdminAuthToken(authToken);
      }
      this.setState('CONNECTED');
      this.reconnectFailCount = 0;
      this.startHealthCheck();
      return { success: true };
    } catch (err: any) {
      const msg = err?.message || '';
      let error: ConfigureResult['error'] = 'NETWORK';
      if (msg.includes('401')) {
        error = authToken ? 'AUTH_FAILED' : 'AUTH_REQUIRED';
        this.saveConfig(url);
        if (authToken) {
          setAdminAuthToken(authToken);
        }
        this.setState(error === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'AUTH_REQUIRED');
        return { success: false, error };
      }
      if (msg.includes('5')) {
        error = 'SERVER_ERROR';
      } else if (err instanceof TypeError) {
        error = 'NETWORK';
      }
      this.saveConfig(url);
      this.setState('CONN_FAILED');
      return { success: false, error };
    }
  }

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

  onStateChange(callback: StateChangeCallback): () => void {
    this.subscribers.add(callback);
    callback(this.state);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  destroy(): void {
    this.autoDetecting = false;
    this.stopHealthCheck();
    this.subscribers.clear();
  }
}

// 单例导出
export const adminConnection = new AdminConnection();
