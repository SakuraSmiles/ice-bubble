/**
 * Chat Store — 管理 session 列表的 Pinia store
 */

import { defineStore } from 'pinia'
import { api } from '../api/client'
import type { SessionDTO } from '../api/client'

export interface SessionItem {
  sessionKey: string
  agentId: string
  label?: string
  lastMessage?: string
  lastActivity?: string
  messageCount?: number
}

export interface ChatStoreState {
  sessions: SessionItem[]
  loading: boolean
}

function mapDTOToSession(dto: SessionDTO): SessionItem {
  return {
    sessionKey: dto.session_key,
    agentId: dto.agent_id,
    label: dto.channel,
    lastActivity: dto.last_message_at ?? undefined,
    messageCount: dto.message_count,
  }
}

export const useChatStore = defineStore('chat', {
  state: (): ChatStoreState => ({
    sessions: [],
    loading: false,
  }),

  actions: {
    async fetchSessions() {
      this.loading = true
      try {
        const res = await api.getSessions()
        this.sessions = res.sessions.map(mapDTOToSession)
      } catch (e) {
        // 不清空已有 sessions，只重置 loading 状态
        console.error('[chatStore] fetchSessions failed:', e)
      } finally {
        this.loading = false
      }
    },

    getDefaultSessionKey(): string {
      return 'agent:main:main'
    },
  },
})
