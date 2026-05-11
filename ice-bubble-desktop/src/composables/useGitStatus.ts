import { ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspaceStore'

interface GitStatusInfo {
  branch: string
  modified: number
  added: number
  deleted: number
  untracked: number
}

export function useGitStatus() {
  const store = useWorkspaceStore()
  const workspaceGitStatus = ref<Record<string, GitStatusInfo>>({})

  async function fetchWorkspaceGitStatus(wsPath: string, wsId: string) {
    try {
      const resp = await fetch(
        `/api/workspace/git-status?path=${encodeURIComponent(wsPath)}`,
      )
      if (!resp.ok) return
      const data = await resp.json()
      if (data.isGitRepo) {
        workspaceGitStatus.value[wsId] = {
          branch: data.branch || '',
          modified: data.modified || 0,
          added: data.added || 0,
          deleted: data.deleted || 0,
          untracked: data.untracked || 0,
        }
      }
    } catch {
      // ignore
    }
  }

  // 监听工作空间列表变化，获取 git status
  watch(
    () => store.workspaces,
    (workspaces) => {
      for (const ws of workspaces) {
        if (!workspaceGitStatus.value[ws.id]) {
          fetchWorkspaceGitStatus(ws.path, ws.id)
        }
      }
      // 清理已删除工作空间的 status
      const wsIds = new Set(workspaces.map(w => w.id))
      for (const id of Object.keys(workspaceGitStatus.value)) {
        if (!wsIds.has(id)) {
          delete workspaceGitStatus.value[id]
        }
      }
    },
    { immediate: true, deep: true },
  )

  /** 强制刷新指定工作空间的 git 状态 */
  async function refreshGitStatus(wsPath: string, wsId: string) {
    await fetchWorkspaceGitStatus(wsPath, wsId)
  }

  return { workspaceGitStatus, refreshGitStatus }
}
