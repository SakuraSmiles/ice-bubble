/**
 * Admin 服务连接状态管理
 * 管理 desktop 与 admin 的连接状态，支持配置、检测、状态通知
 */

import { isValidUrl } from './validators';
import { getAdminUrl, setAdminUrl, getAdminAuthToken } from '../config';

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
  authToken?: string;
}

type StateChangeCallback = (state: ConnectionState) => void;

// ============ 常量 ============

const STORAGE_KEY = 'ice-bubble-admin-config';
const HEALTH_CHECK_INTERVAL = 30000; // 30秒心跳检测
const DEFAULT_ADMIN_URL = 'http://localhost:13000';

// ============ 内部工具 ============

// 直接访问 Admin API（不再通过本地代理）
async function fetchAdminApi<T>(path: string, options?: RequestInit): Promise<T> {
  const adminUrl = getAdminUrl();
  const authToken = getAdminAuthToken();
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${adminUrl}${path}`, {
    ...options,
    headers,
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
  private autoDetecting = false;

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
        this.detectConnection();
        return;
      }
    } catch {
      this.config = null;
    }

    // 无配置：尝试默认地址自动检测（不保存到 localStorage，直到用户确认）
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

  /** 直接 fetch 指定 URL（不依赖 localStorage 配置） */
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    // 同步更新 config/index.ts 的 API_BASE
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

  getState(): ConnectionState {
    return this.state;
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  getConfig(): AdminConfig | null {
    return this.config;
  }

  /**
   * 配置并测试连接
   * @param url Admin 服务地址
   * @param authToken 可选的鉴权 token
   * @returns 是否连接成功
   */
  async configure(url: string, authToken?: string): Promise<boolean> {
    if (!isValidUrl(url)) {
      this.currentUrl = url;
      this.setState('CONFIG_ERROR');
      return false;
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
        // 保存 token 到 localStorage
        const raw = localStorage.getItem(STORAGE_KEY);
        const existing = raw ? JSON.parse(raw) : {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          ...existing,
          authToken,
        }));
      }
      this.setState('CONNECTED');
      this.startHealthCheck();
      return true;
    } catch {
      this.saveConfig(url);
      this.setState('CONN_FAILED');
      return false;
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
