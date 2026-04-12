<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AppFooter from '../components/AppFooter.vue';
import PageHeader from '../components/PageHeader.vue';

interface Agent {
  agent_id: string;
  agent_name: string;
  session_count: number;
  message_count: number;
  first_active_at: string | null;
  last_active_at: string | null;
  updated_at: string;
}

const agents = ref<Agent[]>([]);
const loading = ref(false);
const totalAgents = ref(0);
const totalSessions = ref(0);
const totalMessages = ref(0);

async function fetchAgents() {
  loading.value = true;
  try {
    const res = await fetch('/api/data/agents');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    agents.value = data.agents || [];
    totalAgents.value = data.count || 0;
    totalSessions.value = agents.value.reduce((sum, a) => sum + (a.session_count || 0), 0);
    totalMessages.value = agents.value.reduce((sum, a) => sum + (a.message_count || 0), 0);
  } catch (e: any) {
    ElMessage.error('获取成员列表失败: ' + (e.message || e));
  } finally {
    loading.value = false;
  }
}

function formatTime(dateString: string | null): string {
  if (!dateString) return '-';
  const d = new Date(dateString);
  return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return '-';
  const now = Date.now();
  const date = new Date(dateString).getTime();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return formatTime(dateString);
}

function getActivityStatus(lastActiveAt: string | null): { label: string; type: string } {
  if (!lastActiveAt) return { label: '未知', type: 'info' };
  const now = Date.now();
  const date = new Date(lastActiveAt).getTime();
  const diff = now - date;
  const hours = diff / 3600000;
  if (hours < 1) return { label: '活跃', type: 'success' };
  if (hours < 24) return { label: '活跃', type: 'success' };
  if (hours < 72) return { label: '较久未活跃', type: 'warning' };
  return { label: '长时间未活跃', type: 'info' };
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await fetchAgents();
  refreshTimer = setInterval(fetchAgents, 30000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

const subtitle = computed(() => `${totalAgents.value} 个成员，${totalSessions.value} 个会话，${totalMessages.value} 条消息`);
</script>

<template>
  <div class="agents-page">
    <PageHeader title="成员" :subtitle="subtitle">
      <el-button circle size="small" :loading="loading" @click="fetchAgents" title="刷新">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </PageHeader>

    <el-card class="content-area" v-loading="loading">
      <div v-if="!loading && agents.length === 0" class="empty-msg">暂无成员</div>
      <div v-if="!loading && agents.length > 0" class="agents-list">
        <div v-for="agent in agents" :key="agent.agent_id" class="agent-card">
          <!-- 左侧信息 -->
          <div class="agent-left">
            <div class="agent-avatar">
              <el-avatar :size="80" style="background: var(--color-accent-blue-subtle); color: var(--color-accent-blue); border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                {{ agent.agent_id.substring(0, 1).toUpperCase() }}
              </el-avatar>
            </div>
            <div class="agent-name">
              <span class="name-text">{{ agent.agent_name || agent.agent_id }}</span>
            </div>
            <div class="agent-model">
              <span class="model-value">{{ agent.model || '-' }}</span>
            </div>
          </div>

          <!-- 分隔线 -->
          <div class="agent-divider"></div>

          <!-- 中间统计 -->
          <div class="agent-stats">
            <div class="agent-status-top">
              <el-tag :type="getActivityStatus(agent.last_active_at).type" size="small">
                {{ getActivityStatus(agent.last_active_at).label }}
              </el-tag>
            </div>
            <div class="stat-row">
              <div class="stat-item">
                <div class="stat-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2.5 3.5a.5.5 0 01.5-.5H13a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0 4a.5.5 0 01.5-.5h10a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0 4a.5.5 0 01.5-.5h6a.5.5 0 010 1H3a.5.5 0 01-.5-.5z"/>
                </svg>
              </div>
              <div class="stat-content">
                <span class="stat-value">{{ agent.session_count }}</span>
                <span class="stat-label">会话</span>
              </div>
            </div>
            <div class="stat-item">
              <div class="stat-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M14 1a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1h12zM2 0a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V2a2 2 0 00-2-2H2z"/>
                  <path d="M3 4h10v1H3V4zm0 3h10v1H3V7zm0 3h7v1H3v-1z"/>
                </svg>
              </div>
              <div class="stat-content">
                <span class="stat-value">{{ agent.message_count }}</span>
                <span class="stat-label">消息</span>
              </div>
            </div>
            </div>
          </div>

          <!-- 分隔线 -->
          <div class="agent-divider"></div>

          <!-- 右侧时间信息 -->
          <div class="agent-times">
            <div class="time-item">
              <span class="time-label">最近活跃</span>
              <span class="time-value highlight">{{ formatRelativeTime(agent.last_active_at) }}</span>
            </div>
            <div class="time-item">
              <span class="time-label">最后更新</span>
              <span class="time-value">{{ formatTime(agent.updated_at) }}</span>
            </div>
          </div>
        </div>
      </div>
    </el-card>

    <AppFooter />
  </div>
</template>

<style scoped>
.agents-page {
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

.empty-msg {
  text-align: center;
  padding: 40px;
  color: var(--color-text-secondary);
}

.agents-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.agent-card {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  background: var(--color-bg-subtle);
  border-radius: var(--radius);
  gap: 24px;
  min-height: 120px;
}

.agent-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 100px;
}

.agent-avatar {
  margin-bottom: 2px;
}

.agent-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--color-text);
}

.agent-status {
  display: none;  /* 隐藏原来的状态标签位置 */
}

.agent-model {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  margin-top: 2px;
}

.model-label {
  font-size: 10px;
  color: var(--color-text-secondary);
  display: none;
}

.model-value {
  font-size: 11px;
  color: var(--color-accent-blue);
  font-family: monospace;
}

.agent-divider {
  width: 1px;
  height: 80px;
  background: var(--color-border);
  flex-shrink: 0;
}

.agent-stats {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.agent-status-top {
  display: flex;
  align-items: center;
}

.stat-row {
  display: flex;
  gap: 32px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stat-icon {
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
}

.stat-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  font-family: monospace;
  line-height: 1;
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.agent-times {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 120px;
}

.time-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.time-label {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.time-value {
  font-size: 13px;
  color: var(--color-text);
  font-family: monospace;
}

.time-value.highlight {
  color: var(--color-accent-blue);
  font-weight: 500;
}
</style>
