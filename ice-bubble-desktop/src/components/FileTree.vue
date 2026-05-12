<script setup lang="ts">
/**
 * FileTree — 文件树组件
 *
 * 功能：
 * - 懒加载：初始只获取一级，展开目录时才按需获取子项
 * - 调用 /api/workspace/git-status 获取 git 统计
 * - 展开/折叠文件夹
 * - git 状态可视化（M=橙色, A=绿色, D=灰色+删除线, ?=浅灰, null=无标识）
 * - D 状态文件在同目录下排在最后
 * - 树状连接线视觉强化
 * - 首层自动展开
 */

import { ref, watch, computed } from 'vue'
import { Refresh, Folder, FolderOpened, Document } from '@element-plus/icons-vue'
import { request } from '@/api/client'

// ============ Props ============

const props = defineProps<{
  workspacePath: string
}>()

// ============ Types ============

interface TreeNode {
  name: string
  type: 'file' | 'directory'
  path: string
  size?: number
  gitStatus?: 'M' | 'A' | 'D' | '?' | null
  children: TreeNode[]
  /** 前端状态：是否已展开（仅目录有效） */
  expanded?: boolean
  /** 前端状态：子项加载中 */
  loading?: boolean
}

// ============ State ============

const treeData = ref<TreeNode[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

// ============ Helpers ============

/** 递归排序：每层目录内 D 状态排最后 */
function sortTree(nodes: TreeNode[]): TreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    const aDeleted = a.gitStatus === 'D' ? 1 : 0
    const bDeleted = b.gitStatus === 'D' ? 1 : 0
    if (aDeleted !== bDeleted) return aDeleted - bDeleted
    return a.name.localeCompare(b.name)
  })
  for (const node of sorted) {
    if (node.children) node.children = sortTree(node.children)
  }
  return sorted
}

// ============ API ============

/** 获取指定路径的一级子项 */
async function fetchChildren(parentPath: string): Promise<TreeNode[]> {
  const resp = await request(
    `/workspace/tree?path=${encodeURIComponent(parentPath)}`,
  )
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = await resp.json()
  const children: TreeNode[] = data.children || []
  for (const child of children) {
    if (child.type === 'directory') {
      child.expanded = false
      child.loading = false
      if (child.children) {
        for (const grandchild of child.children) {
          if (grandchild.type === 'directory') {
            grandchild.expanded = false
            grandchild.loading = false
          }
        }
      }
    }
  }
  return sortTree(children)
}

async function fetchRootTree() {
  if (!props.workspacePath) return

  loading.value = true
  error.value = null

  try {
    const children = await fetchChildren(props.workspacePath)
    treeData.value = children
  } catch (e: any) {
    error.value = e.message || '加载文件树失败'
    treeData.value = []
  } finally {
    loading.value = false
  }
}

function refresh() {
  // 重置所有节点的 expanded/loading 状态
  resetTreeState(treeData.value)
  loadAll()
}

function resetTreeState(nodes: TreeNode[]) {
  for (const node of nodes) {
    node.expanded = false
    node.loading = false
    if (node.children) resetTreeState(node.children)
  }
}

function loadAll() {
  fetchRootTree()
}

// ============ Watch ============

watch(() => props.workspacePath, () => {
  loadAll()
}, { immediate: true })

// ============ 懒加载展开 ============

async function toggleExpand(node: TreeNode) {
  if (node.type !== 'directory') return
  if (node.loading) return // 防重入：加载中不允许再次触发

  if (node.expanded) {
    node.expanded = false
  } else {
    node.expanded = true
    if (node.children.length === 0) {
      node.loading = true
      try {
        node.children = await fetchChildren(node.path)
      } catch {
        node.children = []
      } finally {
        node.loading = false
      }
    }
  }
}

// ============ Git 状态样式 ============

function gitStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'M': return 'M'
    case 'A': return 'A'
    case 'D': return 'D'
    case '?': return '?'
    default: return ''
  }
}

function gitStatusClass(status: string | null | undefined): string {
  switch (status) {
    case 'M': return 'git-modified'
    case 'A': return 'git-added'
    case 'D': return 'git-deleted'
    case '?': return 'git-untracked'
    default: return ''
  }
}

