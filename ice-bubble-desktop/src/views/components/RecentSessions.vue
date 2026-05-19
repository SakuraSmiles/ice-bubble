<script setup lang="ts">
/**
 * RecentSessions.vue — 工作台会话概述时间线
 */
import ChatTimeline from './ChatTimeline.vue';
import SessionTimeline from './SessionTimeline.vue';</script>

<template>
  <div class="recent-sessions">
    <div class="workspace-layout">
      <ChatTimeline />
      <SessionTimeline />
    </div>
  </div>
</template>

<style scoped>
.recent-sessions {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.workspace-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 24px;
  overflow: hidden;
}

/* SessionTimeline 固定右侧 360px */
.workspace-layout > :last-child {
  flex: 0 0 360px;
  min-width: 0;
}
</style>
