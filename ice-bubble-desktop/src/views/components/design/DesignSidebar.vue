<script setup lang="ts">
/**
 * DesignSidebar.vue — 设计页左侧栏：项目切换
 */

import { useDesignStore } from '@/stores/designStore';
import ProjectList from './ProjectList.vue';

const store = useDesignStore();
</script>

<template>
  <div class="design-sidebar">
    <div class="design-sidebar-header">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="design-logo-icon">
        <path d="M12.146.146a.5.5 0 01.708 0l3 3a.5.5 0 01-.708.708L13 2.707V14.5a.5.5 0 01-1 0V2.707L10.854 3.854a.5.5 0 11-.708-.708l3-3z"/>
        <path d="M3.854 15.854a.5.5 0 01-.708 0l-3-3a.5.5 0 01.708-.708L3 13.293V1.5a.5.5 0 011 0v11.793l1.146-1.147a.5.5 0 01.708.708l-3 3z"/>
        <path d="M7 2v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span class="design-sidebar-label">OpenDesign</span>
    </div>

    <ProjectList />
  </div>
</template>

<style scoped>
.design-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.design-sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 0;
  flex-shrink: 0;
}

.design-logo-icon {
  color: var(--el-color-primary);
}

.design-sidebar-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
</style>
