/**
 * 缓存 main agent 的 direct sessionKey，避免每次进入 /chat 都查 Gateway API。
 * 存储位置：localStorage（key: 'ice-bubble-main-session'）
 *
 * P0-3 fix: Only accept main session keys matching `^agent:[^:]+:main$` to prevent
 * cache pollution from direct sessions that could cause message misrouting.
 */

const STORAGE_KEY = 'ice-bubble-main-session';
const MAIN_KEY_PATTERN = /^agent:[^:]+:main$/;

function isValidMainKey(key: string | null): key is string {
  return !!key && MAIN_KEY_PATTERN.test(key);
}

export function getMainSessionKey(): string | null {
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    // Validate format — stale/wrong keys are treated as missing
    return isValidMainKey(cached) ? cached : null;
  } catch {
    return null;
  }
}

export function setMainSessionKey(key: string): void {
  try {
    // Only cache valid main session keys; reject direct sessions
    if (!isValidMainKey(key)) return;
    localStorage.setItem(STORAGE_KEY, key);
  } catch { /* ignore */ }
}

export function clearMainSessionKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
