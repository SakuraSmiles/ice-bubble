<script setup lang="ts">
import { ref } from 'vue';

const message = ref('Hello from ice-bubble-topdesk!');
</script>

<template>
  <main class="container">
    <h1>{{ message }}</h1>
    <p>ice-bubble 桌面端展示应用</p>
  </main>
</template>

<style scoped>
.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  text-align: center;
}

h1 {
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
}

p {
  font-size: 1.2rem;
  opacity: 0.9;
}
</style>
