<script setup lang="ts">
import { APP_VERSION } from '../version';
</script>

<template>
  <footer class="copyright">
    <div>IceBubble © 2026 · SakuraSmiles</div>
    <div>version : {{ APP_VERSION }}</div>
  </footer>
</template>

<style scoped>
.copyright {
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 20px 0;
  margin-top: auto;
  margin-bottom: 10px;
  font-family: var(--font-eurostile), var(--font-fallback);
}

.copyright div {
  font-family: inherit;
  line-height: 1.8;
}
</style>
