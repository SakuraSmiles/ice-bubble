<script setup lang="ts">
import { ref, onMounted } from 'vue';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';

const activeTab = ref('list');
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
    <PageHeader title="会话管理">
      <template #actions>
        <el-tabs v-model="activeTab" class="header-tabs">
          <el-tab-pane label="会话列表" name="list" />
          <el-tab-pane label="对话" name="chat" />
        </el-tabs>
      </template>
    </PageHeader>

    <div class="content-area">
      <div v-if="activeTab === 'list'" class="list-view">
        <el-empty description="暂无会话数据" />
      </div>
      <div v-else class="chat-view">
        <el-empty description="请选择会话" />
      </div>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
.sessions-page {
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-height: calc(100vh - 1px);
}

.content-area {
  flex: 1;
  padding: 0 32px;
}

.list-view,
.chat-view {
  background: var(--el-bg-color);
  border-radius: 8px;
  padding: 24px;
}

:deep(.header-tabs) {
  min-width: 200px;
}

:deep(.header-tabs .el-tabs__header) {
  margin: 0;
}

:deep(.header-tabs .el-tabs__nav-wrap::after) {
  display: none;
}
</style>
