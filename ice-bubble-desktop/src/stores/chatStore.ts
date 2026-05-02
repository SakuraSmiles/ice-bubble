/**
 * Chat Store — 管理 session 列表的 Pinia store
 */

import { defineStore } from 'pinia'
import { api } from '../api/client'
import type { SessionDTO } from '../api/client'

export interface SessionItem {
  sessionKey: string
  agentId: string
  agentName?: string | null
  avatar?: string | null
  label?: string
  lastMessage?: string
  lastActivity?: string
  messageCount?: number
  sessionStatus?: string | null
  channel?: string
}

export interface ChatStoreState {
  sessions: SessionItem[]
  loading: boolean
}

function mapDTOToSession(dto: SessionDTO): SessionItem {
  return {
    sessionKey: dto.session_key,
    agentId: dto.agent_id,
    agentName: dto.agent_name,
    avatar: dto.avatar,
    label: dto.label ?? undefined,
    lastMessage: dto.last_message ?? undefined,
    lastActivity: dto.last_message_at ?? undefined,
    messageCount: dto.message_count,
    sessionStatus: dto.session_status,
    channel: dto.channel,
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
        const res = await api.getUnifiedSessions()
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
