<script setup lang="ts">
import { provide, ref, onMounted, onUnmounted } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { gatewayClient } from '@/services/gateway-client';

const route = useRoute();

// GatewayClient 连接状态
const gatewayConnected = ref(false);
const gatewayInitError = ref<string | null>(null);

// 全局连接状态，供子视图使用
const isAdminConnected = ref(true);
provide('isAdminConnected', isAdminConnected);
provide('gatewayConnected', gatewayConnected);

// 初始化 GatewayClient
onMounted(async () => {
  try {
    await gatewayClient.connect();
    gatewayConnected.value = true;
    gatewayInitError.value = null;
  } catch (e) {
    gatewayConnected.value = false;
    gatewayInitError.value = e instanceof Error ? e.message : 'Gateway 连接失败';
    console.warn('[Layout] Gateway 连接失败，降级到轮询模式:', e);
  }

  // 监听连接状态变化
  gatewayClient.on('connect', () => {
    gatewayConnected.value = true;
    gatewayInitError.value = null;
  });
  gatewayClient.on('disconnect', () => {
    gatewayConnected.value = false;
  });
});

onUnmounted(() => {
  gatewayClient.disconnect();
});

const menuItems = [
  { path: '/', label: '工作台' },
  { path: '/chat', label: '聊天' },
  { path: '/agents', label: '成员' },
  { path: '/sessions', label: '会话' },
  { path: '/modules', label: '模块' },
];
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="logo">IceBubble</div>
        <div class="subtitle">DESKTOP</div>
      </div>

      <nav class="sidebar-nav">
        <RouterLink
          v-for="item in menuItems"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :class="{ active: route.path === item.path }"
        >
          <span class="nav-icon">
            <svg v-if="item.path === '/'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0L0 4v4h4v4h4v4h4v-4h4V4zm4 12h4V8H8V4l-4 2v6h4v4z"/>
            </svg>
            <svg v-else-if="item.path === '/modules'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 2.5A1.5 1.5 0 012.5 1h3A1.5 1.5 0 017 2.5v3A1.5 1.5 0 015.5 7h-3A1.5 1.5 0 011 5.5v-3zM2.5 2a.5.5 0 00-.5.5v3a.5.5 0 00.5.5h3a.5.5 0 00.5-.5v-3a.5.5 0 00-.5-.5h-3zM0 13.5A1.5 1.5 0 011.5 12h3A1.5 1.5 0 016 13.5v1.5A1.5 1.5 0 014.5 16.5h-3A1.5 1.5 0 010 15v-1.5zm1.5-.5a.5.5 0 00-.5.5v1.5a.5.5 0 00.5.5h3a.5.5 0 00.5-.5v-1.5a.5.5 0 00-.5-.5h-3zm7.5 0a.5.5 0 00-.5.5v1.5a.5.5 0 00.5.5h3a.5.5 0 00.5-.5v-1.5a.5.5 0 00-.5-.5h-3z"/>
            </svg>
            <svg v-else-if="item.path === '/agents'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 3.5c.83 0 1.5-.67 1.5-1.5S3.83 8.5 3 8.5 1.5 9.17 1.5 10s.67 1.5 1.5 1.5zm5 0c.83 0 1.5-.67 1.5-1.5S8.83 8.5 8 8.5 6.5 9.17 6.5 10s.67 1.5 1.5 1.5zm-3 3a4 4 0 01-4 0c0-1.5.5-3 2-4.5V13h8v-1.5c1.5 1.5 2 3 2 4.5a4 4 0 01-4 0z"/>
            </svg>
            <svg v-else-if="item.path === '/sessions'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <!-- 列表图标 -->
              <path fill-rule="evenodd" d="M2.5 3a.5.5 0 00-.5.5.5.5 0 00.5.5h11a.5.5 0 00.5-.5.5.5 0 00-.5-.5h-11zm0 4a.5.5 0 00-.5.5.5.5 0 00.5.5h11a.5.5 0 00.5-.5.5.5 0 00-.5-.5h-11zm0 4a.5.5 0 00-.5.5.5.5 0 00.5.5h11a.5.5 0 00.5-.5.5.5 0 00-.5-.5h-11z"/>
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <!-- 聊天气泡图标 -->
              <path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H7.414l-2.707 2.707A1 1 0 013 14V12H4a2 2 0 01-2-2V2zm2-1a1 1 0 00-1 1v8a1 1 0 001 1h.414A1 1 0 014.5 11.5V14l2.293-2.293A1 1 0 017.5 11.5H12a1 1 0 001-1V2a1 1 0 00-1-1H4z"/>
            </svg>
          </span>
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>
    </aside>

    <main class="main-content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* ====== 侧栏 ====== */
.sidebar {
  width: 200px;
  background: var(--color-bg-canvas);
  border-right: none;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  height: 100vh;
  overflow: hidden;
  box-shadow: 1px 0 0 var(--color-border-subtle);
}

.sidebar-header {
  padding: 10px 16px;
  text-align: center;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}

.logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
  letter-spacing: 0.3px;
  font-family: 'Eurostile', 'NotoSansSC', sans-serif;
}

.subtitle {
  font-size: 11px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-top: 4px;
}

.sidebar-nav {
  flex: 0 0 auto;
  padding: 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius);
  color: var(--color-text-secondary);
  text-decoration: none;
  font-size: 14px;
  transition: background 0.15s, color 0.15s;
  position: relative;
}

.nav-item:hover {
  background: var(--el-fill-color-light);
  color: var(--color-text);
}

.nav-item.active {
  background: var(--color-accent-blue-subtle);
  color: var(--color-accent-blue);
  font-weight: 500;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  background: var(--color-accent-blue);
  border-radius: 0 2px 2px 0;
}

.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.nav-label {
  flex: 1;
}

/* ====== 主内容区 ====== */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  overflow: hidden;
}
</style>
