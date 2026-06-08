<script setup lang="ts">
/**
 * Design.vue — 设计主页面（三栏布局）
 */

import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDesignStore } from '@/stores/designStore';
import DesignSidebar from './components/design/DesignSidebar.vue';
import DesignChat from './components/design/DesignChat.vue';
import ArtifactPreview from './components/design/ArtifactPreview.vue';
import DesignEmpty from './components/design/DesignEmpty.vue';

const route = useRoute();
const router = useRouter();
const store = useDesignStore();

onMounted(async () => {
  await store.loadProjects();

  const projectId = route.params.projectId as string;
  if (projectId) {
    const exists = store.projects.some(p => p.id === projectId);
    if (exists) {
      store.selectProject(projectId);
    }
  }
});

function handleCreateFromEmpty() {
  // 聚焦到侧边栏的创建按钮 — 简单处理：直接跳转
  // ProjectList 组件有自己的创建弹窗
}
</script>

<template>
  <div class="design-page">
    <!-- 左侧：项目列表 -->
    <DesignSidebar class="design-left" />

    <!-- 中间：聊天面板 -->
    <div class="design-center">
      <DesignChat v-if="store.currentProjectId" />
      <DesignEmpty v-else @create="handleCreateFromEmpty" />
    </div>

    <!-- 右侧：Artifact 预览 -->
    <ArtifactPreview
      v-if="store.sortedArtifacts.length"
      class="design-right"
      :artifacts="store.sortedArtifacts"
    />
  </div>
</template>

<style scoped>
.design-page {
  display: flex;
  height: 100%;
  gap: 0;
  overflow: hidden;
}

.design-left {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.design-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--el-bg-color);
}

.design-right {
  width: 400px;
  flex-shrink: 0;
  border-left: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}
</style>
