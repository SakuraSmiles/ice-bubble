<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

const router = useRouter();

const adminUrl = ref('');
const testing = ref(false);
const errorMsg = ref('');

// 检测当前配置
onMounted(async () => {
  try {
    const res = await fetch('/api/desktop/config');
    if (res.ok) {
      const data = await res.json();
      if (data.adminUrl) {
        adminUrl.value = data.adminUrl;
      }
    }
  } catch {
    // 配置读取失败，使用空值
  }
});

async function testConnection() {
  if (!adminUrl.value.trim()) {
    errorMsg.value = '请输入 Admin 地址';
    return;
  }

  // 简单的 URL 格式校验
  let url = adminUrl.value.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
    adminUrl.value = url;
  }

  try {
    new URL(url);
  } catch {
    errorMsg.value = 'URL 格式不正确';
    return;
  }

  testing.value = true;
  errorMsg.value = '';

  try {
    const res = await fetch('/api/desktop/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      ElMessage.success('连接成功！');
      // 保存成功，跳转到首页
      router.replace('/');
    } else {
      errorMsg.value = data.error || '连接失败';
    }
  } catch (e: any) {
    errorMsg.value = `请求失败: ${e.message}`;
  } finally {
    testing.value = false;
  }
}

function handleSkip() {
  router.replace('/');
}
</script>

<template>
  <div class="setup-container">
    <div class="setup-card">
      <div class="setup-header">
        <h1>🫧 IceBubble Desktop</h1>
        <p class="subtitle">首次配置向导</p>
      </div>

      <div class="setup-body">
        <p class="description">
          请输入 Admin 管理后台的地址，以便 Desktop 连接到后端服务。
        </p>

        <el-form label-position="top" @submit.prevent="testConnection">
          <el-form-item label="Admin 地址">
            <el-input
              v-model="adminUrl"
              placeholder="例如: http://192.168.1.100:13000"
              size="large"
              clearable
              @keydown.enter="testConnection"
            >
              <template #prefix>
                <span style="color: var(--el-text-color-placeholder);">🔗</span>
              </template>
            </el-input>
          </el-form-item>

          <el-alert
            v-if="errorMsg"
            :title="errorMsg"
            type="error"
            show-icon
            :closable="false"
            style="margin-bottom: 16px;"
          />

          <div class="setup-actions">
            <el-button
              type="primary"
              size="large"
              :loading="testing"
              @click="testConnection"
              style="width: 100%;"
            >
              {{ testing ? '正在测试连接...' : '测试连接并保存' }}
            </el-button>
            <el-button
              size="small"
              text
              @click="handleSkip"
              style="margin-top: 8px;"
            >
              跳过，稍后配置
            </el-button>
          </div>
        </el-form>
      </div>

      <div class="setup-footer">
        <p>配置文件保存在 <code>config/modules.json</code>，可随时手动修改</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.setup-card {
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  padding: 48px;
  width: 460px;
  max-width: 90vw;
}

.setup-header {
  text-align: center;
  margin-bottom: 32px;
}

.setup-header h1 {
  font-size: 28px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 8px;
}

.subtitle {
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.setup-body {
  margin-bottom: 24px;
}

.description {
  color: var(--el-text-color-regular);
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 24px;
}

.setup-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.setup-footer {
  text-align: center;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 16px;
}

.setup-footer p {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}

.setup-footer code {
  background: var(--el-fill-color);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}
</style>
