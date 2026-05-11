<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { Plus, Delete, Folder } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import FileTree from '@/components/FileTree.vue'
import AddWorkspaceDialog from '@/components/AddWorkspaceDialog.vue'
import { useGitStatus } from '@/composables/useGitStatus'

const store = useWorkspaceStore()
const { workspaceGitStatus } = useGitStatus()

// 面板展开/收缩状态
const expanded = ref(false)
const dataReady = ref(false)

watch(expanded, (val) => {
  if (val) {
    dataReady.value = false
    setTimeout(() => { dataReady.value = true }, 220)
  } else {
    dataReady.value = false
  }
})

// 添加工作空间对话框
const dialogVisible = ref(false)

function openAddWorkspaceDialog() {
  dialogVisible.value = true
}

// 删除工作空间
async function deleteWorkspace(wsId: string, wsName: string) {
  try {
    await ElMessageBox.confirm(
      `确定要删除工作空间「${wsName}」吗？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  store.removeWorkspace(wsId)
  ElMessage.success('已删除')
}

// Git 状态辅助
function getGitStatus(wsId: string) {
  return workspaceGitStatus.value[wsId] || null
}

function formatChangeStats(wsId: string): string {
  const s = workspaceGitStatus.value[wsId]
  if (!s) return ''
  const parts: string[] = []
  if (s.modified > 0) parts.push(`${s.modified}已修改`)
  if (s.untracked > 0) parts.push(`${s.untracked}未跟踪`)
  if (s.added > 0) parts.push(`${s.added}已添加`)
  if (s.deleted > 0) parts.push(`${s.deleted}已删除`)
  return parts.join(' · ')
}

// 面板宽度拖拽
const PANEL_WIDTH_KEY = 'workspace-panel-width'
const PANEL_MIN = 200
const PANEL_MAX = 500

const panelWidth = ref(loadPanelWidth())
const isDraggingPanel = ref(false)

function loadPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY)
    if (raw) {
      const val = Number(raw)
      if (!isNaN(val) && val >= PANEL_MIN && val <= PANEL_MAX) return val
    }
  } catch { /* ignore */ }
  return 320
}

function savePanelWidth(width: number): void {
  try { localStorage.setItem(PANEL_WIDTH_KEY, String(width)) } catch { /* ignore */ }
}

function startDragPanel(e: MouseEvent) {
  e.preventDefault()
  isDraggingPanel.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value

  const onMove = (ev: MouseEvent) => {
    const delta = startX - ev.clientX
    panelWidth.value = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startWidth + delta))
  }
  const onUp = () => {
    isDraggingPanel.value = false
    savePanelWidth(panelWidth.value)
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

const effectivePanelWidth = computed(() => (expanded.value ? panelWidth.value : 0))
const existingPaths = computed(() => store.workspaces.map(w => w.path))
</script>

<template>
  <!-- 右侧：居中切换按钮 -->
  <div
    class="panel-toggle toggle-right"
    :class="[expanded ? 'toggle-collapse' : 'toggle-expand', { 'no-transition': isDraggingPanel }]"
    :style="expanded ? { right: (panelWidth - 1) + 'px' } : {}"
    @click="expanded = !expanded"
    :title="expanded ? '收起工作区' : '展开工作区'"
  >
    <span class="toggle-arrow">{{ expanded ? '▸' : '◂' }}</span>
  </div>

  <div
    class="workspace-panel"
    :style="{ width: effectivePanelWidth + 'px' }"
    :class="{ 'no-transition': isDraggingPanel }"
    v-show="expanded"
  >
    <div class="resize-handle resize-handle-left" :class="{ active: isDraggingPanel }" @mousedown="startDragPanel" />

    <div class="panel-header">
      <span class="panel-title">工作区</span>
      <div class="panel-actions">
        <el-button :icon="Plus" circle text size="small" title="添加工作空间" @click="openAddWorkspaceDialog" />
      </div>
    </div>

    <div class="panel-content" v-if="dataReady">
      <template v-if="store.workspaces.length > 0">
        <div class="workspace-list">
          <div v-for="ws in store.workspaces" :key="ws.id" class="workspace-root">
            <div class="workspace-root-header tree-node-item">
              <el-icon :size="15" class="ws-root-icon"><Folder /></el-icon>
              <span class="ws-path" :title="ws.path">{{ ws.path.split('/').filter(Boolean).pop() }}</span>
              <div class="ws-right-info">
                <span v-if="getGitStatus(ws.id)?.branch" class="ws-branch-tag">{{ getGitStatus(ws.id)?.branch }}</span>
                <span v-if="formatChangeStats(ws.id)" class="ws-change-stats">{{ formatChangeStats(ws.id) }}</span>
                <el-button class="ws-delete-btn" :icon="Delete" circle text size="small" title="删除工作空间" @click.stop="deleteWorkspace(ws.id, ws.name)" />
              </div>
            </div>
            <div class="workspace-tree">
              <FileTree :key="ws.id" :workspace-path="ws.path" />
            </div>
          </div>
        </div>
      </template>
      <template v-else>
        <div class="empty-state"><span>点击上方按钮添加工作空间</span></div>
      </template>
    </div>

    <AddWorkspaceDialog v-model="dialogVisible" :existing-paths="existingPaths" />
  </div>
</template>

<style scoped>
.workspace-panel {
  height: 100%; display: flex; flex-direction: column; flex-shrink: 0;
  transition: width 0.2s ease; overflow: hidden;
  background: var(--color-bg-canvas); border-left: 1px solid var(--color-border-subtle);
  position: relative;
}

.resize-handle {
  position: absolute; top: 0; bottom: 0; width: 4px; z-index: 10;
  cursor: col-resize; transition: background 0.15s;
}

.resize-handle-left { left: -2px; }
.resize-handle-left:hover { box-shadow: -4px 0 12px rgba(0, 0, 0, 0.1); }

.panel-toggle {
  position: fixed; top: 50%; transform: translateY(-50%); width: 20px; height: 72px;
  display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 20;
  background: var(--color-bg-canvas); transition: all 0.15s ease;
}

.panel-toggle:hover { background: var(--el-fill-color-light); }

.toggle-right {
  border: 1px solid var(--color-border-subtle); border-right: none;
  border-radius: 8px 0 0 8px; box-shadow: -1px 0 3px rgba(0, 0, 0, 0.05);
}

.toggle-right:hover { box-shadow: -1px 0 6px rgba(0, 0, 0, 0.1); }
.toggle-right.toggle-expand { right: 0; }
.toggle-right.toggle-collapse { transition: right 0.2s ease, background 0.15s ease, box-shadow 0.15s ease; }

.toggle-arrow { font-size: 10px; color: var(--color-text-tertiary); transition: color 0.15s; }
.panel-toggle:hover .toggle-arrow { color: var(--color-text); }
.no-transition { transition: none !important; }

.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 8px; border-bottom: 1px solid var(--color-border-subtle); flex-shrink: 0;
}

.panel-title { font-size: 13px; font-weight: 600; color: var(--color-text); letter-spacing: 0.3px; }
.panel-actions { display: flex; align-items: center; gap: 2px; }

.panel-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.workspace-list { flex: 1; overflow-y: auto; overflow-x: hidden; }

.workspace-root-header {
  display: flex; align-items: center; height: 26px; padding: 0 8px 0 12px;
  background: var(--color-bg-canvas); gap: 0; user-select: none; cursor: pointer;
}

.ws-root-icon { flex-shrink: 0; margin-right: 4px; color: var(--el-text-color-secondary); }

.ws-path {
  font-size: 13px; font-weight: 700; color: var(--el-text-color-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
}

.ws-right-info { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

.ws-branch-tag {
  font-size: 11px; color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter); padding: 1px 6px; border-radius: 4px; white-space: nowrap;
}

.ws-change-stats { font-size: 11px; color: var(--el-text-color-secondary); white-space: nowrap; }

.ws-delete-btn {
  font-size: 12px !important; color: var(--color-text-tertiary) !important;
  opacity: 0; transition: opacity 0.12s; padding: 2px !important;
  width: 20px !important; height: 20px !important;
}

.workspace-root-header:hover .ws-delete-btn { opacity: 1; }

.empty-state {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--color-text-tertiary); text-align: center; padding: 0 16px;
}
</style>
