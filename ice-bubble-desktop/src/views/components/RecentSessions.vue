<script setup lang="ts">
/**
 * RecentSessions.vue — 最近会话列表（右侧时间线区域）
 * 包装 ChatTimeline 组件，保持原有功能
 */
import ChatTimeline from './ChatTimeline.vue';

interface Props {
  loading?: boolean;
}

defineProps<Props>();
</script>

<template>
  <div class="recent-sessions">
    <!-- 加载骨架屏 -->
    <div v-if="loading" class="sessions-skeleton">
      <div class="skeleton-header"></div>
      <div class="skeleton-list">
        <div v-for="i in 5" :key="i" class="skeleton-item">
          <div class="skeleton-avatar"></div>
          <div class="skeleton-bubble">
            <div class="skeleton-line long"></div>
            <div class="skeleton-line medium"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 实际内容 -->
    <ChatTimeline v-else />
  </div>
</template>

<style scoped>
.recent-sessions {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.sessions-skeleton {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.skeleton-header {
  height: 36px;
  width: 200px;
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    var(--el-skeleton-color, #e8e8e8) 25%,
    var(--el-skeleton-to-color, #f2f2f2) 50%,
    var(--el-skeleton-color, #e8e8e8) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}

.skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}

.skeleton-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.skeleton-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
  background: linear-gradient(
    90deg,
    var(--el-skeleton-color, #e8e8e8) 25%,
    var(--el-skeleton-to-color, #f2f2f2) 50%,
    var(--el-skeleton-color, #e8e8e8) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}

.skeleton-bubble {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--el-fill-color-light);
}

.skeleton-line {
  height: 12px;
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

.skeleton-line.long { width: 85%; }
.skeleton-line.medium { width: 55%; }

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