// ============ 构建扁平列表（带树状线信息） ============

interface IndentGuide {
  /** 该层级是否有后续兄弟节点（是否需要画竖线贯穿） */
  hasLine: boolean
  /** 该层级是否是最后一个子项 */
  isLast: boolean
}

interface FlatNode {
  node: TreeNode
  depth: number
  expanded: boolean
  hasChildren: boolean
  /** 每一级缩进的连接信息 */
  indentGuides: IndentGuide[]
}

function buildFlatList(nodes: TreeNode[], depth: number, ancestorIsLast: boolean[]): FlatNode[] {
  const result: FlatNode[] = []
  const n = nodes.length

  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1
    const node = nodes[i]

    // 构建 indentGuides：每一级的连接信息
    const indentGuides: IndentGuide[] = []
    for (let d = 0; d < depth; d++) {
      // d 层的祖先是否是 last
      const ancestorIsLastD = d < ancestorIsLast.length ? ancestorIsLast[d] : true
      indentGuides.push({
        hasLine: !ancestorIsLastD, // 祖先不是 last → 画竖线
        isLast: ancestorIsLastD,
      })
    }
    // 当前层级
    indentGuides.push({
      hasLine: !isLast, // 自己不是 last → 画竖线向下（给子节点参考）
      isLast: isLast,
    })

    const nodeExpanded = !!node.expanded
    result.push({
      node,
      depth,
      expanded: nodeExpanded,
      hasChildren: node.type === 'directory',
      indentGuides,
    })

    if (nodeExpanded && node.children.length > 0) {
      // 注意：数组拷贝，不能共享引用
      const childAncestorIsLast = [...ancestorIsLast, isLast]
      result.push(...buildFlatList(node.children, depth + 1, childAncestorIsLast))
    }
  }

  return result
}

const flatList = computed<FlatNode[]>(() => {
  return buildFlatList(treeData.value, 0, [])
})
</script>

<template>
  <div class="file-tree-root">
    <!-- 内容区 -->
    <div class="file-tree-content">
      <!-- Loading -->
      <div v-if="loading && treeData.length === 0" class="tree-loading">
        <span class="loading-text">加载中...</span>
      </div>

      <!-- Error -->
      <div v-else-if="error" class="tree-error">
        <span class="error-text">{{ error }}</span>
        <el-button size="small" text type="primary" @click="refresh">重试</el-button>
      </div>

      <!-- 空目录 -->
      <div v-else-if="flatList.length === 0" class="tree-empty">
        <span class="empty-text">目录为空</span>
      </div>

      <!-- 文件列表 -->
      <div v-else class="tree-list">
        <div
          v-for="item in flatList"
          :key="item.node.path"
          class="tree-node"
          :class="{
            'is-directory': item.node.type === 'directory',
            'is-expanded': item.expanded,
            'is-file': item.node.type === 'file',
          }"
        >
          <!-- 缩进 + 树状连接线 -->
          <div class="tree-indents">
            <!-- 每级缩进 -->
            <span
              v-for="(guide, index) in item.indentGuides"
              :key="index"
              class="tree-indent"
              :class="{ 'no-line': !guide.hasLine, 'is-last': guide.isLast }"
            >
              <!-- 竖线（非最后一项才画完整） -->
              <span v-if="!guide.isLast" class="tree-vline" />
              <!-- 最后一项：竖线只画上半（L形） -->
              <span v-else class="tree-vline tree-vline-half" />
              <!-- 当前深度的最后一项：画水平连接线 -->
              <span v-if="index === item.depth" class="tree-hline" />
            </span>
          </div>

          <!-- 箭头区域 -->
          <div class="tree-arrow-area">
            <!-- Loading -->
            <span v-if="item.node.loading" class="node-loading-icon">
              <el-icon class="is-loading" :size="14"><Refresh /></el-icon>
            </span>
            <!-- 展开/折叠箭头（仅目录） -->
            <span
              v-else-if="item.node.type === 'directory'"
              class="node-arrow"
              :class="{ expanded: item.expanded }"
              @click.stop="toggleExpand(item.node)"
            >▸</span>
          </div>

          <!-- 图标 -->
          <el-icon :size="15" class="node-icon" :class="{ 'icon-folder-opened': item.expanded && item.node.type === 'directory' }">
            <FolderOpened v-if="item.node.type === 'directory' && item.expanded" />
            <Folder v-else-if="item.node.type === 'directory'" />
            <Document v-else />
          </el-icon>

          <!-- 文件名 -->
          <span
            class="node-name"
            :class="[
              item.node.type === 'directory' ? 'is-directory-name' : '',
              gitStatusClass(item.node.gitStatus),
            ]"
          >{{ item.node.name }}</span>

          <!-- git 状态标签 -->
          <span
            v-if="item.node.gitStatus"
            class="git-tag"
            :class="gitStatusClass(item.node.gitStatus)"
          >
            {{ gitStatusLabel(item.node.gitStatus) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-tree-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ====== 内容区 ====== */
.file-tree-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--color-bg-canvas);
}

