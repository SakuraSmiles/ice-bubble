<script setup lang="ts">
/**
 * ArtifactPreview.vue — HTML artifact 预览组件（iframe srcdoc）
 */

import { ref, computed } from 'vue'

interface Artifact {
  id: string
  html: string
  title: string
}

const props = defineProps<{
  artifacts: Artifact[]
}>()

const activeIndex = ref(0)
const iframeRef = ref<HTMLIFrameElement | null>(null)

const activeArtifact = computed(() => {
  if (props.artifacts.length === 0) return null
  return props.artifacts[activeIndex.value] || props.artifacts[0]
})

function selectArtifact(index: number) {
  activeIndex.value = index
}

async function copyHTML() {
  if (!activeArtifact.value) return
  try {
    await navigator.clipboard.writeText(activeArtifact.value.html)
  } catch (e) {
    console.error('Failed to copy HTML:', e)
  }
}

function openInNewTab() {
  if (!activeArtifact.value) return
  const win = window.open('', '_blank')
  if (win) {
    win.document.write(activeArtifact.value.html)
    win.document.close()
  }
}
</script>

<template>
  <div class="artifact-preview">
    <!-- 工具栏 -->
    <div class="artifact-toolbar">
      <span class="artifact-title">{{ activeArtifact?.title || '预览' }}</span>
      <div class="artifact-actions">
        <el-button size="small" text @click="openInNewTab">外部打开</el-button>
        <el-button size="small" text @click="copyHTML">复制代码</el-button>
      </div>
    </div>

    <!-- iframe 预览区 -->
    <div class="artifact-iframe-wrap" v-if="activeArtifact">
      <iframe
        ref="iframeRef"
        class="artifact-iframe"
        sandbox="allow-scripts allow-same-origin"
        :srcdoc="activeArtifact.html"
      />
    </div>

    <!-- artifact 列表 -->
    <div class="artifact-list" v-if="artifacts.length > 1">
      <div
        v-for="(artifact, i) in artifacts"
        :key="artifact.id"
        class="artifact-list-item"
        :class="{ active: i === activeIndex }"
        @click="selectArtifact(i)"
      >
        <span class="artifact-list-icon">📄</span>
        <span class="artifact-list-name">{{ artifact.title }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.artifact-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.artifact-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.artifact-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.artifact-iframe-wrap {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.artifact-iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

.artifact-list {
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 4px 8px;
  max-height: 120px;
  overflow-y: auto;
  flex-shrink: 0;
}

.artifact-list-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--el-text-color-regular);
  transition: background 0.15s;
}

.artifact-list-item:hover {
  background: var(--el-fill-color-light);
}

.artifact-list-item.active {
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary);
}

.artifact-list-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.artifact-list-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
