<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { apiMonitor, type MonitorStats } from '../utils/monitor';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { api } from '../api/client';
import type { ModuleDTO } from '../api/client';

// 统计数据
const stats = ref<MonitorStats>({
  totalRequests: 0,
  successCount: 0,
  failureCount: 0,
  successRate: 0,
  currentLatency: 0,
  avgLatency: 0,
  minLatency: 0,
  maxLatency: 0
});

// 模块列表
const moduleList = ref<ModuleDTO[]>([]);

// 定时器
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 刷新监控数据
 */
function refreshData(): void {
  stats.value = apiMonitor.getStats();
}

/**
 * 刷新模块数据
 */
async function refreshModules(): Promise<void> {
  try {
    const data = await api.getModules();
    moduleList.value = data.modules || [];
  } catch (e) {
    console.error('获取模块列表失败:', e);
  }
}

/**
 * 格式化延迟显示
 */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 获取延迟等级颜色
 */
function getLatencyColor(ms: number): string {
  if (ms < 50) return 'var(--el-color-success)';
  if (ms < 100) return 'var(--el-color-warning)';
  return 'var(--el-color-danger)';
}

/**
 * 获取成功率等级
 */
function getSuccessRateType(rate: number): string {
  if (rate >= 99) return 'success';
  if (rate >= 95) return 'warning';
  return 'danger';
}

// 获取模块延迟（排除admin）
function getModuleLatency(mod: ModuleDTO): number {
  return mod.status?.latencyMs || 0;
}

// 最大模块延迟（用于条形图）
const maxModuleLatency = ref(1);

// 获取模块延迟条形图宽度
function getModuleLatencyWidth(mod: ModuleDTO): string {
  const latency = getModuleLatency(mod);
  return `${Math.min((latency / maxModuleLatency.value) * 100, 100)}%`;
}

// 过滤掉admin模块
const filteredModules = ref<ModuleDTO[]>([]);

onMounted(() => {
  refreshData();
  refreshModules();
  refreshTimer = setInterval(() => {
    refreshData();
    refreshModules();
  }, 5000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

// 监听模块列表变化，更新maxModuleLatency
import { watch } from 'vue';
watch(moduleList, (newList) => {
  const filtered = newList.filter((m: ModuleDTO) => m.moduleKey !== 'admin');
  filteredModules.value = filtered;
  if (filtered.length > 0) {
    const max = Math.max(...filtered.map((m: ModuleDTO) => getModuleLatency(m)), 1);
    maxModuleLatency.value = max;
  }
}, { immediate: true });
</script>

<template>
  <div class="overview-page">
    <PageHeader title="工作台" subtitle="系统概览" />

    <el-card class="content-area" shadow="never">
      <!-- 左右分栏布局 -->
      <div class="main-layout">
        <!-- 左侧：延迟监控卡片（窄） -->
        <div class="left-panel">
          <el-card class="latency-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <span>延迟监控</span>
                <el-tag size="small" type="info">实时</el-tag>
              </div>
            </template>
            
            <div class="latency-stats">
              <div class="latency-stat">
                <span class="label">前端→Admin</span>
                <span class="value" :style="{ color: getLatencyColor(stats.avgLatency) }">
                  {{ formatLatency(stats.avgLatency) }}
                </span>
              </div>
              
              <div class="latency-stat">
                <span class="label">延迟范围</span>
                <span class="value small">
                  {{ formatLatency(stats.minLatency) }} ~ {{ formatLatency(stats.maxLatency) }}
                </span>
              </div>
              
              <div class="latency-stat">
                <span class="label">成功率</span>
                <el-tag :type="getSuccessRateType(stats.successRate)" size="small">
                  {{ stats.successRate }}%
                </el-tag>
              </div>
            </div>

            <el-divider style="margin: 12px 0" />

            <div class="module-section">
              <div class="section-title">模块延迟</div>
              <div class="module-list" v-if="filteredModules.length > 0">
                <div class="module-item" v-for="mod in filteredModules" :key="mod.moduleKey">
                  <span class="module-name">{{ mod.name }}</span>
                  <div class="module-bar-wrapper">
                    <div 
                      class="module-bar" 
                      :style="{ 
                        width: getModuleLatencyWidth(mod), 
                        backgroundColor: getLatencyColor(getModuleLatency(mod))
                      }"
                    ></div>
                  </div>
                  <span class="module-latency" :style="{ color: getLatencyColor(getModuleLatency(mod)) }">
                    {{ formatLatency(getModuleLatency(mod)) }}
                  </span>
                </div>
              </div>
              <el-empty v-else description="暂无数据" :image-size="30" />
            </div>
          </el-card>
        </div>

        <!-- 右侧：主内容区 -->
        <div class="right-panel">
          <el-card class="main-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <span>概览</span>
              </div>
            </template>
            <div class="placeholder-content">
              <el-empty description="功能开发中..." :image-size="60" />
            </div>
          </el-card>
        </div>
      </div>
    </el-card>

    <AppFooter />
  </div>
</template>

<style scoped>
.overview-page {
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

.content-area :deep(.el-card__body) {
  padding: 16px;
}

/* 左右分栏布局 */
.main-layout {
  display: flex;
  gap: 16px;
  height: 100%;
}

/* 左侧：延迟监控（窄） */
.left-panel {
  width: 280px;
  flex-shrink: 0;
}

.latency-card {
  height: 100%;
}

.latency-card :deep(.el-card__header) {
  padding: 12px 16px;
}

.latency-card :deep(.el-card__body) {
  padding: 12px 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

/* 延迟统计 */
.latency-stats {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.latency-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.latency-stat .label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.latency-stat .value {
  font-size: 16px;
  font-weight: 600;
  font-family: 'Monaco', 'Menlo', monospace;
}

.latency-stat .value.small {
  font-size: 12px;
}

/* 模块列表 */
.module-section {
  margin-top: 4px;
}

.section-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.module-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.module-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.module-name {
  width: 80px;
  font-size: 11px;
  color: var(--el-text-color-primary);
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bar-wrapper {
  flex: 1;
  height: 4px;
  background: var(--el-fill-color);
  border-radius: 2px;
  overflow: hidden;
}

.module-bar {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease, background-color 0.3s ease;
}

.module-latency {
  width: 50px;
  text-align: right;
  font-size: 10px;
  font-family: 'Monaco', 'Menlo', monospace;
  font-weight: 500;
  flex-shrink: 0;
}

/* 右侧：主内容（宽） */
.right-panel {
  flex: 1;
  min-width: 0;
}

.main-card {
  height: 100%;
}

.main-card :deep(.el-card__body) {
  padding: 0;
}

.placeholder-content {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}
</style>
