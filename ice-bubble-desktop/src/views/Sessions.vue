<script setup lang="ts">
import { ref, onMounted } from 'vue';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';

const sessionCount = ref(0);
const loading = ref(false);

async function fetchSessionCount() {
  loading.value = true;
  try {
    const res = await fetch('/api/data/stats');
    const data = await res.json();
    sessionCount.value = data.sessionCount || 0;
  } catch (e) {
    console.error('Failed to fetch session count:', e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchSessionCount();
});
</script>

<template>
  <div class="sessions-page">
    <PageHeader title="会话管理" :subtitle="`共 ${sessionCount} 个会话`" />

    <el-card class="content-area">
      <el-empty description="暂无会话数据" />
    </el-card>

    <AppFooter />
  </div>
</template>

<style scoped>
.sessions-page {
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 32px;
  box-sizing: border-box;
  min-height: calc(100vh - 1px);
}

.content-area {
  flex: 1;
  margin-bottom: 20px;
}
</style>
