<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { request } from '../../api/client';

// ===== 类型 =====

interface SessionFlow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  avatar: string | null;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  message_count: number;
  spawn_depth: number;
  sessions_count: number;
  summary: string | null;
  gap_minutes: number;
}

interface FlowGroup {
  label: string;
  sortKey: string;
  flows: SessionFlow[];
}

interface FlowsResponse {
  flows: FlowGroup[];
  total: number;
}

// ===== 状态 =====

const flowGroups = ref<FlowGroup[]>([]);
const loading = ref(false);
const error = ref('');

// ===== 计算属性 =====

const totalFlows = computed(() =>
  flowGroups.value.reduce((sum, g) => sum + g.flows.length, 0)
);

const totalAgents = computed(() => {
  const ids = new Set<string>();
  for (const g of flowGroups.value) {
    for (const f of g.flows) {
      if (f.agent_id) ids.add(f.agent_id);
    }
  }
  return ids.size;
});

// ===== 格式化 =====

function formatTime(at: string): string {
  const d = new Date(at);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function formatDurationMins(mins: number): string {
  if (!mins || mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h`;
}

function flowSummary(f: SessionFlow): string {
  if (!f.summary) return '';
  try {
    const data = JSON.parse(f.summary);
    // 支持 { segments: [...] } 或直接的数组
    const segs = Array.isArray(data) ? data : data?.segments;
    if (Array.isArray(segs) && segs.length > 0) {
      // 取最后一条有内容的摘要
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i].text && segs[i].text.trim()) {
          return segs[i].text.trim();
        }
      }
    }
    if (typeof data === 'string' && data.trim()) return data.trim();
  } catch {}
  return f.summary || '';
}

// ===== 数据请求 =====

async function fetchFlows() {
  loading.value = true;
  error.value = '';
  try {
    const res = await request('/sessions/flows?days=2');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: FlowsResponse = await res.json();
    flowGroups.value = data.flows || [];
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  fetchFlows();
  pollTimer = setInterval(fetchFlows, 60000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="stl-root">
    <!-- 头部：标题 + 统计一行 -->
    <div class="stl-header">
      <span class="stl-header__title">时间线</span>
      <span class="stl-header__sep">·</span>
      <span class="stl-header__stat">{{ totalFlows }} 条</span>
      <span class="stl-header__dot"></span>
      <span class="stl-header__stat">{{ totalAgents }} 位 Agent</span>
      <span class="stl-header__dot"></span>
      <span class="stl-header__stat stl-header__stat--highlight">{{ flowGroups[0]?.label || '最近' }}</span>
    </div>

    <div v-if="error" class="stl-error">{{ error }}</div>
    <div v-if="loading && flowGroups.length === 0" class="stl-loading">加载中…</div>
    <div v-if="flowGroups.length === 0 && !loading" class="stl-empty">暂无会话记录</div>

    <!-- 时间线主体 -->
    <div class="stl-timeline" v-if="flowGroups.length > 0">
      <div v-for="group in flowGroups" :key="group.sortKey" class="stl-group">
        <!-- 日期块标题 -->
        <div class="stl-group__header">
          <span class="stl-group__label">{{ group.label }}</span>
          <span class="stl-group__line"></span>
          <span class="stl-group__count">{{ group.flows.length }}</span>
        </div>

        <!-- 工作流条目 -->
        <div
          v-for="(flow, idx) in group.flows"
          :key="flow.id"
          class="stl-item"
          :class="{ 'stl-item--sub': flow.spawn_depth > 0 }"
        >
          <!-- 左侧：时间 + 圆点 -->
          <div class="stl-item__time-dot">
            <span class="stl-item__time">{{ formatTime(flow.end_at) }}</span>
            <div class="stl-item__rail">
              <span class="stl-item__dot"></span>
              <span v-if="idx < group.flows.length - 1" class="stl-item__line"></span>
            </div>
          </div>

          <!-- 右侧内容 -->
          <div class="stl-item__content">
            <div class="stl-item__row">
              <div class="stl-item__row-left">
                <!-- Agent 名 -->
                <span class="stl-item__agent">{{ flow.agent_name || flow.agent_id }}</span>
                <!-- 消息数 -->
                <span v-if="flow.message_count" class="stl-item__pill">{{ flow.message_count }}条</span>
              </div>
              <div class="stl-item__row-right">
                <!-- 耗时 -->
                <span v-if="flow.duration_minutes" class="stl-item__pill stl-item__pill--dim">{{ formatDurationMins(flow.duration_minutes) }}</span>
                <!-- 会话数（>1时显示） -->
                <span v-if="flow.sessions_count > 1" class="stl-item__pill stl-item__pill--count">{{ flow.sessions_count }}次会话</span>
              </div>
            </div>
            <!-- 摘要 -->
            <div v-if="flowSummary(flow)" class="stl-item__summary">{{ flowSummary(flow) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ================================================================
   SessionTimeline — 精密工作台风格
   ================================================================ */

.stl-root {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0 20px 24px;
  overflow: hidden;
  background: var(--el-bg-color);
}

/* ===== 头部 ===== */
.stl-header {
  display: flex;
  align-items: center;
  padding: 10px 0 8px;
  gap: 0;
  flex-wrap: nowrap;
  overflow: hidden;
}

.stl-header__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  flex-shrink: 0;
}

.stl-header__sep {
  font-size: 11px;
  color: var(--el-border-color-darker);
  margin: 0 6px;
  flex-shrink: 0;
}

.stl-header__stat {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.stl-header__stat--highlight {
  color: var(--el-color-primary);
  font-weight: 600;
  background: var(--el-fill-color-light);
  padding: 2px 9px;
  border-radius: 10px;
  line-height: 1.6;
  letter-spacing: 0;
  text-transform: none;
}

.stl-header__dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--el-border-color-darker);
  flex-shrink: 0;
  margin: 0 6px;
}

/* ===== 时间线主体 ===== */
.stl-timeline {
  width: 100%;
  padding-top: 6px;
}

/* ===== 日期分组 ===== */
.stl-group {
  margin-bottom: 22px;
}

.stl-group:last-child { margin-bottom: 0; }
.stl-group:first-child { margin-top: 10px; }

.stl-group__header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 2px;
  padding: 6px 0;
}

.stl-group__label {
  font-size: 10px;
  font-weight: 600;
  color: var(--el-text-color-tertiary, var(--el-text-color-placeholder));
  white-space: nowrap;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.stl-group__line {
  flex: 1;
  height: 1px;
  background: var(--el-border-color-lighter);
  align-self: center;
}

.stl-group__count {
  font-size: 10px;
  font-weight: 600;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
  padding: 1px 8px;
  border-radius: 10px;
  line-height: 1.7;
  white-space: nowrap;
}

/* ===== 会话条目 ===== */
.stl-item {
  display: flex;
  align-items: flex-start;
  position: relative;
  padding: 8px 0;
}

/* 左侧时间+圆点：固定宽度，垂直居中 */
.stl-item__time-dot {
  display: flex;
  align-items: center;
  width: 52px;
  flex-shrink: 0;
}

.stl-item__time {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-tertiary, var(--el-text-color-placeholder));
  white-space: nowrap;
  text-align: right;
  width: 32px;
  flex-shrink: 0;
  line-height: 20px;
  padding-top: 0;
}

/* 圆点竖线：固定20px高，圆点居中 */
.stl-item__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.stl-item__dot {
  display: block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--el-border-color-darker);
  flex-shrink: 0;
  transition: all 0.2s ease;
  margin-top: 7.5px;
  margin-bottom: 7.5px;
}

.stl-item__line {
  width: 1px;
  flex: 1;
  background: var(--el-border-color-lighter);
}

/* 悬停：圆点放大变蓝 */
.stl-item:hover .stl-item__dot {
  transform: scale(1.6);
  background: var(--el-color-primary);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
}

/* 右侧内容 */
.stl-item__content {
  flex: 1;
  min-width: 0;
  padding: 0 8px 14px;
  border-radius: 4px;
  transition: background 0.2s ease;
}

.stl-item__content:hover {
  background: var(--el-fill-color-lighter);
}

/* 单行：左半部分+右半部分，space-between */
.stl-item__row {
  display: flex;
  align-items: center;
  height: 20px;
  gap: 0;
  overflow: hidden;
  justify-content: space-between;
}

.stl-item__row-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  min-width: 0;
}

.stl-item__row-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.stl-item__agent {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  line-height: 1;
}

.stl-item--sub .stl-item__agent {
  font-style: italic;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.stl-item--sub .stl-item__dot {
  opacity: 0.35;
}

/* pills */
.stl-item__pill {
  font-size: 10px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  padding: 1px 7px;
  border-radius: 8px;
  white-space: nowrap;
  flex-shrink: 0;
  height: 16px;
  line-height: 16px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
}

.stl-item__pill--dim {
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-lighter);
}

.stl-item__pill--count {
  color: var(--el-color-primary);
  background: var(--el-fill-color-light);
}

.stl-item__content:hover .stl-item__pill {
  background: var(--el-fill-color-light);
}

.stl-item__content:hover .stl-item__pill--dim {
  background: var(--el-fill-color);
}

/* 摘要 */
.stl-item__summary {
  font-size: 11px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 2px;
}

/* ===== 状态消息 ===== */
.stl-error {
  padding: 12px 0;
  color: var(--el-color-danger);
  font-size: 12px;
}

.stl-loading,
.stl-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 0;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
</style>