/* Loading / Error / Empty */
.tree-loading,
.tree-error,
.tree-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px;
  gap: 6px;
}

.loading-text,
.empty-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.error-text {
  font-size: 12px;
  color: var(--el-color-danger);
}

/* ====== 节点列表 ====== */
.tree-list {
  padding: 2px 0;
}

.tree-node {
  display: flex;
  align-items: center;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.1s;
  min-height: 26px;
  line-height: 26px;
  gap: 0;
}

.tree-node:hover {
  background: var(--el-fill-color-lighter);
}

/* ====== 缩进 + 树状连接线 ====== */
.tree-indents {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

/* 每级缩进 16px */
.tree-indent {
  width: 16px;
  height: 26px;
  position: relative;
  flex-shrink: 0;
}

/* 竖线：从行顶到行底 */
.tree-vline {
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--el-border-color-light);
  pointer-events: none;
}

/* 竖线只画上半（最后一个子项 = L 形） */
.tree-vline-half {
  bottom: 50%;
}

/* 没有线（祖先已经是最后一项的祖先） */
.tree-indent.no-line .tree-vline,
.tree-indent.no-line .tree-vline-half {
  display: none;
}

/* 水平连接线 */
.tree-hline {
  position: absolute;
  left: 7px;
  top: 13px; /* 26px 行高的一半，与文本行中线对齐 */
  width: 8px;
  height: 1px;
  background: var(--el-border-color-light);
  pointer-events: none;
}

/* ====== 箭头区域 ====== */
.tree-arrow-area {
  width: 10px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: 2px;
}

/* 箭头 */
.node-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  transition: transform 0.1s, color 0.1s;
  cursor: pointer;
  width: 16px;
  height: 22px;
  line-height: 22px;
}

.node-arrow:hover {
  color: var(--el-text-color-regular);
}

.node-arrow.expanded {
  transform: rotate(90deg);
}

/* Loading 图标 */
.node-loading-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--el-color-primary);
}

/* ====== 文件图标 ====== */
.node-icon {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
  margin-right: 4px;
  transition: color 0.1s;
}

.icon-folder-opened {
  color: var(--el-color-primary);
}

/* ====== 文件名 ====== */
.node-name {
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  line-height: 26px;
}

.node-name.is-directory-name {
  font-weight: 500;
}

/* ====== Git 状态标签 ====== */
.git-tag {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 16px;
  min-width: 14px;
  text-align: center;
}

.git-modified {
  color: #e6a23c;
  background: #fdf6ec;
}

.git-added {
  color: #67c23a;
  background: #f0f9eb;
}

.git-deleted {
  color: #909399;
  background: #f4f4f5;
}

.node-name.git-deleted {
  color: #909399;
  text-decoration: line-through;
}

.git-untracked {
  color: #c0c4cc;
  background: #f4f4f5;
}

.node-name.git-untracked {
  color: #c0c4cc;
}

/* ====== 滚动条 ====== */
.file-tree-content::-webkit-scrollbar {
  width: 4px;
}

.file-tree-content::-webkit-scrollbar-thumb {
  background: var(--color-border-subtle);
  border-radius: 2px;
}
</style>
