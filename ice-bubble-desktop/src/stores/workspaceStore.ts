/**
 * Workspace Store — 管理工作空间配置的 Pinia store
 *
 * 存储策略（与 config/index.ts 一致）：
 * - Tauri 环境 → @tauri-apps/plugin-store（workspace.json，重装不丢失）
 * - Dev 环境   → localStorage fallback（key: workspace-configs）
 * - 首次 Tauri 启动时自动从 localStorage 迁移旧数据
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

const LS_KEY = 'workspace-configs'
const STORE_FILE = 'workspace.json'

// ============ 内部状态 ============

let isTauri = false
let store: any = null // Tauri Store 实例

// ============ localStorage fallback（dev 模式） ============

function lsGet(): { workspaces: WorkspaceConfig[]; currentWorkspaceId: string | null } | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
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
  return null
}

function lsSet(workspaces: WorkspaceConfig[], currentWorkspaceId: string | null): void {
  localStorage.setItem(LS_KEY, JSON.stringify({ workspaces, currentWorkspaceId }))
}

function lsRemove(): void {
  localStorage.removeItem(LS_KEY)
}

// ============ 工具函数 ============

function generateId(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function defaultState(): WorkspaceStoreState {
  return { workspaces: [], currentWorkspaceId: null }
}

// ============ 初始化 ============

/**
 * 初始化 workspace 存储，必须在 initConfig() 之后调用。
 * Tauri 环境：打开 workspace.json Store，迁移 localStorage 旧数据（如有）。
 * Dev 环境：从 localStorage 加载。
 */
export async function initWorkspaceStore(): Promise<WorkspaceStoreState> {
  isTauri = !!(window as any).__TAURI_INTERNALS__

  if (isTauri) {
    try {
      const { load } = await import('@tauri-apps/plugin-store')
      store = await load(STORE_FILE)

      // 从 Store 加载
      const saved = (await store.get('data' as string)) as WorkspaceStoreState | null
      const state = saved ?? defaultState()

      // 一次性迁移：如果 Store 为空但 localStorage 有旧数据
      if (state.workspaces.length === 0 && !state.currentWorkspaceId) {
        const lsData = lsGet()
        if (lsData && (lsData.workspaces.length > 0 || lsData.currentWorkspaceId)) {
          await store.set('data', lsData)
          await store.save()
          lsRemove()
          return lsData
        }
      }

      return state
    } catch (e) {
      console.warn('[workspaceStore] Tauri Store 初始化失败，fallback 到 localStorage:', e)
      isTauri = false
    }
  }

  // Dev 模式 或 Store fallback：从 localStorage 加载
  return lsGet() ?? defaultState()
}

// ============ 持久化 ============

async function persist(workspaces: WorkspaceConfig[], currentWorkspaceId: string | null): Promise<void> {
  if (isTauri && store) {
    await store.set('data', { workspaces, currentWorkspaceId })
    await store.save()
  } else {
    lsSet(workspaces, currentWorkspaceId)
  }
}

// ============ Pinia Store ============

let initialized = false

export const useWorkspaceStore = defineStore('workspace', {
  state: (): WorkspaceStoreState => {
    if (initialized) {
      return defaultState()
    }
    // 首次创建时返回空状态，initWorkspaceStore 会通过 $patch 填充真实数据
    return defaultState()
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
      await persist(this.workspaces, this.currentWorkspaceId)
      return ws
    },

    /** 删除指定 ID 的工作空间 */
    async removeWorkspace(id: string): Promise<void> {
      const idx = this.workspaces.findIndex((ws) => ws.id === id)
      if (idx === -1) return

      this.workspaces.splice(idx, 1)

      // 删的是当前选中项，重新选中第一个
      if (this.currentWorkspaceId === id) {
        this.currentWorkspaceId = this.workspaces[0]?.id ?? null
      }
      await persist(this.workspaces, this.currentWorkspaceId)
    },

    /** 切换当前工作空间 */
    async selectWorkspace(id: string): Promise<void> {
      if (!this.workspaces.find((ws) => ws.id === id)) return
      this.currentWorkspaceId = id
      await persist(this.workspaces, this.currentWorkspaceId)
    },

    /** 持久化（供外部手动调用） */
    async save(): Promise<void> {
      await persist(this.workspaces, this.currentWorkspaceId)
    },
  },
})

// 监听其他标签页的 storage 变化，实现多标签页同步（仅 dev 模式）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === LS_KEY && !isTauri) {
      const lsData = lsGet()
      if (lsData) {
        const store = useWorkspaceStore()
        store.$patch(lsData)
      }
    }
  })
}
