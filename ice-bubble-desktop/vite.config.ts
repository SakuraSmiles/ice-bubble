import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 1420,
    proxy: {
      '/api': {
        target: 'http://localhost:14000',
        changeOrigin: true
      }
    }
  }
});
