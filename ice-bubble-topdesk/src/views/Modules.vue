<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';

interface Module {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval: number;
  status: 'running' | 'stopped' | 'error';
  version?: string;
  lastUpdated?: string;
}

const modules = ref<Module[]>([]);
const loading = ref(false);
const error = ref('');

async function fetchModules() {
  loading.value = true;
  error.value = '';
  try {
    const listRes = await fetch('/api/modules');
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
    const listData = await listRes.json();

    const moduleDetails = await Promise.all(
      listData.modules.map(async (m: any) => {
        try {
          const detailRes = await fetch(`/api/modules/${m.moduleKey}`);
          if (!detailRes.ok) throw new Error(`HTTP ${detailRes.status}`);
          const detail = await detailRes.json();
          return {
            ...m,
            status: detail.status?.status || (m.enabled ? 'running' : 'stopped'),
            version: detail.status?.version || '-',
            lastUpdated: detail.status?.runtime?.startTime
              ? new Date(detail.status.runtime.startTime).toLocaleString('zh-CN')
              : '-',
          };
        } catch {
          return { ...m, status: 'error', version: '-', lastUpdated: '-' };
        }
      })
    );

    modules.value = moduleDetails;
  } catch (e: any) {
    error.value = e.message || '获取模块列表失败';
  } finally {
    loading.value = false;
  }
}

function statusLabel(status: string) {
  return status === 'running' ? '运行中' : status === 'stopped' ? '已停止' : '异常';
}

onMounted(fetchModules);
</script>

<template>
  <div class="modules-page">
    <div class="page-header">
      <h1 class="page-title">模块管理</h1>
      <el-button :disabled="loading" circle @click="fetchModules">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>

    <el-card class="content-area" shadow="hover">
      <div v-if="error" class="error-msg">{{ error }}</div>
      <div v-if="loading && modules.length === 0" class="loading-msg">加载中...</div>
      <div v-else-if="modules.length === 0" class="empty-msg">暂无模块</div>
      <div v-else class="cards-grid">
        <el-card v-for="mod in modules" :key="mod.moduleKey" class="module-card">
          <div class="card-header">
            <div class="module-title">
              <h2 class="module-name">{{ mod.name }}</h2>
              <span class="module-key">{{ mod.moduleKey }}</span>
            </div>
            <el-tag :type="mod.status === 'running' ? 'success' : mod.status === 'error' ? 'danger' : 'info'" size="small">
              {{ statusLabel(mod.status) }}
            </el-tag>
          </div>
          <div class="card-body">
            <div class="info-row">
              <span class="info-label">版本</span>
              <span class="info-value">{{ mod.version || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">最后更新</span>
              <span class="info-value">{{ mod.lastUpdated }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">地址</span>
              <span class="info-value url">{{ mod.baseUrl }}</span>
            </div>
          </div>
        </el-card>
      </div>
    </el-card>

    <div class="copyright">
      <span>© 2026 IceBubble · Built with OpenClaw</span>
    </div>
  </div>
</template>

<style scoped>
.modules-page {
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 32px;
  box-sizing: border-box;
  min-height: calc(100vh - 1px);
}

.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
}

.page-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.content-area {
  flex: 1;
  margin-bottom: 20px;
}

.cards-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.module-card {
  width: 360px;
  cursor: pointer;
}
.module-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 20px;
}

.module-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.module-name {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.3;
}

.module-key {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: monospace;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.info-label {
  color: var(--color-text-secondary);
}

.info-value {
  color: var(--color-text);
  font-weight: 500;
}

.info-value.url {
  font-size: 12px;
  color: var(--color-text-secondary);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-msg {
  background: #ffebe9;
  border: 1px solid #cf222e40;
  color: var(--color-accent-red);
  padding: 12px 16px;
  border-radius: var(--radius);
  margin-bottom: 20px;
  font-size: 14px;
}

.loading-msg,
.empty-msg {
  color: #888;
  font-size: 14px;
  text-align: center;
  padding: 48px 0;
}

.copyright {
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 20px 0;
  margin-top: auto;
}
</style>
