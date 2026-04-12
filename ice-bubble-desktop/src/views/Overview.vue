<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../api/client.ts';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';

const stats = ref({
  sessionCount: 0,
  messageCount: 0,
  moduleCount: 0,
  collectorStatus: 'unknown' as 'running' | 'stopped' | 'unknown'
});

const loading = ref(false);

async function fetchStats() {
  loading.value = true;
  try {
    const data = await api.getStats();
    stats.value = {
      sessionCount: data.sessionCount || 0,
      messageCount: data.messageCount || 0,
      moduleCount: data.moduleCount || 0,
      collectorStatus: data.collectorStatus || 'unknown'
    };
  } catch (e) {
    console.error('Failed to fetch stats:', e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchStats();
});
</script>

<template>
  <div class="modules-page">
    <PageHeader title="工作台" subtitle="系统概览" />
    
    <el-card class="content-area">
      <el-row :gutter="20">
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-card">
              <div class="stat-icon sessions">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                </svg>
              </div>
              <div class="stat-info">
                <div class="stat-value">{{ stats.sessionCount }}</div>
                <div class="stat-label">会话总数</div>
              </div>
            </div>
          </el-card>
        </el-col>
        
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-card">
              <div class="stat-icon messages">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
                </svg>
              </div>
              <div class="stat-info">
                <div class="stat-value">{{ stats.messageCount }}</div>
                <div class="stat-label">消息总数</div>
              </div>
            </div>
          </el-card>
        </el-col>
        
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-card">
              <div class="stat-icon modules">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4 4h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 10h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 16h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4z"/>
                </svg>
              </div>
              <div class="stat-info">
                <div class="stat-value">{{ stats.moduleCount }}</div>
                <div class="stat-label">模块数量</div>
              </div>
            </div>
          </el-card>
        </el-col>
        
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-card">
              <div class="stat-icon status" :class="stats.collectorStatus">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10 10-4.48 10-10 10zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8z"/>
                </svg>
              </div>
              <div class="stat-info">
                <div class="stat-value">
                  <el-tag :type="stats.collectorStatus === 'running' ? 'success' : 'danger'">
                    {{ stats.collectorStatus === 'running' ? '运行中' : '已停止' }}
                  </el-tag>
                </div>
                <div class="stat-label">采集器状态</div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </el-card>
    
    <AppFooter />
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

.content-area {
  flex: 1;
  margin-bottom: 20px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
}

.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.stat-icon.sessions { background: #409eff; }
.stat-icon.messages { background: #67c23a; }
.stat-icon.modules { background: #e6a23c; }
.stat-icon.status.running { background: #67c23a; }
.stat-icon.status.stopped { background: #f56c6c; }
.stat-icon.status.unknown { background: #909399; }

.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.stat-label {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
