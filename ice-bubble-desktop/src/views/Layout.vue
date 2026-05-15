<script setup lang="ts">
import { provide, ref, onMounted, onUnmounted } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { gatewayClient } from '@/services/gateway-client';
import WorkspacePanel from '@/components/WorkspacePanel.vue';
import GlobalSearch from '@/components/GlobalSearch.vue';

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

// ====== 左侧边栏展开/收起 + 拖拽 ======
const sidebarWidth = ref(200)
const sidebarCollapsed = ref(false)
const SIDEBAR_MIN = 120
const SIDEBAR_MAX = 320
const isDraggingSidebar = ref(false)
const showGlobalSearch = ref(false)

function startDragSidebar(e: MouseEvent) {
  e.preventDefault()
  isDraggingSidebar.value = true
  const startX = e.clientX
  const startWidth = sidebarWidth.value

  const onMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX
    sidebarWidth.value = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + delta))
  }
  const onUp = () => {
    isDraggingSidebar.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ====== 全局搜索快捷键盘 Cmd+K / Ctrl+K ======
function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    showGlobalSearch.value = true;
  }
}

onMounted(() => {
  document.addEventListener('keydown', onGlobalKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});

const menuItems = [
  { path: '/', label: '工作台', match: (p: string) => p === '/' },
  { path: '/chat', label: '聊天', match: (p: string) => p === '/chat' || p.startsWith('/workspace/') },
  { path: '/agents', label: '成员', match: (p: string) => p === '/agents' },
  { path: '/sessions', label: '会话', match: (p: string) => p === '/sessions' },
  { path: '/modules', label: '模块', match: (p: string) => p === '/modules' },
  { path: '/settings', label: '配置', match: (p: string) => p === '/settings' },
  { path: '/logs', label: '日志', match: (p: string) => p === '/logs' },
];
</script>

<template>
  <div class="layout">
    <aside
      class="sidebar"
      :class="{ 'no-transition': isDraggingSidebar }"
      v-show="!sidebarCollapsed"
      :style="{ width: sidebarWidth + 'px', '--sidebar-width': sidebarWidth + 'px' }"
    >
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
          :class="{ active: item.match(route.path) }"
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
            <svg v-else-if="item.path === '/settings'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <!-- 齿轮图标 -->
              <path d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 112.492 2.49 2.246 2.246 0 01-2.492-2.49z"/>
              <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 01-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 01-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 01.52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 011.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 011.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 01.52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 01-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 01-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 002.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 001.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 00-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 00-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 00-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 003.05 9.808l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 004.165 5.25l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 002.692-1.116l.094-.318z"/>
            </svg>
            <svg v-else-if="item.path === '/logs'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <!-- 文档图标 -->
              <path d="M4 0h5.5v1.5H4V0zm0 3h5.5v1.5H4V3zM2 1a1 1 0 011-1h1v1.5H3.5v11h1V14H3a1 1 0 01-1-1V1z"/>
              <path d="M9.5 0v1.5H11L8.5 4 7.1 2.6 9.5.2V0h-1L6 3 8.5 5.5 12 2H10.5V0h-1zM4 6h5.5v1.5H4V6zm0 3h5.5v1.5H4V9z"/>
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <!-- 聊天气泡图标 -->
              <path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H7.414l-2.707 2.707A1 1 0 013 14V12H4a2 2 0 01-2-2V2zm2-1a1 1 0 00-1 1v8a1 1 0 001 1h.414A1 1 0 014.5 11.5V14l2.293-2.293A1 1 0 017.5 11.5H12a1 1 0 001-1V2a1 1 0 00-1-1H4z"/>
            </svg>
          </span>
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>
      <!-- 右边缘拖拽手柄 -->
      <div
        class="resize-handle resize-handle-right"
        :class="{ active: isDraggingSidebar }"
        @mousedown="startDragSidebar"
      />
    </aside>

    <!-- 左侧：居中切换按钮（标签页风格） -->
    <div
      class="sidebar-toggle toggle-left"
      :class="[
        sidebarCollapsed ? 'toggle-expand' : 'toggle-collapse',
        { 'no-transition': isDraggingSidebar }
      ]"
      :style="!sidebarCollapsed ? { '--sidebar-width': sidebarWidth + 'px' } : {}"
      @click="sidebarCollapsed = !sidebarCollapsed"
      :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
    >
      <span class="toggle-arrow">{{ sidebarCollapsed ? '▸' : '◂' }}</span>
    </div>

    <main class="main-content">
      <RouterView />
    </main>

    <WorkspacePanel />

    <!-- 全局搜索 -->
    <GlobalSearch v-model="showGlobalSearch" />
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
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  height: 100vh;
  overflow: hidden;
  box-shadow: none;
  position: relative;
  transition: width 0.2s ease;
}

/* 拖拽手柄 */
.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  z-index: 10;
  cursor: col-resize;
  transition: background 0.15s;
}

.resize-handle:hover {
  background: transparent;
}

.resize-handle-right:hover {
  box-shadow: 4px 0 12px rgba(0, 0, 0, 0.1);
}

.resize-handle-left:hover {
  box-shadow: -4px 0 12px rgba(0, 0, 0, 0.1);
}

.resize-handle-right {
  right: -2px;
}

.resize-handle-left {
  left: -2px;
}

/* ====== 侧栏切换按钮（标签页风格） ====== */
.sidebar-toggle {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 20;
  background: var(--color-bg-canvas);
  transition: all 0.15s ease;
}

.sidebar-toggle:hover {
  background: var(--el-fill-color-light);
}

/* 左侧方向 */
.toggle-left {
  border: 1px solid var(--color-border-subtle);
  border-left: none;
  border-radius: 0 8px 8px 0;
  box-shadow: 1px 0 3px rgba(0, 0, 0, 0.05);
}

.toggle-left:hover {
  box-shadow: 1px 0 6px rgba(0, 0, 0, 0.1);
}

/* 展开（侧栏隐藏，按钮贴左边缘） */
.toggle-left.toggle-expand {
  left: 0;
}

/* 收起（侧栏显示，按钮在侧栏右边缘） */
.toggle-left.toggle-collapse {
  left: calc(var(--sidebar-width, 200px) - 1px);
  transition: left 0.2s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.toggle-arrow {
  font-size: 10px;
  color: var(--color-text-tertiary);
  transition: color 0.15s;
}

.sidebar-toggle:hover .toggle-arrow {
  color: var(--color-text);
}

.no-transition {
  transition: none !important;
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
  transition: all 150ms ease;
  position: relative;
  user-select: none;
}

.nav-item:hover {
  background: var(--ib-hover-bg);
  color: var(--color-text);
}

.nav-item.active {
  background: var(--ib-hover-bg-accent);
  color: var(--color-accent-blue);
  font-weight: 500;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 22px;
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
  padding-left: 4px;
  padding-right: 4px;
}
</style>
