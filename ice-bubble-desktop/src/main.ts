import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'highlight.js/styles/atom-one-dark.css';
import './assets/fonts.css';
import './assets/interactions.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

import App from './App.vue';
import Layout from './views/Layout.vue';
import { initConfig, isSetupDone } from './config';
import { initWorkspaceStore, useWorkspaceStore } from './stores/workspaceStore';

// 检查是否需要进入配置引导（在 initConfig 之后调用）
function needsSetup(): boolean {
  return !isSetupDone();
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
        { path: 'design', component: () => import('./views/Design.vue') },
        { path: 'design/:projectId', component: () => import('./views/Design.vue') },
        { path: 'workspace/:key', component: () => import('./views/Workspace.vue') },
        { path: 'sessions', component: () => import('./views/AllSessions.vue') },
        { path: 'tasks', component: () => import('./views/Tasks.vue') },
        { path: 'settings', component: () => import('./views/Settings.vue') },
        { path: 'logs', component: () => import('./views/Logs.vue') },
        { path: '/:pathMatch(.*)*', component: () => import('./views/NotFound.vue') },
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

// 初始化配置（Tauri Store 或 localStorage），然后挂载应用
initConfig().then(async () => {
  // 初始化 workspace store（必须在 initConfig 之后，确保 Tauri Store 可用）
  const wsState = await initWorkspaceStore();
  const wsStore = useWorkspaceStore();
  wsStore.$patch(wsState);

  app.mount('#app');
});
