/**
 * Session Preferences Store — 侧栏会话偏好（置顶/隐藏）
 */

import { defineStore } from 'pinia'
import { api } from '../api/client'

export const useSessionPreferencesStore = defineStore('sessionPreferences', {
  state: () => ({
    pinned: [] as string[],
    hidden: [] as string[],
    loaded: false,
  }),

  actions: {
    async fetchPreferences() {
      try {
        const res = await api.getSessionPreferences()
        this.pinned = res.pinned ?? []
        this.hidden = res.hidden ?? []
        this.loaded = true
      } catch (e) {
        console.error('[sessionPreferencesStore] fetchPreferences failed:', e)
      }
    },

    async savePreferences() {
      try {
        await api.updateSessionPreferences({ pinned: this.pinned, hidden: this.hidden })
      } catch (e) {
        console.error('[sessionPreferencesStore] savePreferences failed:', e)
      }
    },

    togglePin(sessionKey: string) {
      if (this.pinned.includes(sessionKey)) {
        this.pinned = this.pinned.filter(k => k !== sessionKey)
      } else {
        this.pinned.push(sessionKey)
        // 置顶时从隐藏列表移除
        this.hidden = this.hidden.filter(k => k !== sessionKey)
      }
      this.savePreferences()
    },

    toggleHide(sessionKey: string) {
      if (this.hidden.includes(sessionKey)) {
        this.hidden = this.hidden.filter(k => k !== sessionKey)
      } else {
        this.hidden.push(sessionKey)
        // 隐藏时从置顶列表移除
        this.pinned = this.pinned.filter(k => k !== sessionKey)
      }
      this.savePreferences()
    },

    isPinned(sessionKey: string): boolean {
      return this.pinned.includes(sessionKey)
    },

    isHidden(sessionKey: string): boolean {
      return this.hidden.includes(sessionKey)
    },
  },
})
