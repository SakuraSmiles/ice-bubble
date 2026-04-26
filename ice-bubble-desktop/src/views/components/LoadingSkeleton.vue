<script setup lang="ts">
/**
 * LoadingSkeleton.vue — 共用骨架屏组件
 * 支持多种模式：card（卡片）、list（列表）、text（文本行）
 * 加载完成后有 opacity fade-out 过渡动画
 */

interface Props {
  /** 骨架屏类型 */
  type?: 'card' | 'list' | 'text' | 'avatar' | 'chart' | 'stats';
  /** 是否正在加载（false 时显示 fade-out 动画后消失） */
  loading?: boolean;
  /** 行数（text/list 模式） */
  rows?: number;
  /** 自定义高度 */
  height?: string;
  /** 自定义宽度 */
  width?: string;
}

withDefaults(defineProps<Props>(), {
  type: 'card',
  loading: true,
  rows: 3,
  height: '100px',
  width: '100%',
});
</script>

<template>
  <!-- 统计卡片骨架屏 -->
  <div v-if="type === 'stats'" class="skeleton-stats" :class="{ 'fade-out': !loading }">
    <div v-for="i in 4" :key="i" class="stat-card">
      <div class="skeleton-line short"></div>
      <div class="skeleton-line medium"></div>
    </div>
  </div>

  <!-- 列表骨架屏 -->
  <div v-else-if="type === 'list'" class="skeleton-list" :class="{ 'fade-out': !loading }">
    <div v-for="i in rows" :key="i" class="skeleton-list-item">
      <div class="skeleton-avatar"></div>
      <div class="skeleton-text">
        <div class="skeleton-line long"></div>
        <div class="skeleton-line medium"></div>
      </div>
    </div>
  </div>

  <!-- 卡片骨架屏 -->
  <div v-else-if="type === 'card'" class="skeleton-card" :class="{ 'fade-out': !loading }"
    :style="{ height, width }">
    <div class="skeleton-line short"></div>
    <div class="skeleton-line long"></div>
    <div class="skeleton-line medium"></div>
    <div class="skeleton-block"></div>
  </div>

  <!-- 头像骨架屏 -->
  <div v-else-if="type === 'avatar'" class="skeleton-avatar-block" :class="{ 'fade-out': !loading }">
    <div class="skeleton-avatar-circle"></div>
    <div class="skeleton-text">
      <div class="skeleton-line medium"></div>
      <div class="skeleton-line short"></div>
    </div>
  </div>

  <!-- 图表骨架屏 -->
  <div v-else-if="type === 'chart'" class="skeleton-chart" :class="{ 'fade-out': !loading }"
    :style="{ height, width }">
    <div class="chart-bars">
      <div v-for="i in 8" :key="i" class="chart-bar" :style="{ height: (20 + Math.random() * 60) + '%' }"></div>
    </div>
    <div class="chart-label"></div>
  </div>

  <!-- 文本行骨架屏 -->
  <div v-else class="skeleton-text-block" :class="{ 'fade-out': !loading }">
    <div v-for="i in rows" :key="i" class="skeleton-line"
      :class="i === rows ? 'medium' : (i === 1 ? 'long' : 'long')"></div>
  </div>
</template>

<style scoped>
/* ===== 共享骨架屏样式 ===== */
.skeleton-line,
.skeleton-block,
.skeleton-avatar,
.skeleton-avatar-circle {
  background: linear-gradient(
    90deg,
    var(--el-skeleton-color, #e8e8e8) 25%,
    var(--el-skeleton-to-color, #f2f2f2) 50%,
    var(--el-skeleton-color, #e8e8e8) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  border-radius: 4px;
}

.skeleton-line {
  height: 14px;
  margin-bottom: 10px;
}
.skeleton-line.short { width: 35%; }
.skeleton-line.medium { width: 60%; }
.skeleton-line.long { width: 100%; }

.skeleton-block {
  height: 80px;
  border-radius: 6px;
  margin-top: 8px;
}

@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ===== 统计卡片骨架屏 ===== */
.skeleton-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  transition: opacity 0.5s ease;
}

.skeleton-stats.fade-out {
  opacity: 0;
  pointer-events: none;
}

.stat-card {
  padding: 16px;
  border-radius: 8px;
  background: var(--el-fill-color-light, #f5f7fa);
  border: 1px solid var(--el-border-color-extra-light, #ebeef5);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ===== 列表骨架屏 ===== */
.skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: opacity 0.5s ease;
}

.skeleton-list.fade-out {
  opacity: 0;
  pointer-events: none;
}

.skeleton-list-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light, #f5f7fa);
}

.skeleton-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ===== 卡片骨架屏 ===== */
.skeleton-card {
  padding: 20px;
  border-radius: 8px;
  background: var(--el-fill-color-light, #f5f7fa);
  border: 1px solid var(--el-border-color-extra-light, #ebeef5);
  display: flex;
  flex-direction: column;
  justify-content: center;
  transition: opacity 0.5s ease;
}

.skeleton-card.fade-out {
  opacity: 0;
  pointer-events: none;
}

/* ===== 头像骨架屏 ===== */
.skeleton-avatar-block {
  display: flex;
  align-items: center;
  gap: 12px;
  transition: opacity 0.5s ease;
}

.skeleton-avatar-block.fade-out {
  opacity: 0;
  pointer-events: none;
}

.skeleton-avatar-circle {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* ===== 图表骨架屏 ===== */
.skeleton-chart {
  padding: 16px;
  border-radius: 8px;
  background: var(--el-fill-color-light, #f5f7fa);
  border: 1px solid var(--el-border-color-extra-light, #ebeef5);
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: opacity 0.5s ease;
}

.skeleton-chart.fade-out {
  opacity: 0;
  pointer-events: none;
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  flex: 1;
}

.chart-bar {
  flex: 1;
  border-radius: 2px 2px 0 0;
  min-height: 10px;
}

.chart-label {
  height: 10px;
  width: 60%;
  border-radius: 4px;
}

/* ===== 文本块骨架屏 ===== */
.skeleton-text-block {
  display: flex;
  flex-direction: column;
  gap: 0;
  transition: opacity 0.5s ease;
}

.skeleton-text-block.fade-out {
  opacity: 0;
  pointer-events: none;
}
</style>
