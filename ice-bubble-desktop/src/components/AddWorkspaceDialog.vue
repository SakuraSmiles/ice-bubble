<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { DArrowLeft, Folder, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { fetchJson } from '@/api/client'

const store = useWorkspaceStore()

// ====== Props & Emits ======

const props = defineProps<{
  modelValue: boolean
  existingPaths?: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  added: [config: { name: string; path: string }]
}>()

// ====== Dialog state ======

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
})

const scanBasePath = ref('/mnt/d/workspace')
const directoryList = ref<{ name: string; path: string }[]>([])
const selectedDirectory = ref<{ name: string; path: string } | null>(null)
const workspaceName = ref('')
const isScanning = ref(false)
const scanError = ref('')

// 请求版本号，用于防止面包屑快速点击导致的竞态条件
let scanVersion = 0

// 目录列表 ref（用于键盘聚焦）
const directoryListRef = ref<HTMLElement | null>(null)

// 过滤关键字
const filterKeyword = ref('')

// ====== Helpers ======

/** 将文本按关键字切分为高亮/非高亮分段数组，用于纯模板渲染，避免 v-html XSS */
function splitHighlight(text: string, keyword: string): { text: string; isHighlight: boolean }[] {
  if (!keyword.trim()) return [{ text, isHighlight: false }]
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  const parts = text.split(regex)
  return parts.map(part => ({
    text: part,
    isHighlight: part.toLowerCase() === keyword.trim().toLowerCase()
  }))
}

// ====== Computed ======

/** 过滤后的目录列表 */
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

/** 面包屑 */
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

// ====== Navigation ======

function navigateToBreadcrumb(path: string) {
  scanBasePath.value = path
}

function goBack() {
  const parts = scanBasePath.value.split('/').filter(Boolean)
  if (parts.length <= 1) return
  parts.pop()
  scanBasePath.value = '/' + parts.join('/')
}

// ====== Keyboard ======

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

// ====== Directory scanning ======

async function scanDirectories() {
  const version = ++scanVersion
  isScanning.value = true
  scanError.value = ''
  selectedDirectory.value = null
  workspaceName.value = ''

  try {
    const data = await fetchJson<{ directories: { name: string; path: string }[] }>(`/workspace/scan?base=${encodeURIComponent(scanBasePath.value)}`)
    if (version !== scanVersion) return // 已过期，丢弃乱序响应
    // 过滤隐藏目录（以.开头）
    directoryList.value = (data.directories || []).filter((d: { name: string }) => !d.name.startsWith('.'))
  } catch {
    if (version !== scanVersion) return
    scanError.value = '扫描失败，请检查路径是否可访问'
    directoryList.value = []
  } finally {
    if (version === scanVersion) isScanning.value = false
  }
}

function enterDirectory(dir: { name: string; path: string }) {
  scanBasePath.value = dir.path
  // watch 会触发 scanDirectories
}

function selectDirectory(dir: { name: string; path: string }) {
  selectedDirectory.value = dir
  workspaceName.value = dir.name
}

// 切换扫描路径时自动重新扫描
watch(scanBasePath, () => {
  if (dialogVisible.value) {
    scanDirectories()
  }
})

// ====== Dialog lifecycle ======

/** 外部调用：打开对话框并初始化 */
async function openAddDialog() {
  scanBasePath.value = '/mnt/d/workspace'
  directoryList.value = []
  selectedDirectory.value = null
  workspaceName.value = ''
  scanError.value = ''
  filterKeyword.value = ''
  await scanDirectories()
}

function closeDialog() {
  emit('update:modelValue', false)
}

// 监听 modelValue 变化，打开时初始化
watch(() => props.modelValue, (val) => {
  if (val) {
    openAddDialog()
  }
})

// ====== Confirm ======

async function confirmAddWorkspace() {
  if (!selectedDirectory.value) {
    ElMessage.warning('请选择一个目录')
    return
  }
  const name = workspaceName.value.trim() || selectedDirectory.value.name
  try {
    await store.addWorkspace(name, selectedDirectory.value.path)
    ElMessage.success(`工作空间「${name}」已添加`)
    emit('added', { name, path: selectedDirectory.value.path })
    closeDialog()
  } catch (e: any) {
    ElMessage.error(`添加失败：${e.message || '未知错误'}`)
  }
}

// ====== Expose ======
defineExpose({ openAddDialog })
</script>

<template>
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
          <span class="dir-name">
            <span v-for="(part, i) in splitHighlight(dir.name, filterKeyword)" :key="i"
              :class="{ 'filter-highlight': part.isHighlight }">{{ part.text }}</span>
          </span>
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
</template>

<style scoped>
/* ====== Dialog ====== */
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

/* ====== 面包屑 ====== */
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
  color: var(--el-text-color-regular);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  transition: color 0.12s;
  white-space: nowrap;
}

.breadcrumb-item:hover {
  color: var(--el-color-primary);
}

.breadcrumb-item.breadcrumb-last {
  color: var(--el-text-color-primary);
  font-weight: 600;
  cursor: default;
}

.breadcrumb-item.breadcrumb-last:hover {
  color: var(--el-text-color-primary);
}

.breadcrumb-sep {
  font-size: 13px;
  color: var(--el-text-color-placeholder);
  margin: 0 1px;
  user-select: none;
}

/* ====== 过滤框 ====== */
.filter-row {
  margin-bottom: 8px;
}

.filter-row :deep(.el-input__wrapper) {
  --el-input-border-color: var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  font-size: 13px;
}

.filter-row :deep(.el-input__wrapper:focus-within) {
  --el-input-border-color: var(--el-color-primary);
}

/* ====== 目录列表 ====== */
.dialog-field {
  margin-bottom: 0;
}

.directory-list {
  height: 300px;
  overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  outline: none;
}

.directory-list:focus {
  border-color: var(--el-color-primary);
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
  background: var(--el-fill-color-light);
}

.directory-item.selected {
  background: var(--el-color-primary-light-9);
  border-left: 3px solid var(--el-color-primary);
  padding-left: 9px;
}

.dir-icon {
  font-size: 16px;
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
}

.directory-item.selected .dir-icon {
  color: var(--el-color-primary);
}

.dir-name {
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 高亮关键字 */
.filter-highlight {
  color: var(--el-color-primary);
  font-weight: 500;
}

/* ====== 状态提示 ====== */
.scan-error {
  font-size: 13px;
  color: var(--el-color-danger);
  padding: 8px 0;
}

.scan-loading,
.scan-empty {
  font-size: 13px;
  color: var(--el-text-color-placeholder);
  padding: 8px 0;
  text-align: center;
}

/* ====== 底部区域 ====== */
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
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
  width: 36px;
}

.bottom-path {
  font-size: 12px;
  color: var(--el-text-color-regular);
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
