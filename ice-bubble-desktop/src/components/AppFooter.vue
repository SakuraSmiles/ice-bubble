<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { APP_VERSION } from '../version';
import { api } from '../api/client';

const adminVersion = ref('');

onMounted(async () => {
  try {
    const data = await api.getSettings();
    adminVersion.value = data.version || '';
  } catch {
    // 静默失败，不阻塞 UI
  }
});
</script>

<template>
  <footer class="copyright">
    <span class="brand">IceBubble © 2026 SakuraSmiles</span>
    <span class="versions" v-if="adminVersion">
      Desktop {{ APP_VERSION }} · Admin {{ adminVersion }}
    </span>
  </footer>
</template>

<style scoped>
.copyright {
  text-align: center;
  font-size: 11px;
  color: var(--color-text-secondary);
  padding: 12px 0;
  margin-top: auto;
  font-family: var(--font-eurostile), var(--font-fallback);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  line-height: 1;
}

.brand {
  opacity: 0.8;
}

.versions {
  opacity: 0.5;
  font-size: 9px;
}
</style>
