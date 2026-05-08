<script setup lang="ts">
import { APP_VERSION } from '../version';
</script>

<template>
  <footer class="copyright">
    <span>IceBubble {{ APP_VERSION }} © 2026 SakuraSmiles</span>
  </footer>
</template>

<style scoped>
.copyright {
  text-align: center;
  font-size: 11px;
  color: var(--color-text-secondary);
  padding: 12px 0;
  margin-top: auto;
  line-height: 1;
  font-family: var(--font-eurostile), var(--font-fallback);
}


</style>
