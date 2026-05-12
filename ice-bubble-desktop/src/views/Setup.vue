<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { setAdminUrl, setAdminAuthToken, getAdminUrl, getAdminAuthToken, setSetupComplete } from '../config';
import { request } from '../api/client';

const router = useRouter();

const adminUrl = ref('');
const authToken = ref('');
const testing = ref(false);
const errorMsg = ref('');
const needsToken = ref(false);

// 检测当前配置
onMounted(() => {
  adminUrl.value = getAdminUrl();
  authToken.value = getAdminAuthToken();
});

async function testConnection() {
  if (!adminUrl.value.trim()) {
    errorMsg.value = '请输入 Admin 地址';
    return;
  }

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
  needsToken.value = false;

  try {
    const baseUrl = url.replace(/\/+$/, '');
    // Step 1: check auth status
    let statusRes: Response;
    try {
      statusRes = await request(`${baseUrl}/api/auth/status`);
    } catch {
      errorMsg.value = '无法连接到 Admin 服务';
      return;
    }

    if (!statusRes.ok) {
      errorMsg.value = `连接失败: HTTP ${statusRes.status}`;
      return;
    }

    // Step 2: if token provided, verify it before accessing protected endpoints
    if (authToken.value.trim()) {
      const verifyRes = await request(`${baseUrl}/api/auth/verify`, { method: 'POST' });
      if (!verifyRes.ok) {
        needsToken.value = true;
        errorMsg.value = 'Token 不正确，请检查';
        return;
      }
    }

    // Step 3: test with a protected endpoint
    const res = await request(`${baseUrl}/api/stats`);

    if (res.status === 401) {
      needsToken.value = true;
      errorMsg.value = '需要认证，请输入 Token';
      return;
    }

    if (!res.ok) {
      errorMsg.value = `连接失败: HTTP ${res.status}`;
      return;
    }

    // 连接成功，保存配置
    setAdminUrl(url);
    setAdminAuthToken(authToken.value.trim());
    ElMessage.success('连接成功！');
    router.replace('/');
  } catch (e: any) {
    errorMsg.value = `请求失败: ${e.message}`;
  } finally {
    testing.value = false;
  }
}

function handleSkip() {
  // 标记已完成 Setup，避免守卫循环跳转
  setSetupComplete();
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
          请输入 Admin 管理后台的地址，以便 Desktop 直连后端服务。
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

          <el-form-item label="Auth Token">
            <el-input
              v-model="authToken"
              placeholder="输入 Admin 认证 Token（可选）"
              size="large"
              type="password"
              show-password
              clearable
              @keydown.enter="testConnection"
            >
              <template #prefix>
                <span style="color: var(--el-text-color-placeholder);">🔑</span>
              </template>
            </el-input>
            <div v-if="needsToken" style="color: var(--el-color-danger); font-size: 12px; margin-top: 4px;">
              ⚠️ 此服务端需要认证，请输入 Token
            </div>
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
        <p>配置保存在浏览器本地，可随时通过连接状态组件重新配置</p>
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
</style>
