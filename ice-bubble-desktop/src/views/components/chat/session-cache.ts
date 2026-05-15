/**
 * 缓存 main agent 的 direct sessionKey，避免每次进入 /chat 都查 Gateway API。
 * 存储位置：localStorage（key: 'ice-bubble-main-session'）
 */

const STORAGE_KEY = 'ice-bubble-main-session';

export function getMainSessionKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setMainSessionKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch { /* ignore */ }
}

export function clearMainSessionKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
