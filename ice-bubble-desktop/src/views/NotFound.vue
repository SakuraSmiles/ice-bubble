<script setup lang="ts">
import { useRouter } from 'vue-router'
import { House } from '@element-plus/icons-vue'

const router = useRouter()

function goHome() {
  router.push('/')
}
</script>

<template>
  <div class="not-found">
    <div class="not-found-content">
      <div class="not-found-code">404</div>
      <p class="not-found-text">页面不存在</p>
      <p class="not-found-hint">请检查地址是否正确，或返回首页</p>
      <el-button type="primary" :icon="House" @click="goHome">返回首页</el-button>
    </div>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
}

.not-found-content {
  text-align: center;
}

.not-found-code {
  font-size: 96px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
  margin-bottom: 16px;
  opacity: 0.15;
}

.not-found-text {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 8px;
}

.not-found-hint {
  font-size: 14px;
  color: var(--color-text-tertiary);
  margin: 0 0 24px;
}
</style>
