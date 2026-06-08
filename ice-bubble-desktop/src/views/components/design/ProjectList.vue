<script setup lang="ts">
/**
 * ProjectList.vue — 设计项目列表 + 创建项目
 */

import { ref } from 'vue';
import { useDesignStore } from '@/stores/designStore';
import type { DesignProject } from '@/api/design';

const store = useDesignStore();

const showCreateDialog = ref(false);
const newProjectName = ref('');
const newProjectDesc = ref('');
const creating = ref(false);

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString('zh-CN');
}

function selectProject(project: DesignProject) {
  store.selectProject(project.id);
}

async function handleCreate() {
  if (!newProjectName.value.trim()) return;
  creating.value = true;
  try {
    await store.createProject(newProjectName.value.trim(), newProjectDesc.value.trim() || undefined);
    showCreateDialog.value = false;
    newProjectName.value = '';
    newProjectDesc.value = '';
  } catch (e) {
    console.error('Failed to create project:', e);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="project-list">
    <div class="project-list-header">
      <span class="project-list-title">项目</span>
      <el-button size="small" type="primary" @click="showCreateDialog = true">+ 新建</el-button>
    </div>

    <div class="project-list-body">
      <div v-if="store.projects.length === 0" class="no-projects">
        <span class="no-projects-icon">📁</span>
        <p>暂无项目</p>
      </div>

      <div
        v-for="project in store.projects"
        :key="project.id"
        class="project-item"
        :class="{ active: project.id === store.currentProjectId }"
        @click="selectProject(project)"
      >
        <div class="project-item-name">{{ project.name }}</div>
        <div class="project-item-time">{{ formatTime(project.updated_at) }}</div>
      </div>
    </div>

    <!-- 创建项目弹窗 -->
    <el-dialog
      v-model="showCreateDialog"
      title="新建设计项目"
      width="400px"
      :close-on-click-modal="false"
    >
      <el-form @submit.prevent="handleCreate">
        <el-form-item label="项目名称">
          <el-input
            v-model="newProjectName"
            placeholder="例如：公司官网设计"
            maxlength="50"
            show-word-limit
            autofocus
          />
        </el-form-item>
        <el-form-item label="描述（可选）">
          <el-input
            v-model="newProjectDesc"
            type="textarea"
            placeholder="简要描述项目目标..."
            :rows="3"
            maxlength="200"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="creating"
          :disabled="!newProjectName.trim()"
          @click="handleCreate"
        >
          创建
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.project-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.project-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 8px;
  flex-shrink: 0;
}

.project-list-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.project-list-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.no-projects {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  gap: 8px;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.no-projects-icon {
  font-size: 32px;
  opacity: 0.4;
}

.project-item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 2px;
}

.project-item:hover {
  background: var(--el-fill-color-light);
}

.project-item.active {
  background: var(--el-color-primary-light-9, #ecf5ff);
}

.project-item-name {
  font-size: 14px;
  color: var(--el-text-color-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-item-time {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  margin-top: 2px;
}
</style>
