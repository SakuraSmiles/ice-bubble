<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';

const route = useRoute();

const menuItems = [
  { path: '/', label: '工作台' },
  { path: '/modules', label: '模块管理' },
];
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="logo">IceBubble</div>
        <div class="subtitle">Topdesk</div>
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
            <svg v-else-if="item.path === '/sessions'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 3.5a.5.5 0 01.5-.5H13a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0 4a.5.5 0 01.5-.5h10a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0 4a.5.5 0 01.5-.5h6a.5.5 0 010 1H3a.5.5 0 01-.5-.5z"/>
            </svg>
          </span>
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="footer-row">
          <span class="version">v1.0.0</span>
          <button class="settings-btn" title="设置">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 114.492 0 2.246 2.246 0 01-4.492 0z"/>
              <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 01-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 01-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 01.52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 011.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 011.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 01.52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 01-.52-1.255l.292-.16c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 01-1.255-.52l-.094-.319z"/>
            </svg>
          </button>
        </div>
      </div>
    </aside>

    <main class="main-content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.sidebar {
  width: 200px;
  background: var(--color-bg);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 10px 16px;
  text-align: center;
  border-bottom: 1px solid var(--color-border);
}

.logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
  letter-spacing: 0.3px;
}

.subtitle {
  font-size: 11px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-top: 4px;
}

.sidebar-nav {
  flex: 1;
  padding: 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius);
  color: var(--color-text-secondary);
  text-decoration: none;
  font-size: 14px;
  transition: background 0.15s, color 0.15s;
}

.nav-item:hover {
  background: var(--color-bg-subtle);
  color: var(--color-text);
}

.nav-item.active {
  background: var(--color-bg-subtle);
  color: var(--color-text);
  font-weight: 600;
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

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
}

.footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.version {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
}

.settings-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.settings-btn:hover {
  background: var(--color-bg-subtle);
  color: var(--color-text);
  border-color: var(--color-text-secondary);
}

.main-content {
  flex: 1;
  background: var(--color-bg-subtle);
  overflow-y: auto;
}
</style>
