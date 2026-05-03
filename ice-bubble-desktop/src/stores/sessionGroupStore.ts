/**
 * Session Group Store — 管理会话分组的 Pinia store
 */

import { defineStore } from 'pinia'
import { api } from '../api/client'
import type { SessionGroupDTO, SessionDTO } from '../api/client'

export interface GroupedSessions {
  grouped: { group: SessionGroupDTO; sessions: SessionDTO[] }[]
  ungrouped: SessionDTO[]
}

export const useSessionGroupStore = defineStore('sessionGroup', {
  state: () => ({
    groups: [] as SessionGroupDTO[],
    loading: false,
    /** 已分组会话 key 集合，用于快速过滤未分组会话 */
    groupedKeys: new Set<string>(),
  }),

  actions: {
    async fetchGroups() {
      this.loading = true
      try {
        const res = await api.getSessionGroups()
        this.groups = res.groups ?? []
        // 重建 key 集合
        this.groupedKeys.clear()
        for (const g of this.groups) {
          if (g.members) {
            for (const m of g.members) {
              this.groupedKeys.add(m.session_key)
            }
          }
        }
      } catch (e) {
        console.error('[sessionGroupStore] fetchGroups failed:', e)
      } finally {
        this.loading = false
      }
    },

    async createGroup(name: string, icon?: string): Promise<SessionGroupDTO> {
      const group = await api.createGroup({ name, icon })
      this.groups.push(group)
      return group
    },

    async updateGroup(id: number, data: { name?: string; icon?: string; sort_order?: number }) {
      const group = await api.updateGroup(id, data)
      const idx = this.groups.findIndex(g => g.id === id)
      if (idx !== -1) this.groups[idx] = group
      return group
    },

    async deleteGroup(id: number) {
      await api.deleteGroup(id)
      const idx = this.groups.findIndex(g => g.id === id)
      if (idx !== -1) {
        const removed = this.groups.splice(idx, 1)[0]
        // 清理 groupedKeys
        if (removed.members) {
          for (const m of removed.members) {
            this.groupedKeys.delete(m.session_key)
          }
        }
      }
    },

    async addMember(groupId: number, sessionKey: string) {
      const member = await api.addGroupMember(groupId, sessionKey)
      this.groupedKeys.add(sessionKey)
      const group = this.groups.find(g => g.id === groupId)
      if (group) {
        if (!group.members) group.members = []
        group.members.push(member)
      }
    },

    async removeMember(groupId: number, sessionKey: string) {
      await api.removeGroupMember(groupId, sessionKey)
      this.groupedKeys.delete(sessionKey)
      const group = this.groups.find(g => g.id === groupId)
      if (group?.members) {
        group.members = group.members.filter(m => m.session_key !== sessionKey)
      }
    },

    /** 获取分组中的会话（从 members 关联信息构建） */
    getGroupSessions(allSessions: SessionDTO[]): GroupedSessions {
      const grouped: { group: SessionGroupDTO; sessions: SessionDTO[] }[] = []
      const sessionMap = new Map(allSessions.map(s => [s.session_key, s]))

      for (const g of this.groups) {
        const sessions: SessionDTO[] = []
        if (g.members) {
          for (const m of g.members) {
            const s = sessionMap.get(m.session_key)
            if (s) sessions.push(s)
          }
        }
        grouped.push({ group: g, sessions })
      }

      const ungrouped = allSessions.filter(s => !this.groupedKeys.has(s.session_key))

      return { grouped, ungrouped }
    },
  },
})
