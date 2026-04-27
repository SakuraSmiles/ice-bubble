<script setup lang="ts">
/**
 * SystemHealth.vue — 系统健康状态
 * 包含延迟监控 + 模块延迟列表
 */
import { watch, ref } from 'vue';
import type { MonitorStats } from '../../utils/monitor';
import type { ModuleDTO } from '../../api/client';

interface Props {
  stats: MonitorStats;
  modules: ModuleDTO[];
  loading?: boolean;
}

const props = defineProps<Props>();

const filteredModules = ref<ModuleDTO[]>([]);
const maxModuleLatency = ref(1);

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getLatencyColor(ms: number): string {
  if (ms < 50) return 'var(--el-color-success)';
  if (ms < 100) return 'var(--el-color-warning)';
  return 'var(--el-color-danger)';
}

function getSuccessRateType(rate: number): string {
  if (rate >= 99) return 'success';
  if (rate >= 95) return 'warning';
  return 'danger';
}

function getModuleLatency(mod: ModuleDTO): number {
  return mod.status?.latencyMs || 0;
}

function getModuleLatencyWidth(mod: ModuleDTO): string {
  const latency = getModuleLatency(mod);
  return `${Math.min((latency / maxModuleLatency.value) * 100, 100)}%`;
}

watch(() => props.modules, (newList) => {
  const filtered = newList.filter((m: ModuleDTO) => m.moduleKey !== 'admin');
  filteredModules.value = filtered;
  if (filtered.length > 0) {
    maxModuleLatency.value = Math.max(...filtered.map((m: ModuleDTO) => getModuleLatency(m)), 1);
  }
}, { immediate: true, deep: true });
</script>

<template>
  <div class="system-health">
    <el-card class="health-card" shadow="hover">
      <template #header>
        <div class="card-header">
          <span>系统健康</span>
          <el-tag size="small" type="info">实时</el-tag>
        </div>
      </template>

      <!-- 加载骨架屏 -->
      <div v-if="loading" class="health-skeleton">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line medium"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-divider"></div>
        <div class="skeleton-line medium" style="margin-bottom: 8px;"></div>
        <div v-for="i in 4" :key="i" class="skeleton-module-row">
          <div class="skeleton-line short" style="width: 60px;"></div>
          <div class="skeleton-block" style="flex: 1;"></div>
          <div class="skeleton-line short" style="width: 40px;"></div>
        </div>
      </div>

      <!-- 实际内容 -->
      <div v-else class="health-content">
        <div class="health-stats">
          <div class="health-stat">
            <span class="label">平均延迟</span>
            <span class="value" :style="{ color: getLatencyColor(stats.avgLatency) }">
              {{ formatLatency(stats.avgLatency) }}
            </span>
          </div>
          <div class="health-stat">
            <span class="label">延迟范围</span>
            <span class="value small">
              {{ formatLatency(stats.minLatency) }} ~ {{ formatLatency(stats.maxLatency) }}
            </span>
          </div>
          <div class="health-stat">
            <span class="label">成功率</span>
            <el-tag :type="getSuccessRateType(stats.successRate)" size="small">
              {{ stats.successRate }}%
            </el-tag>
          </div>
        </div>

        <el-divider style="margin: 8px 0" />

        <div class="module-section">
          <div class="section-title">模块延迟</div>
          <div class="module-list" v-if="filteredModules.length > 0">
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
          <el-empty v-else description="暂无数据" :image-size="30" />
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.system-health {
  width: 100%;
}

.health-card :deep(.el-card__header) {
  padding: 10px 12px;
}

.health-card :deep(.el-card__body) {
  padding: 10px 12px;
}

.health-card :deep(.el-card) {
  border: 1px solid var(--el-border-color-light);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--el-text-color-secondary);
  font-weight: 600;
  font-size: 13px;
}

.health-stats {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.health-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.health-stat .label {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}

.health-stat .value {
  font-size: 14px;
  font-weight: 600;
  font-family: var(--font-exo2);
  color: var(--el-text-color-primary);
  line-height: 1.4;
}

.health-stat .value.small {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  line-height: 1.4;
}

.module-section {
  margin-top: 4px;
}

.section-title {
  font-size: 12px;
  font-weight: 400;
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
  width: 80px;
  font-size: 12px;
  font-weight: 400;
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
  font-family: var(--font-exo2);
  color: var(--el-text-color-primary);
  flex-shrink: 0;
}

/* ===== 骨架屏样式 ===== */
.health-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skeleton-line,
.skeleton-block {
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    var(--el-skeleton-color, #e8e8e8) 25%,
    var(--el-skeleton-to-color, #f2f2f2) 50%,
    var(--el-skeleton-color, #e8e8e8) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}

.skeleton-line.short { width: 40%; }
.skeleton-line.medium { width: 70%; }
.skeleton-divider { height: 1px; background: var(--el-border-color-extra-light); margin: 4px 0; }

.skeleton-module-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.skeleton-block {
  height: 4px;
  border-radius: 2px;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
