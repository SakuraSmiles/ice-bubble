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
import type { SessionDTO } from './api/client';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: Layout,
      children: [
        { path: '', component: () => import('./views/Overview.vue') },
        { path: 'modules', component: () => import('./views/Modules.vue') },
        { path: 'agents', component: () => import('./views/Agents.vue') },
        {
          path: 'chat',
          component: () => import('./views/Workspace.vue'),
          beforeEnter: async () => {
            // 动态查找 main agent 的 direct session 并重定向
            const { api } = await import('./api/client');
            try {
              const data = await api.getUnifiedSessions({});
              const sessions: SessionDTO[] = data.sessions || [];
              const mainDirect = sessions
                .filter(s => s.agent_id === 'main' && s.session_key.includes(':direct:'))
                .sort((a, b) => {
                  const ta = new Date(a.updated_at || a.last_message_at || a.created_at || 0).getTime();
                  const tb = new Date(b.updated_at || b.last_message_at || b.created_at || 0).getTime();
                  return tb - ta;
                })[0];
              if (mainDirect) {
                return { path: `/workspace/${encodeURIComponent(mainDirect.session_key)}` };
              }
            } catch { /* ignore */ }
            // 找不到则回退到全部会话
            return { path: '/sessions' };
          },
        },
        { path: 'workspace/:key', component: () => import('./views/Workspace.vue') },
        { path: 'sessions', component: () => import('./views/AllSessions.vue') },
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
