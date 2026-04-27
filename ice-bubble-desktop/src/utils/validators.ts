/**
 * URL 校验工具函数
 * 统一管理 desktop 应用中的 URL 校验逻辑
 */

/**
 * 校验 URL 是否为有效的 Collector/Admin 服务地址
 * 规则：
 * - 必须是 http:// 或 https://
 * - 主机名必须是 localhost 或有效 IP
 * - 端口必须在 1-65535 范围内
 */
export function isUrlValid(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname;
    const isLocalhost = host === 'localhost';
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
    if (!isLocalhost && !isIp) return false;
    if (isIp) {
      const parts = host.split('.').map(Number);
      if (parts.some(p => p > 255)) return false;
    }
    const port = parseInt(parsed.port, 10);
    if (!port || port < 1 || port > 65535) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验 URL 是否有效（别名，保持向后兼容）
 */
export const isValidUrl = isUrlValid;
