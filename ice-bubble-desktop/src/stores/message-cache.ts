/**
 * MessageCache — 消息内存缓存
 *
 * 按 sessionKey 缓存消息列表及相关状态。
 * 内置 LRU 淘汰，最多保留 MAX_SESSIONS 个会话的消息。
 */

import type { TimelineMessage } from '@/views/components/chat/types'

export interface CachedSession {
  messages: TimelineMessage[]
  knownIds: string[]          // 序列化的 Set（Set 不易从 ref 恢复）
  idAlias?: Array<[string, string]>  // 序列化的 Map（aliasId → canonicalId）
  hasMore: boolean
  adminPageCursor: string | null
  agentAvatar: string | null
  cachedAt: number
}

const MAX_SESSIONS = 5

class MessageCache {
  private readonly _map = new Map<string, CachedSession>()

  get(key: string): CachedSession | undefined {
    if (!this._map.has(key)) return undefined
    const val = this._map.get(key)!
    // LRU: 移到末尾
    this._map.delete(key)
    this._map.set(key, val)
    return val
  }

  set(key: string, value: CachedSession): void {
    if (this._map.has(key)) this._map.delete(key)
    this._map.set(key, value)
    while (this._map.size > MAX_SESSIONS) {
      const oldest = this._map.keys().next().value!
      this._map.delete(oldest)
    }
  }

  delete(key: string): void {
    this._map.delete(key)
  }

  has(key: string): boolean {
    return this._map.has(key)
  }
}

export const messageCache = new MessageCache()
