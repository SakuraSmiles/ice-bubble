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
// 如果 Admin 未配置（url 仍为 localhost 或 authToken 为空），则跳转到 /setup
async function needsSetup(): Promise<boolean> {
  try {
    const res = await fetch('/api/desktop/config');
    if (res.ok) {
      const data = await res.json();
      // 未配置：没有 adminUrl 或仍是默认 localhost
      if (!data.adminUrl || data.adminUrl.includes('localhost')) {
        return true;
      }
      return false;
    }
    // API 不可用（可能 server 未启动），允许进入
    return false;
  } catch {
    return false;
  }
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
      beforeEnter: async (_to, _from, next) => {
        const setup = await needsSetup();
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
