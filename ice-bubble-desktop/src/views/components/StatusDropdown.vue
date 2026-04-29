<script setup lang="ts">
/**
 * StatusDropdown.vue — PageHeader 右上角系统状态下拉面板
 * 收起态：彩色圆点 + 平均延迟
 * 展开态：el-popover 面板（系统健康 + 模块延迟 + 数据状态）
 */
import { ref, computed, watch } from 'vue';
import type { MonitorStats } from '../../utils/monitor';
import type { ModuleDTO } from '../../api/client';

interface DataStatus {
  todayFiltered: number;
  lastCompaction: string | null;
  lastMemoryFlush: string | null;
  todayRetryCount: number;
  todayModelChangeCount: number;
}

interface Props {
  stats: MonitorStats;
  modules: ModuleDTO[];
  dataStatus: DataStatus | null;
}

const props = defineProps<Props>();

// ===== 延迟历史（sparkline） =====
const latencyHistory = ref<number[]>([]);

watch(() => props.stats.avgLatency, (val) => {
  if (val > 0) {
    latencyHistory.value.push(val);
    if (latencyHistory.value.length > 20) latencyHistory.value.shift();
  }
});

// ===== 工具函数（复用 SystemHealth 逻辑） =====
function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getLatencyColor(ms: number): string {
  if (ms < 200) return 'var(--el-color-success)';
  if (ms < 500) return 'var(--el-color-warning)';
  if (ms < 1000) return '#E6A23C';
  return 'var(--el-color-danger)';
}

function getModuleLatency(mod: ModuleDTO): number {
  return mod.status?.latencyMs || 0;
}

