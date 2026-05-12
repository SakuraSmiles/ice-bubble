import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'highlight.js/styles/atom-one-dark.css';
import './assets/fonts.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

import App from './App.vue';
import Layout from './views/Layout.vue';

// 检查是否需要进入配置引导
// 纯前端检查：用户已完成过 Setup（保存或跳过），或已有有效的 admin URL 配置
function needsSetup(): boolean {
  try {
    // 用户已明确完成过 Setup 流程（保存连接或跳过）
    if (localStorage.getItem('ice-bubble-setup-done') === 'true') {
      return false;
    }
    // 兼容：已有 lastConnected 记录也视为已完成
    const raw = localStorage.getItem('ice-bubble-admin-config');
    if (raw) {
      const data = JSON.parse(raw);
      if (data.lastConnected) {
        return false;
      }
    }
  } catch {
    // ignore parse errors
  }
  return true;
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/setup',
      component: () => import('./views/Setup.vue'),
    },
    {
      path: '/',
      component: Layout,
      beforeEnter: (_to, _from, next) => {
        const setup = needsSetup();
        if (setup && _to.path !== '/setup') {
          next('/setup');
        } else {
          next();
        }
      },
      children: [
        { path: '', component: () => import('./views/Overview.vue') },
        { path: 'modules', component: () => import('./views/Modules.vue') },
        { path: 'agents', component: () => import('./views/Agents.vue') },
        {
          path: 'chat',
          component: () => import('./views/Workspace.vue'),
        },
        { path: 'workspace/:key', component: () => import('./views/Workspace.vue') },
        { path: 'sessions', component: () => import('./views/AllSessions.vue') },
        { path: 'tasks', component: () => import('./views/Tasks.vue') },
        { path: 'settings', component: () => import('./views/Settings.vue') },
      ],
    },
  ],
});

const app = createApp(App);

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(ElementPlus);
app.mount('#app');
