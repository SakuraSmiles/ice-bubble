/**
 * 通用格式化工具函数
 */

/**
 * 格式化日期时间为 YYYY-MM-DD HH:MM
 */
export function formatTime(dateString: string | null | undefined): string {
  if (!dateString) return '-';
  try {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return '-';
  }
}

/**
 * 格式化相对时间（如"刚刚"、"5分钟前"、"3天前"）
 */
export function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return '-';
  const now = Date.now();
  const date = new Date(dateString).getTime();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return formatTime(dateString);
}

/**
 * 格式化数字（大数简写）
 */
export function formatNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

/**
 * 根据最后活跃时间获取状态标签
 */
export function getActivityStatus(lastActiveAt: string | null): { label: string; type: string } {
  if (!lastActiveAt) return { label: '失联', type: 'danger' };
  const now = Date.now();
  const date = new Date(lastActiveAt).getTime();
  const diff = now - date;
  const hours = diff / 3600000;
  if (hours < 24) return { label: '活跃', type: 'success' };
  if (hours < 72) return { label: '休假', type: 'warning' };
  return { label: '离线', type: 'info' };
}

/**
 * 截断路径，保留首尾段
 */
export function truncatePath(path: string | null): string {
  if (!path) return '-';
  if (path.length <= 35) return path;
  const parts = path.split('/');
  if (parts.length <= 5) return path;
  return parts.slice(0, 2).join('/') + '/.../' + parts.slice(-3).join('/');
}
