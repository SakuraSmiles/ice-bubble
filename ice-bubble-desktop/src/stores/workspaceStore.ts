/**
 * Workspace Store — 管理工作空间配置的 Pinia store
 * 数据持久化到 localStorage，key 为 workspace-configs
 */

import { defineStore } from 'pinia'
import { request } from '@/api/client'

export interface WorkspaceConfig {
  /** 唯一 ID */
  id: string
  /** 工作空间名称 */
  name: string
  /** 工作空间路径 */
  path: string
}

export interface WorkspaceStoreState {
  /** 工作空间列表 */
  workspaces: WorkspaceConfig[]
  /** 当前选中的工作空间 ID */
  currentWorkspaceId: string | null
}

const STORAGE_KEY = 'workspace-configs'

function generateId(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function loadFromStorage(): { workspaces: WorkspaceConfig[]; currentWorkspaceId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const data = JSON.parse(raw)
      return {
        workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
        currentWorkspaceId: data.currentWorkspaceId ?? null,
      }
    }
  } catch {
    // ignore parse errors
  }
  return { workspaces: [], currentWorkspaceId: null }
}

function saveToStorage(workspaces: WorkspaceConfig[], currentWorkspaceId: string | null): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ workspaces, currentWorkspaceId }))
}

export const useWorkspaceStore = defineStore('workspace', {
  state: (): WorkspaceStoreState => {
    const { workspaces, currentWorkspaceId } = loadFromStorage()
    return { workspaces, currentWorkspaceId }
  },

  getters: {
    currentWorkspace(): WorkspaceConfig | null {
      if (!this.currentWorkspaceId) return null
      return this.workspaces.find((ws) => ws.id === this.currentWorkspaceId) ?? null
    },

    hasWorkspaces(): boolean {
      return this.workspaces.length > 0
    },
  },

  actions: {
    /** 添加一个新工作空间（先校验路径有效性） */
    async addWorkspace(name: string, path: string): Promise<WorkspaceConfig> {
      // 调用后端 /api/workspace/tree 校验路径是否存在且为目录
      try {
        const url = `/workspace/tree?path=${encodeURIComponent(path.trim())}&depth=0`
        const res = await request(url)
        if (!res.ok) {
          if (res.status === 400 || res.status === 404) {
            throw new Error('路径无效或不存在')
          }
          throw new Error(`请求失败 (${res.status})`)
        }
      } catch (e: any) {
        throw new Error(e.message || '路径校验失败')
      }

      const ws: WorkspaceConfig = {
        id: generateId(),
        name: name.trim(),
        path: path.trim(),
      }
      this.workspaces.push(ws)
      // 首次添加自动选中
      if (this.workspaces.length === 1) {
        this.currentWorkspaceId = ws.id
      }
      this.persist()
      return ws
    },

    /** 删除指定 ID 的工作空间 */
    removeWorkspace(id: string): void {
      const idx = this.workspaces.findIndex((ws) => ws.id === id)
      if (idx === -1) return

      this.workspaces.splice(idx, 1)

      // 删的是当前选中项，重新选中第一个
      if (this.currentWorkspaceId === id) {
        this.currentWorkspaceId = this.workspaces[0]?.id ?? null
      }
      this.persist()
    },

    /** 切换当前工作空间 */
    selectWorkspace(id: string): void {
      if (!this.workspaces.find((ws) => ws.id === id)) return
      this.currentWorkspaceId = id
      this.persist()
    },

    /** 持久化到 localStorage */
    persist(): void {
      saveToStorage(this.workspaces, this.currentWorkspaceId)
    },
  },
})

// 监听其他标签页的 storage 变化，实现多标签页同步
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        try {
          const data = JSON.parse(stored)
          const store = useWorkspaceStore()
          store.$patch({
            workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
            currentWorkspaceId: data.currentWorkspaceId ?? null,
          })
        } catch { /* ignore */ }
      }
    }
  })
}
