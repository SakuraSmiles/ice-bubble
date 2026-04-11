<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <header class="page-header">
    <div class="page-title-area">
      <h1 class="page-title">{{ title }}</h1>
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
  align-items: center;
  justify-content: space-between;
  padding: 20px 0;
}

.page-title-area {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.page-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.page-subtitle {
  font-size: 14px;
  color: var(--color-text-secondary);
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
</style>
