<script setup lang="ts">
import ConnectionAlert from './ConnectionAlert.vue';

defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <header class="page-header">
    <div class="header-top">
      <div class="page-title-area">
        <h1 class="page-title">{{ title }}</h1>
        <span v-if="subtitle" class="page-subtitle">{{ subtitle }}</span>
      </div>
      <div class="page-actions">
        <slot />
      </div>
    </div>
    <div class="header-bottom">
      <ConnectionAlert />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  padding: 16px 24px 0;
  flex-shrink: 0;
}

.header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.page-title-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.2;
  letter-spacing: -0.3px;
}

.page-subtitle {
  font-size: 13px;
  color: var(--color-text-light);
  font-weight: 400;
  letter-spacing: 0;
  opacity: 0.7;
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  padding-top: 6px;
}

.header-bottom {
  width: 100%;
  margin-top: 12px;
}
</style>
