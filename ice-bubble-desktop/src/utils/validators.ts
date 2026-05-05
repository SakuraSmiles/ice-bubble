/**
 * URL 校验工具函数
 * 统一管理 desktop 应用中的 URL 校验逻辑
 */

/**
 * 校验主机名是否为合法的服务地址
 * 支持：localhost、IPv4、标准域名（FQDN）
 */
function isValidHostname(host: string): boolean {
  if (host === 'localhost') return true;
  // IPv4: x.x.x.x
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return host.split('.').map(Number).every(p => p <= 255);
  }
  // FQDN: 至少包含一个点，由字母数字和连字符组成
  // 每段 1-63 字符，总长不超过 253
  if (host.length > 253) return false;
  const fqdnPattern = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return fqdnPattern.test(host);
}

/**
 * 校验 URL 是否为有效的 Collector/Admin 服务地址
 * 规则：
 * - 必须是 http:// 或 https://
 * - 主机名必须是 localhost、有效 IP 或标准域名（FQDN）
 * - 端口必须在 1-65535 范围内
 */
export function isUrlValid(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!isValidHostname(parsed.hostname)) return false;
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
