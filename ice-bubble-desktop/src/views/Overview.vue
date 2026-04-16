<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiMonitor, type MonitorStats, type EndpointStats, type LatencyRecord } from '../utils/monitor';
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

// 各端点统计
const endpointStats = ref<EndpointStats[]>([]);

// 模块列表
const moduleList = ref<ModuleDTO[]>([]);

// 延迟趋势数据（用于图表）
const trendData = ref<LatencyRecord[]>([]);

// 定时器
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 刷新监控数据
 */
function refreshData(): void {
  stats.value = apiMonitor.getStats();
  endpointStats.value = apiMonitor.getEndpointStats();
  trendData.value = apiMonitor.getRecentRecords(30);
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

// 最大模块延迟（用于条形图）
const maxModuleLatency = computed(() => {
  // 只计算非admin模块的延迟
  const modules = moduleList.value.filter(m => m.moduleKey !== 'admin');
  if (modules.length === 0) return 0;
  return Math.max(...modules.map(m => m.status?.latencyMs || 0), 1);
});

// 获取模块延迟（排除admin）
function getModuleLatency(mod: ModuleDTO): number {
  return mod.status?.latencyMs || 0;
}

// 获取模块延迟条形图宽度
function getModuleLatencyWidth(mod: ModuleDTO): string {
  const latency = getModuleLatency(mod);
  if (maxModuleLatency.value === 0) return '0%';
  return `${Math.min((latency / maxModuleLatency.value) * 100, 100)}%`;
}




// 延迟趋势SVG路径
const trendPath = computed(() => {
  if (trendData.value.length < 2) return '';

  const data = trendData.value;
  const maxLatency = Math.max(...data.map(d => d.latency), 100);
  const width = 100;
  const height = 100;
  const padding = 5;

  const points = data.map((d, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - (d.latency / maxLatency) * (height - padding * 2);
    return `${x},${y}`;
  });

  return `M ${points.join(' L ')}`;
});

// 延迟趋势面积路径
const trendAreaPath = computed(() => {
  if (trendData.value.length < 2) return '';

  const data = trendData.value;
  const maxLatency = Math.max(...data.map(d => d.latency), 100);
  const width = 100;
  const height = 100;
  const padding = 5;

  const points = data.map((d, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - (d.latency / maxLatency) * (height - padding * 2);
    return `${x},${y}`;
  });

  const lastX = padding + (width - padding * 2);
  const firstX = padding;

  return `M ${firstX},${height - padding} L ${points.join(' L ')} L ${lastX},${height - padding} Z`;
});

onMounted(() => {
  refreshData();
  refreshModules();
  // 每秒刷新API监控数据，每30秒刷新模块数据
  refreshTimer = setInterval(() => {
    refreshData();
  }, 1000);
  setInterval(() => {
    refreshModules();
  }, 30000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <div class="overview-page">
    <PageHeader title="工作台" subtitle="系统监控" />

    <!-- 统计卡片 -->
    <el-card class="content-area">
      <el-row :gutter="16" class="stats-row">
        <!-- 前端→Admin 延迟 -->
        <el-col :span="6">
          <div class="stat-card">
            <div class="stat-label">前端→Admin</div>
            <div class="stat-value" :style="{ color: getLatencyColor(stats.avgLatency) }">
              {{ formatLatency(stats.avgLatency) }}
            </div>
          </div>
        </el-col>

        <!-- 延迟范围 -->
        <el-col :span="6">
          <div class="stat-card">
            <div class="stat-label">延迟范围</div>
            <div class="stat-value small">
              {{ formatLatency(stats.minLatency) }} ~ {{ formatLatency(stats.maxLatency) }}
            </div>
          </div>
        </el-col>

        <!-- 成功率 -->
        <el-col :span="6">
          <div class="stat-card">
            <div class="stat-label">成功率</div>
            <div class="stat-value">
              <el-tag :type="getSuccessRateType(stats.successRate)" size="large">
                {{ stats.successRate }}%
              </el-tag>
            </div>
          </div>
        </el-col>
      </el-row>

      <!-- 请求统计 -->
      <div class="request-stats">
        <span>总请求: {{ stats.totalRequests }}</span>
        <span class="divider">|</span>
        <span class="success">成功: {{ stats.successCount }}</span>
        <span class="divider">|</span>
        <span class="failure">失败: {{ stats.failureCount }}</span>
      </div>

      <!-- 延迟趋势图 -->
      <div class="section-title">延迟趋势（最近30次）</div>
      <div class="trend-chart" v-if="trendData.length >= 2">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="trend-svg">
          <defs>
            <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--el-color-primary)" stop-opacity="0.3" />
              <stop offset="100%" stop-color="var(--el-color-primary)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path :d="trendAreaPath" fill="url(#trendGradient)" />
          <path :d="trendPath" fill="none" stroke="var(--el-color-primary)" stroke-width="2" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="trend-labels">
          <span>{{ trendData[0]?.timestamp ? new Date(trendData[0].timestamp).toLocaleTimeString() : '' }}</span>
          <span>{{ trendData[trendData.length - 1]?.timestamp ? new Date(trendData[trendData.length - 1].timestamp).toLocaleTimeString() : '' }}</span>
        </div>
      </div>
      <div class="empty-chart" v-else>
        <el-empty description="暂无延迟数据" :image-size="60" />
      </div>

      <!-- Admin→模块延迟 -->
      <div class="section-title">Admin→模块 延迟</div>
      <div class="module-list" v-if="moduleList.length > 0">
        <div class="endpoint-item" v-for="mod in moduleList" :key="mod.moduleKey">
          <div class="endpoint-name">{{ mod.name }}</div>
          <div class="endpoint-bar-wrapper">
            <div class="endpoint-bar" :style="{ width: getModuleLatencyWidth(mod), backgroundColor: getLatencyColor(getModuleLatency(mod)) }"></div>
          </div>
          <div class="endpoint-latency">
            <span class="avg">{{ formatLatency(getModuleLatency(mod)) }}</span>
          </div>
          <el-tag size="small" :type="mod.status?.state === 'running' ? 'success' : mod.status?.state === 'error' ? 'danger' : 'info'">
            {{ mod.status?.state || 'unknown' }}
          </el-tag>

        </div>
      </div>
      <div class="empty-chart" v-else>
        <el-empty description="暂无模块数据" :image-size="60" />
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

.stats-row {
  margin-bottom: 16px;
}

.stat-card {
  padding: 12px;
  text-align: center;
}

.stat-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  font-family: 'Monaco', 'Menlo', monospace;
}

.stat-value.small {
  font-size: 18px;
}

.request-stats {
  text-align: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 24px;
}

.request-stats .divider {
  margin: 0 12px;
  color: var(--el-border-color);
}

.request-stats .success {
  color: var(--el-color-success);
}

.request-stats .failure {
  color: var(--el-color-danger);
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin: 20px 0 12px;
}

/* 延迟趋势图 */
.trend-chart {
  height: 120px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 12px;
  position: relative;
}

.trend-svg {
  width: 100%;
  height: 90px;
}

.trend-labels {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}

.empty-chart {
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}

/* 各端点延迟 */
.endpoint-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.endpoint-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.endpoint-name {
  width: 160px;
  font-size: 13px;
  font-family: monospace;
  color: var(--el-text-color-primary);
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.endpoint-bar-wrapper {
  flex: 1;
  height: 8px;
  background: var(--el-fill-color);
  border-radius: 4px;
  overflow: hidden;
}

.endpoint-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.endpoint-latency {
  width: 120px;
  text-align: right;
  font-size: 12px;
  font-family: monospace;
  flex-shrink: 0;
}

.endpoint-latency .avg {
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.endpoint-latency .detail {
  color: var(--el-text-color-secondary);
  margin-left: 4px;
}

.count {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  width: 40px;
  text-align: right;
}

.endpoint-source {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  width: 80px;
  text-align: right;
}
</style>
