/**
 * Chat Input Store — 聊天输入框内容缓存
 *
 * 按 sessionKey 缓存输入内容，切换会话或页面时自动保留/恢复。
 * 内置 LRU 淘汰策略，最多保留 MAX_ENTRIES 条缓存。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch, type Ref } from 'vue'

/** 最大缓存条数 */
const MAX_ENTRIES = 20

/**
 * 简易 LRU Map：put 时自动淘汰最久未访问的条目。
 */
class LRUMap<V> {
  private readonly _map = new Map<string, V>()

  get(key: string): V | undefined {
    if (!this._map.has(key)) return undefined
    const val = this._map.get(key)!
    this._map.delete(key)
    this._map.set(key, val)
    return val
  }

  set(key: string, value: V): void {
    if (this._map.has(key)) this._map.delete(key)
    this._map.set(key, value)
    while (this._map.size > MAX_ENTRIES) {
      const oldest = this._map.keys().next().value!
      this._map.delete(oldest)
    }
  }

  /** 删除指定 key */
  delete(key: string): boolean {
    return this._map.delete(key)
  }

  /** 清空所有条目 */
  clear(): void {
    this._map.clear()
  }

  has(key: string): boolean {
    return this._map.has(key)
  }

  get size(): number {
    return this._map.size
  }
}

export const useChatInputStore = defineStore('chat-input', () => {
  const cache = new LRUMap<string>()
  const activeSessionKey = ref('')

  /** 当前 session 的缓存输入内容 */
  const cachedText = computed(() => cache.get(activeSessionKey.value) ?? '')

  /**
   * 将一个 ref 双向绑定到 store：
   * - sessionKey 变化时，保存旧值、加载新值
   * - text 变化时，实时写入缓存
   */
  function bind(sessionKey: Ref<string>, text: Ref<string>): void {
    watch(
      sessionKey,
      (newKey, oldKey) => {
        if (oldKey && text.value) {
          cache.set(oldKey, text.value)
        }
        activeSessionKey.value = newKey
        const cached = cache.get(newKey)
        if (cached !== undefined) {
          text.value = cached
        } else if (newKey !== oldKey) {
          text.value = ''
        }
      },
      { immediate: true },
    )

    watch(text, (val) => {
      if (activeSessionKey.value) {
        cache.set(activeSessionKey.value, val)
      }
    })
  }

  /** 清除指定 session 的缓存 */
  function clear(key?: string): void {
    if (key) {
      cache.delete(key)
    } else {
      cache.clear()
    }
  }

  return { activeSessionKey, cachedText, bind, clear }
})
