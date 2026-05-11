<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { Plus, Delete, DArrowLeft, Folder, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import FileTree from '@/components/FileTree.vue'

const store = useWorkspaceStore()

// 面板展开/收缩状态，默认收缩
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

// ====== 添加工作空间对话框 ======
const dialogVisible = ref(false)
const scanBasePath = ref('/mnt/d/workspace')
const directoryList = ref<{ name: string; path: string }[]>([])
const selectedDirectory = ref<{ name: string; path: string } | null>(null)
const workspaceName = ref('')
const isScanning = ref(false)
const scanError = ref('')

// 目录列表 ref（用于键盘聚焦）
const directoryListRef = ref<HTMLElement | null>(null)

// 过滤关键字
const filterKeyword = ref('')

// 高亮匹配文本（用于目录名渲染）
function highlightText(text: string, keyword: string): string {
  if (!keyword.trim()) return text
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  return text.replace(regex, '<span class="filter-highlight">$1</span>')
}

// 过滤后的目录列表
const filteredDirectories = computed(() => {
  const keyword = filterKeyword.value.trim().toLowerCase()
  let dirs = [...directoryList.value]
  if (keyword) {
    dirs = dirs.filter(d => d.name.toLowerCase().includes(keyword))
    dirs.sort((a, b) => {
      const posA = a.name.toLowerCase().indexOf(keyword)
      const posB = b.name.toLowerCase().indexOf(keyword)
      if (posA !== posB) return posA - posB
      return a.name.localeCompare(b.name)
    })
  }
  return dirs
})

// 面包屑计算
const breadcrumbs = computed(() => {
  const parts = scanBasePath.value.split('/').filter(Boolean)
  const crumbs = [{ label: '/', path: '/' }]
  let accumulated = ''
  for (const part of parts) {
    accumulated += '/' + part
    crumbs.push({ label: part, path: accumulated })
  }
  return crumbs
})

// 跳转到面包屑路径
function navigateToBreadcrumb(path: string) {
  scanBasePath.value = path
}

// 键盘处理函数
function handleDirectoryKeydown(e: KeyboardEvent) {
  if (directoryList.value.length === 0) return
  const currentIndex = selectedDirectory.value
    ? directoryList.value.findIndex(d => d.path === selectedDirectory.value!.path)
    : -1

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const nextIndex = currentIndex < directoryList.value.length - 1 ? currentIndex + 1 : 0
    selectedDirectory.value = directoryList.value[nextIndex]
    workspaceName.value = directoryList.value[nextIndex].name
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : directoryList.value.length - 1
    selectedDirectory.value = directoryList.value[prevIndex]
    workspaceName.value = directoryList.value[prevIndex].name
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (selectedDirectory.value) {
      confirmAddWorkspace()
    } else if (directoryList.value.length > 0) {
      enterDirectory(directoryList.value[0])
    }
  }
}

// 打开添加工作空间对话框
async function openAddWorkspaceDialog() {
  dialogVisible.value = true
  scanBasePath.value = '/mnt/d/workspace'
  directoryList.value = []
  selectedDirectory.value = null
  workspaceName.value = ''
  scanError.value = ''
  filterKeyword.value = ''
  await scanDirectories()
}

// 关闭对话框
function closeDialog() {
  dialogVisible.value = false
}

