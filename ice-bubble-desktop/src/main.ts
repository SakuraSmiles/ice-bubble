import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

import App from './App.vue';
import Layout from './views/Layout.vue';
import Overview from './views/Overview.vue';
import Modules from './views/Modules.vue';
import Sessions from './views/Sessions.vue';
import Agents from './views/Agents.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: Layout,
      children: [
        { path: '', component: Overview },
        { path: 'modules', component: Modules },
        { path: 'sessions', component: Sessions },
        { path: 'agents', component: Agents },
      ],
    },
  ],
});

const app = createApp(App);

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(router);
app.use(ElementPlus);
app.mount('#app');
