<script setup lang="ts">
/**
 * 统一空态组件
 * 替代各页面中不同的空态实现（纯文字、emoji+文字等）
 */
withDefaults(defineProps<{
  icon?: string;
  title?: string;
  description?: string;
}>(), {
  icon: '📋',
  title: '暂无数据',
});
</script>

<template>
  <div class="empty-state">
    <span class="empty-icon">{{ icon }}</span>
    <p class="empty-title">{{ title }}</p>
    <p v-if="description" class="empty-desc">{{ description }}</p>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 200px;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
  margin-bottom: 12px;
  line-height: 1;
}

.empty-title {
  font-size: 14px;
  color: var(--el-text-color-secondary, #909399);
  margin: 0 0 4px 0;
  font-weight: 400;
}

.empty-desc {
  font-size: 12px;
  color: var(--el-text-color-placeholder, #a8abb2);
  margin: 0;
}
</style>
