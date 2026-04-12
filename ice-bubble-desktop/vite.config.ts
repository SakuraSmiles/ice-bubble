import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 1420,
    proxy: {
      '/api/resources': {
        target: 'http://localhost:13000',
        changeOrigin: true
      },
      '/api': {
        target: 'http://localhost:14000',
        changeOrigin: true
      }
    }
  }
});