function getSuccessRateType(rate: number): string {
  if (rate >= 99) return 'success';
  if (rate >= 95) return 'warning';
  return 'danger';
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '--';
  const then = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHr < 24) return `${diffHr}小时前`;
  const thenDay = then.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (thenDay === yesterday.toDateString()) {
    return `昨天 ${then.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `${then.getMonth() + 1}-${then.getDate().toString().padStart(2, '0')}`;
}

// ===== 模块过滤与计算 =====
const filteredModules = computed(() =>
  props.modules.filter(m => m.moduleKey !== 'admin')
);

const maxModuleLatency = computed(() =>
  Math.max(...filteredModules.value.map(m => getModuleLatency(m)), 1)
);

function getModuleLatencyWidth(mod: ModuleDTO): string {
  return `${Math.min((getModuleLatency(mod) / maxModuleLatency.value) * 100, 100)}%`;
}

// ===== 异常判定 =====
const isAbnormal = computed(() => {
  return props.stats.avgLatency >= 1000 || props.stats.successRate < 95;
});

const highLatencyCount = computed(() =>
  filteredModules.value.filter(m => getModuleLatency(m) >= 500).length
);

const totalModuleCount = computed(() => filteredModules.value.length);
const normalModuleCount = computed(() => totalModuleCount.value - highLatencyCount.value);

const healthSummary = computed(() => {
  if (!props.stats.totalRequests) return '暂无数据';
  if (highLatencyCount.value === 0) return `${normalModuleCount.value}/${totalModuleCount.value} 模块正常`;
  if (props.stats.successRate < 95) return `${normalModuleCount.value}/${totalModuleCount.value} 模块正常，成功率下降`;
  return `${normalModuleCount.value}/${totalModuleCount.value} 模块正常，${highLatencyCount.value}个响应较慢`;
});

const tooltipText = computed(() => healthSummary.value);

// ===== 条件显示 =====
const showAnomalyRow = computed(() =>
  props.dataStatus && (props.dataStatus.todayRetryCount > 0 || props.dataStatus.todayModelChangeCount > 0)
);

// ===== Sparkline SVG =====
const sparklinePoints = computed(() => {
  const pts = latencyHistory.value;
  if (pts.length < 2) return '';
  const max = Math.max(...pts, 1);
  const min = Math.min(...pts, 0);
  const range = max - min || 1;
  const step = 100 / (pts.length - 1);
  return pts.map((v, i) => {
    const x = i * step;
    const y = 30 - ((v - min) / range) * 26 - 2;
    return `${x},${y}`;
  }).join(' ');
});

const sparklineColor = computed(() => getLatencyColor(props.stats.avgLatency));
</script>

<template>
  <el-popover
    trigger="click"
    :show-arrow="false"
    :width="360"
    placement="bottom-end"
    :offset="8"
    popper-class="status-dropdown-popper"
  >
    <template #reference>
      <div class="status-trigger" :class="{ 'is-abnormal': isAbnormal }" :title="tooltipText">
        <span
          class="status-dot"
          :style="{ backgroundColor: getLatencyColor(stats.avgLatency) }"
        />
        <span class="status-latency">{{ formatLatency(stats.avgLatency) }}</span>
      </div>
    </template>

    <!-- 面板内容 -->
    <div class="status-panel">
      <!-- 标题行 -->
      <div class="panel-header">
        <span class="panel-title">系统健康</span>
      </div>
      <div class="panel-summary" :class="{ 'is-abnormal': isAbnormal }">
        {{ healthSummary }}
      </div>

      <el-divider style="margin: 10px 0" />

      <!-- 延迟 + 成功率 -->
      <div class="panel-stats-row">
        <div class="panel-stat">
          <span class="stat-label">平均延迟</span>
          <span class="stat-value" :style="{ color: getLatencyColor(stats.avgLatency) }">
            {{ formatLatency(stats.avgLatency) }}
          </span>
        </div>
        <div class="panel-stat">
          <span class="stat-label">成功率</span>
          <span class="stat-value">
            <el-tag :type="getSuccessRateType(stats.successRate)" size="small">
              {{ stats.successRate }}%
            </el-tag>
          </span>
        </div>
      </div>

      <!-- Sparkline -->
      <div v-if="sparklinePoints" class="sparkline-container">
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" class="sparkline-svg">
          <polyline
            :points="sparklinePoints"
            fill="none"
            :stroke="sparklineColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>

      <el-divider style="margin: 10px 0" />

      <!-- 模块延迟 -->
      <div class="module-section" v-if="filteredModules.length > 0">
        <div class="section-label">模块延迟</div>
        <div class="module-list">
          <div class="module-item" v-for="mod in filteredModules" :key="mod.moduleKey">
            <span class="module-name">{{ mod.name }}</span>
            <div class="module-bar-wrapper">
              <div class="module-bar" :style="{
                width: getModuleLatencyWidth(mod),
                backgroundColor: getLatencyColor(getModuleLatency(mod))
              }"></div>
            </div>
            <span class="module-latency" :style="{ color: getLatencyColor(getModuleLatency(mod)) }">
              {{ formatLatency(getModuleLatency(mod)) }}
            </span>
          </div>
        </div>
      </div>

      <!-- 数据状态 -->
      <template v-if="dataStatus">
        <el-divider style="margin: 10px 0" />

        <div class="data-rows">
          <div class="data-row">
            <span class="data-label">最近压缩</span>
            <span class="data-value" :class="{ 'is-empty': !dataStatus.lastCompaction }">
              {{ formatRelativeTime(dataStatus.lastCompaction) }}
            </span>
            <span class="data-label" style="margin-left: 12px;">记忆</span>
            <span class="data-value" :class="{ 'is-empty': !dataStatus.lastMemoryFlush }">
              {{ formatRelativeTime(dataStatus.lastMemoryFlush) }}
            </span>
          </div>
          <div class="data-row">
            <span class="data-label">今日过滤</span>
            <span class="data-value is-number">{{ dataStatus.todayFiltered }}</span>
          </div>
        </div>

        <!-- 异常行（仅异常时显示） -->
        <div v-if="showAnomalyRow" class="data-rows anomaly-section">
          <div class="data-row">
            <span class="data-label is-danger">今日失败</span>
            <span class="data-value is-danger">{{ dataStatus.todayRetryCount }}次</span>
            <span class="data-label is-danger" style="margin-left: 12px;">模型切换</span>
            <span class="data-value is-danger">{{ dataStatus.todayModelChangeCount }}次</span>
          </div>
        </div>
      </template>
    </div>
  </el-popover>
</template>

<style scoped>
/* 收起态触发器 */
.status-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 16px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-extra-light);
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
  user-select: none;
}

.status-trigger:hover {
  background: var(--el-fill-color);
  border-color: var(--el-border-color-light);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  animation: dot-breathe 1.5s ease-in-out infinite;
}

.status-trigger.is-abnormal .status-dot {
  animation: dot-breathe 1.5s ease-in-out infinite, dot-pulse 1s ease-in-out infinite;
}

.status-latency {
  font-family: var(--font-exo2, ui-monospace, monospace);
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  line-height: 1;
}

@keyframes dot-breathe {
  0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(64, 158, 255, 0.4); }
  50% { transform: scale(1.15); opacity: 0.85; box-shadow: 0 0 0 4px rgba(64, 158, 255, 0); }
}

@keyframes dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.5); }
  50% { box-shadow: 0 0 0 6px rgba(245, 108, 108, 0); }
}

/* ===== 面板内容 ===== */
.status-panel {
  min-width: 0;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.panel-summary {
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.panel-summary.is-abnormal {
  color: var(--el-color-danger);
}

/* 延迟 + 成功率 */
.panel-stats-row {
  display: flex;
  gap: 24px;
}

.panel-stat {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stat-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.stat-value {
  font-family: var(--font-exo2, ui-monospace, monospace);
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* Sparkline */
.sparkline-container {
  margin-top: 8px;
  height: 30px;
  width: 100%;
}

.sparkline-svg {
  width: 100%;
  height: 30px;
}

/* 模块延迟 */
.module-section {
  margin-bottom: 2px;
}

.section-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}

.module-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.module-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.module-name {
  width: 70px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-exo2, ui-monospace, monospace);
  flex-shrink: 0;
}

/* 数据状态行 */
.data-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.data-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.data-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.data-value {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-exo2, ui-monospace, monospace);
  color: var(--el-text-color-primary);
}

.data-value.is-number {
  color: var(--el-color-primary);
}

.data-value.is-empty {
  color: var(--el-text-color-placeholder);
  font-weight: 400;
}

.data-label.is-danger,
.data-value.is-danger {
  color: var(--el-color-danger);
}

.anomaly-section {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--el-border-color-light);
}
</style>
