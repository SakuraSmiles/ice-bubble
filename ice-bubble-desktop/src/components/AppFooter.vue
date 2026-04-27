<script setup lang="ts">
import pkg from '../../package.json';
const version = pkg.version;
</script>

<template>
  <footer class="copyright">
    <div>IceBubble © 2026 · SakuraSmiles</div>
    <div>desktop version : {{ version }}</div>
  </footer>
</template>

<style scoped>
.copyright {
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 20px 0;
  margin-top: auto;
  font-family: var(--font-eurostile), var(--font-fallback);
}

.copyright div {
  font-family: inherit;
  line-height: 1.8;
}
</style>
