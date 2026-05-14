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

// 自动探测 localhost:13000
async function autoDetect() {
  if (adminUrl.value.trim()) return;
  const defaultUrl = 'http://localhost:13000';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${defaultUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      adminUrl.value = defaultUrl;
    }
  } catch {
    // 静默失败
  }
}

// 检测当前配置
onMounted(async () => {
  adminUrl.value = getAdminUrl();
  authToken.value = getAdminAuthToken();
  autoDetect();
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

    // Step 2: if token provided, save to config first so request() can read it
    if (authToken.value.trim()) {
      await setAdminAuthToken(authToken.value.trim());
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

    // 连接成功，保存 URL（token 已在 verify 前保存）
    setAdminUrl(url);
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
        <h1>IceBubble Desktop</h1>
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
              clearable
              @keydown.enter="testConnection"
            />
          </el-form-item>

          <el-form-item>
            <template #label>
              <span class="form-label">
                Auth Token
                <el-tooltip content="用于连接 Admin 认证" placement="top">
                  <el-icon class="label-tooltip-icon"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896zm0 192a58.432 58.432 0 0 0-58.24 63.744l23.36 256.384a35.072 35.072 0 0 0 69.76 0l23.296-256.384A58.432 58.432 0 0 0 512 256zm0 512a51.2 51.2 0 1 0 0-102.4 51.2 51.2 0 0 0 0 102.4z"/></svg></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input
              v-model="authToken"
              placeholder="输入 Admin 认证 Token（可选）"
              type="password"
              show-password
              clearable
              @keydown.enter="testConnection"
            />
          </el-form-item>

          <el-alert
            v-if="needsToken && !errorMsg"
            title="此服务端需要认证，请输入 Token"
            type="warning"
            show-icon
            :closable="false"
            class="setup-alert"
          />

          <el-alert
            v-if="errorMsg"
            :title="errorMsg"
            type="error"
            show-icon
            :closable="false"
            class="setup-alert"
          />

          <div class="setup-actions">
            <el-button
              type="primary"
              :loading="testing"
              @click="testConnection"
              style="width: 100%;"
            >
              {{ testing ? '正在测试连接...' : '测试连接并保存' }}
            </el-button>
            <el-button
              class="skip-btn"
              text
              @click="handleSkip"
            >
              跳过，稍后配置
            </el-button>
          </div>
        </el-form>
      </div>

      <div class="setup-footer">
        <p>配置保存在本地应用数据目录，可随时在设置中修改</p>
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
  background: #f6f8fa;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
}

.setup-card {
  background: #ffffff;
  border-radius: 6px;
  border: 1px solid #e1e4e8;
  box-shadow: 0 1px 3px rgba(31, 35, 40, 0.04), 0 1px 2px rgba(31, 35, 40, 0.06);
  padding: 32px;
  width: 440px;
  max-width: 90vw;
}

.setup-header {
  text-align: center;
  margin-bottom: 24px;
}

.setup-header h1 {
  font-size: 22px;
  font-weight: 600;
  color: #1f2328;
  margin: 0 0 6px 0;
  letter-spacing: -0.01em;
}

.subtitle {
  color: #656d76;
  font-size: 14px;
  margin: 0;
}

.setup-body {
  margin-bottom: 20px;
}

.description {
  color: #656d76;
  font-size: 13px;
  line-height: 1.6;
  margin: 0 0 24px 0;
}

.form-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #656d76;
}

.label-tooltip-icon {
  font-size: 14px;
  color: #8c959f;
  cursor: help;
}

:deep(.el-form-item__label) {
  font-size: 13px;
  color: #656d76;
  padding-bottom: 4px !important;
}

:deep(.el-input__wrapper) {
  border-radius: 6px;
}

.setup-alert {
  margin-bottom: 16px;
}

:deep(.setup-alert .el-alert) {
  border-radius: 6px;
}

.setup-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 20px;
}

.setup-actions .el-button--primary {
  height: 36px;
  font-size: 14px;
  border-radius: 6px;
}

.skip-btn {
  margin-top: 12px !important;
  color: #8c959f !important;
  font-size: 13px;
}

.skip-btn:hover {
  color: #656d76 !important;
}

.setup-footer {
  text-align: center;
  border-top: 1px solid #e1e4e8;
  padding-top: 16px;
}

.setup-footer p {
  color: #8c959f;
  font-size: 11px;
  margin: 0;
}
</style>
