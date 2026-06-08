<script setup lang="ts">
/**
 * DesignEmpty.vue — 无项目时的空状态引导
 */

const emit = defineEmits<{
  (e: 'create'): void
}>()
</script>

<template>
  <div class="design-empty">
    <span class="empty-icon">🎨</span>
    <h2 class="empty-title">开始你的设计</h2>
    <p class="empty-desc">
      创建一个设计项目，用 AI 驱动你的 UI 设计流程。
    </p>
    <el-button type="primary" @click="emit('create')">
      + 新建项目
    </el-button>
  </div>
</template>

<style scoped>
.design-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 40px;
  gap: 16px;
}

.empty-icon {
  font-size: 64px;
  line-height: 1;
  opacity: 0.6;
}

.empty-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin: 0;
}

.empty-desc {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin: 0;
  text-align: center;
  max-width: 360px;
  line-height: 1.6;
}
</style>
