<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <header class="page-header">
    <div class="page-title">
      <h1>{{ title }}</h1>
      <span v-if="subtitle" class="page-subtitle">{{ subtitle }}</span>
    </div>
    <div class="page-actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}

.page-title h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.page-subtitle {
  margin-left: 8px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.page-actions {
  display: flex;
  gap: 12px;
}
</style>