// 扫描目录
async function scanDirectories() {
  isScanning.value = true
  scanError.value = ''
  selectedDirectory.value = null
  workspaceName.value = ''

  try {
    const url = `/api/workspace/scan?base=${encodeURIComponent(scanBasePath.value)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    // 过滤隐藏目录（以.开头）
    directoryList.value = (data.directories || []).filter((d: { name: string }) => !d.name.startsWith('.'))
  } catch {
    scanError.value = '扫描失败，请检查路径是否可访问'
    directoryList.value = []
  } finally {
    isScanning.value = false
  }
}

// 进入子目录
function enterDirectory(dir: { name: string; path: string }) {
  scanBasePath.value = dir.path
  // watch 会触发 scanDirectories
}

// 返回上级目录
function goBack() {
  const parts = scanBasePath.value.split('/').filter(Boolean)
  if (parts.length <= 1) return
  parts.pop()
  scanBasePath.value = '/' + parts.join('/')
}

// 切换扫描路径时自动重新扫描
watch(scanBasePath, () => {
  if (dialogVisible.value) {
    scanDirectories()
  }
})

// 选择目录
function selectDirectory(dir: { name: string; path: string }) {
  selectedDirectory.value = dir
  workspaceName.value = dir.name
}

// 添加工作空间
function confirmAddWorkspace() {
  if (!selectedDirectory.value) {
    ElMessage.warning('请选择一个目录')
    return
  }
  const name = workspaceName.value.trim() || selectedDirectory.value.name
  store.addWorkspace(name, selectedDirectory.value.path)

  ElMessage.success(`工作空间「${name}」已添加`)
  closeDialog()
}

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

// ====== Git Status 获取 ======
interface GitStatusInfo {
  branch: string
  modified: number
  added: number
  deleted: number
  untracked: number
}

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

function getGitStatus(wsId: string): GitStatusInfo | null {
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

const panelWidth = ref(320)
const PANEL_MIN = 200
const PANEL_MAX = 500
const isDraggingPanel = ref(false)

function startDragPanel(e: MouseEvent) {
  e.preventDefault()
  isDraggingPanel.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value

  const onMove = (ev: MouseEvent) => {
    // 右侧面板：向左拖 = 增大，向右拖 = 减小
    const delta = startX - ev.clientX
    panelWidth.value = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startWidth + delta))
  }
  const onUp = () => {
    isDraggingPanel.value = false
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
</script>

<template>
  <!-- 右侧：居中切换按钮（标签页风格，与左侧对称） -->
  <div
    class="panel-toggle toggle-right"
    :class="[
      expanded ? 'toggle-collapse' : 'toggle-expand',
      { 'no-transition': isDraggingPanel }
    ]"
    :style="expanded ? { right: (panelWidth - 1) + 'px' } : {}"
    @click="expanded = !expanded"
    :title="expanded ? '收起工作区' : '展开工作区'"
  >
    <span class="toggle-arrow">{{ expanded ? '▸' : '◂' }}</span>
  </div>

  <div class="workspace-panel" :style="{ width: effectivePanelWidth + 'px' }" :class="{ 'no-transition': isDraggingPanel }" v-show="expanded">
    <!-- 左边缘拖拽手柄 -->
    <div
      class="resize-handle resize-handle-left"
      :class="{ active: isDraggingPanel }"
      @mousedown="startDragPanel"
    />
    <!-- 头部：标题 + 操作按钮 -->
    <div class="panel-header">
      <span class="panel-title">工作区</span>
      <div class="panel-actions">
        <el-button
          :icon="Plus"
          circle
          text
          size="small"
          title="添加工作空间"
          @click="openAddWorkspaceDialog"
        />
      </div>
    </div>

    <!-- 内容区 -->
        <div class="panel-content" v-if="dataReady">
          <!-- 有工作空间：多根节点列表 -->
          <template v-if="store.workspaces.length > 0">
            <div class="workspace-list">
              <div
                v-for="ws in store.workspaces"
                :key="ws.id"
                class="workspace-root"
              >
                <!-- 工作空间根节点行（作为树的根节点） -->
                <div class="workspace-root-header tree-node-item">
                  <el-icon :size="15" class="ws-root-icon"><Folder /></el-icon>
                  <span class="ws-path" :title="ws.path">{{ ws.path.split('/').filter(Boolean).pop() }}</span>
                  <div class="ws-right-info">
                    <!-- git 分支标签 -->
                    <span
                      v-if="getGitStatus(ws.id)?.branch"
                      class="ws-branch-tag"
                    >{{ getGitStatus(ws.id)?.branch }}</span>
                    <!-- 变更统计 -->
                    <span
                      v-if="formatChangeStats(ws.id)"
                      class="ws-change-stats"
                    >{{ formatChangeStats(ws.id) }}</span>
                    <!-- 删除按钮 -->
                    <el-button
                      class="ws-delete-btn"
                      :icon="Delete"
                      circle
                      text
                      size="small"
                      title="删除工作空间"
                      @click.stop="deleteWorkspace(ws.id, ws.name)"
                    />
                  </div>
                </div>

                <!-- 文件树（始终展示） -->
                <div class="workspace-tree">
                  <FileTree
                    :key="ws.id"
                    :workspace-path="ws.path"
                  />
                </div>
              </div>
            </div>
          </template>

          <!-- 无工作空间：空状态 -->
          <template v-else>
            <div class="empty-state">
              <span>点击上方按钮添加工作空间</span>
            </div>
          </template>
        </div>

    <!-- 添加工作空间对话框 -->
    <el-dialog
      v-model="dialogVisible"
      title="添加工作空间"
      width="440px"
      :close-on-click-modal="false"
      @close="closeDialog"
      @keydown.esc="closeDialog"
      class="workspace-dialog"
    >
      <!-- 面包屑导航 -->
      <div class="breadcrumb-row">
        <div class="breadcrumbs">
          <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
            <span
              v-if="index > 0"
              class="breadcrumb-sep"
            >/</span>
            <span
              class="breadcrumb-item"
              :class="{ 'breadcrumb-last': index === breadcrumbs.length - 1 }"
              @click="navigateToBreadcrumb(crumb.path)"
            >{{ crumb.label }}</span>
          </template>
        </div>
        <el-button
          :icon="DArrowLeft"
          circle
          text
          size="small"
          title="返回上级目录"
          :disabled="scanBasePath === '/'"
          @click="goBack"
        />
      </div>

      <!-- 过滤框 -->
      <div class="filter-row">
        <el-input
          v-model="filterKeyword"
          placeholder="搜索目录..."
          size="small"
          :prefix-icon="Search"
          clearable
        />
      </div>

      <!-- 目录列表（固定高度300px） -->
      <div class="dialog-field">
        <div v-if="scanError" class="scan-error">{{ scanError }}</div>
        <div v-else-if="isScanning" class="scan-loading">扫描中...</div>
        <div v-else-if="filteredDirectories.length === 0 && directoryList.length === 0" class="scan-empty">该路径下未找到子目录</div>
        <div v-else-if="filteredDirectories.length === 0" class="scan-empty">暂无目录</div>
        <div
          v-else
          ref="directoryListRef"
          class="directory-list"
          tabindex="0"
          @keydown="handleDirectoryKeydown"
        >
          <div
            v-for="dir in filteredDirectories"
            :key="dir.path"
            class="directory-item"
            :class="{ selected: selectedDirectory?.path === dir.path }"
            @click="selectDirectory(dir)"
            @dblclick="enterDirectory(dir)"
          >
            <el-icon class="dir-icon"><Folder /></el-icon>
            <span class="dir-name" v-html="highlightText(dir.name, filterKeyword)" />
          </div>
        </div>
      </div>

      <!-- 底部紧凑信息 -->
      <div class="dialog-bottom">
        <div class="bottom-row">
          <span class="bottom-label">已选:</span>
          <span class="bottom-path">{{ selectedDirectory?.path || '（未选择）' }}</span>
        </div>
        <div class="bottom-row">
          <span class="bottom-label">名称:</span>
          <el-input
            v-model="workspaceName"
            placeholder="自动填入目录名，可手动修改"
            clearable
            size="small"
          />
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="closeDialog">取消</el-button>
          <el-button type="primary" @click="confirmAddWorkspace">添加</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.workspace-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.2s ease;
  overflow: hidden;
  background: var(--color-bg-canvas);
  border-left: 1px solid var(--color-border-subtle);
  box-shadow: none;
  position: relative;
}

/* 拖拽手柄 */
.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  z-index: 10;
  cursor: col-resize;
  transition: background 0.15s;
}

.resize-handle:hover {
  background: transparent;
}

.resize-handle-left:hover {
  box-shadow: -4px 0 12px rgba(0, 0, 0, 0.1);
}

.resize-handle-right:hover {
  box-shadow: 4px 0 12px rgba(0, 0, 0, 0.1);
}

.resize-handle-left {
  left: -2px;
}

.resize-handle-right {
  right: -2px;
}

/* ====== 右侧切换按钮（标签页风格，与左侧对称） ====== */
.panel-toggle {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 20;
  background: var(--color-bg-canvas);
  transition: all 0.15s ease;
}

.panel-toggle:hover {
  background: var(--el-fill-color-light);
}

/* 右侧方向 */
.toggle-right {
  border: 1px solid var(--color-border-subtle);
  border-right: none;
  border-radius: 8px 0 0 8px;
  box-shadow: -1px 0 3px rgba(0, 0, 0, 0.05);
}

.toggle-right:hover {
  box-shadow: -1px 0 6px rgba(0, 0, 0, 0.1);
}

/* 展开（面板隐藏，按钮贴右边缘） */
.toggle-right.toggle-expand {
  right: 0;
}

/* 收起（面板显示，按钮在面板左边缘） */
.toggle-right.toggle-collapse {
  transition: right 0.2s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.toggle-arrow {
  font-size: 10px;
  color: var(--color-text-tertiary);
  transition: color 0.15s;
}

.panel-toggle:hover .toggle-arrow {
  color: var(--color-text);
}

.no-transition {
  transition: none !important;
}

/* 头部 */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.3px;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 内容区 */
.panel-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 工作空间列表 */
.workspace-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 工作空间根节点 */
.workspace-root {
  border-bottom: none;
}

.workspace-root-header {
  display: flex;
  align-items: center;
  height: 26px;
  padding: 0 8px 0 12px;
  background: var(--color-bg-canvas);
  border-bottom: none;
  gap: 0;
  user-select: none;
  cursor: pointer;
}

.ws-root-icon {
  flex-shrink: 0;
  margin-right: 4px;
  color: #909399;
}

.ws-path {
  font-size: 13px;
  font-weight: 700;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.ws-right-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.ws-branch-tag {
  font-size: 11px;
  color: #606266;
  background: #f0f2f5;
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

.ws-change-stats {
  font-size: 11px;
  color: #909399;
  white-space: nowrap;
}

.ws-delete-btn {
  font-size: 12px !important;
  color: var(--color-text-tertiary) !important;
  opacity: 0;
  transition: opacity 0.12s;
  padding: 2px !important;
  width: 20px !important;
  height: 20px !important;
}

.workspace-root-header:hover .ws-delete-btn {
  opacity: 1;
}

/* 文件树（与根节点无缝衔接） */
.workspace-tree {
  /* 无额外边框/间距，与根节点视觉上是一体 */
}

/* 空状态 */
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--color-text-tertiary);
  text-align: center;
  padding: 0 16px;
}

/* ====== 添加工作空间对话框 ====== */
:deep(.workspace-dialog) {
  border-radius: 6px;
}

:deep(.workspace-dialog .el-dialog__header) {
  padding: 16px 20px 8px;
}

:deep(.workspace-dialog .el-dialog__body) {
  padding: 0 20px 16px;
}

:deep(.workspace-dialog .el-dialog__title) {
  font-size: 16px;
  font-weight: 500;
}
.breadcrumb-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  gap: 8px;
}

.breadcrumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0;
  flex: 1;
  min-width: 0;
}

.breadcrumb-item {
  font-size: 13px;
  color: #606266;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  transition: color 0.12s;
  white-space: nowrap;
}

.breadcrumb-item:hover {
  color: #409eff;
}

.breadcrumb-item.breadcrumb-last {
  color: #303133;
  font-weight: 600;
  cursor: default;
}

.breadcrumb-item.breadcrumb-last:hover {
  color: #303133;
}

.breadcrumb-sep {
  font-size: 13px;
  color: #c0c4cc;
  margin: 0 1px;
  user-select: none;
}

/* 过滤框 */
.filter-row {
  margin-bottom: 8px;
}

.filter-row .el-input {
  --el-input-border-color: #e4e7ed;
  --el-input-border-radius: 4px;
  --el-input-height: 32px;
  font-size: 13px;
}

.filter-row .el-input:focus-within {
  --el-input-border-color: #409eff;
}

.directory-list {
  height: 300px;
  overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  outline: none;
}

.directory-list:focus {
  border-color: var(--el-color-primary, #409eff);
}

.directory-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 34px;
  cursor: pointer;
  transition: background-color 0.12s;
  border-bottom: 1px solid var(--color-border-subtle);
  box-sizing: border-box;
}

.directory-item:last-child {
  border-bottom: none;
}

.directory-item:hover {
  background: #f5f7fa;
}

.directory-item.selected {
  background: #f0f7ff;
  border-left: 3px solid #409eff;
  padding-left: 9px;
}

.dir-icon {
  font-size: 16px;
  flex-shrink: 0;
  color: #909399;
}

.directory-item.selected .dir-icon {
  color: #409eff;
}

.dir-name {
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 高亮关键字 */
.filter-highlight {
  color: #409eff;
  font-weight: 500;
}

.scan-error {
  font-size: 13px;
  color: #f56c6c;
  padding: 8px 0;
}

.scan-loading,
.scan-empty {
  font-size: 13px;
  color: #c0c4cc;
  padding: 8px 0;
  text-align: center;
}

/* 底部紧凑信息 */
.dialog-bottom {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bottom-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bottom-label {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
  width: 36px;
}

.bottom-path {
  font-size: 12px;
  color: #606266;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.bottom-row .el-input {
  flex: 1;
  --el-input-height: 30px;
  font-size: 13px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* dialog-field 已废弃，仅保留兼容 */
.dialog-field {
  margin-bottom: 0;
}
</style>
