<script setup lang="ts">
const version = '1.0.0';
</script>

<template>
  <footer class="app-footer">
    <div class="copyright">
      <span>IceBubble © 2026 · SakuraSmiles</span>
      <span class="divider">|</span>
      <span>desktop v{{ version }}</span>
    </div>
  </footer>
</template>

<style scoped>
.app-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 24px;
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color-light);
}

.copyright {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.divider {
  margin: 0 8px;
  color: var(--el-border-color);
}
</style>
