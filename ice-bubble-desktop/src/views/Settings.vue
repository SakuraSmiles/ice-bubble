<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { APP_VERSION } from '../version';
import { api, request } from '../api/client';
import { getAdminUrl, setAdminUrl, getAdminAuthToken, setAdminAuthToken } from '../config';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { ElMessage } from 'element-plus';
import { View, Hide } from '@element-plus/icons-vue';

// ====== 客户端配置 ======
const adminUrl = ref('');
const authToken = ref('');
const showToken = ref(false);

// ====== 关于 ======
const adminVersion = ref('');
const loading = ref(false);
const testing = ref(false);

// ====== 加载 ======
async function loadSettings() {
  loading.value = true;
  try {
    adminUrl.value = getAdminUrl();
    authToken.value = getAdminAuthToken();

    const data = await api.getSettings();
    adminVersion.value = data.version || '';
  } catch {
    // API 不可用时仅展示本地配置
  } finally {
    loading.value = false;
  }
}

// ====== 测试连接 ======
async function testConnection(): Promise<boolean> {
  const token = authToken.value.trim();
  const url = adminUrl.value.trim().replace(/\/+$/, '');

  if (!url) {
    ElMessage.warning('请填写 Admin 地址');
    return false;
  }

  // 先把新 token 写入配置缓存，后续 request() 才能拿到最新值
  await setAdminAuthToken(token);

  testing.value = true;
  try {
    // 始终使用用户输入的 URL 进行测试（不区分 dev/prod）
    const baseUrl = `${url}/api`;

    // Step 1: verify token if provided
    if (token) {
      const verifyRes = await request(`${baseUrl}/auth/verify`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (!verifyRes.ok) {
        ElMessage.error('连接失败：Token 不正确');
        return false;
      }
    }

    // Step 2: test a protected endpoint
    const res = await request(`${baseUrl}/settings`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      adminVersion.value = data.version || '';
      ElMessage.success('连接成功');
      return true;
    } else if (res.status === 401) {
      ElMessage.error('连接失败：需要认证，请填写 Token');
      return false;
    } else {
      ElMessage.error(`连接失败：HTTP ${res.status}`);
      return false;
    }
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_CONNECTION')) {
      ElMessage.error('连接失败：无法访问 Admin 服务（请检查地址是否正确、服务是否运行）');
    } else if (msg.includes('TimeoutError') || msg.includes('timeout') || msg.includes('The operation was aborted')) {
      ElMessage.error('连接失败：连接超时（5 秒无响应）');
    } else {
      ElMessage.error('连接失败：' + msg);
    }
    return false;
  } finally {
    testing.value = false;
  }
}

// ====== 保存 ======
async function saveConfig() {
  const url = adminUrl.value.trim();
  const token = authToken.value.trim();

  if (!url) {
    ElMessage.warning('请填写 Admin 地址');
    return;
  }

  // 先测试连接
  const ok = await testConnection();
  if (!ok) return;

  // 连接成功，保存配置
  setAdminUrl(url);
  setAdminAuthToken(token);

  ElMessage.success('配置已保存');
}

onMounted(() => {
  loadSettings();
});
</script>

<template>
  <div class="settings-page" v-loading="loading">
    <PageHeader title="配置" subtitle="Desktop 客户端连接设置" />

    <div class="content-wrapper">
      <!-- 客户端配置 -->
      <el-card class="settings-card" shadow="never">
        <template #header>
          <span class="card-title">连接配置</span>
        </template>
        <el-form label-width="120px" label-position="right" class="settings-form">
          <el-form-item label="Admin 地址">
            <el-input v-model="adminUrl" placeholder="http://localhost:13000" />
            <div class="form-hint">Admin 后端地址，含端口号</div>
          </el-form-item>
          <el-form-item label="Auth Token">
            <el-input
              v-model="authToken"
              :type="showToken ? 'text' : 'password'"
              placeholder="Bearer Token"
            >
              <template #suffix>
                <el-icon class="token-toggle" @click="showToken = !showToken">
                  <View v-if="showToken" />
                  <Hide v-else />
                </el-icon>
              </template>
            </el-input>
            <div class="form-hint">Admin 后端认证令牌</div>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="testing" @click="saveConfig">保存</el-button>
            <el-button :loading="testing" @click="testConnection">测试连接</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 关于 -->
      <el-card class="settings-card" shadow="never">
        <template #header>
          <span class="card-title">关于</span>
        </template>
        <div class="about-content">
          <div class="about-row">
            <span class="about-label">项目</span>
            <span class="about-value">IceBubble</span>
          </div>
          <div class="about-row">
            <span class="about-label">Desktop</span>
            <span class="about-value">{{ APP_VERSION }}</span>
          </div>
          <div class="about-row">
            <span class="about-label">Admin</span>
            <span class="about-value">{{ adminVersion || '-' }}</span>
          </div>
        </div>
      </el-card>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
.settings-page {
  width: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  overflow: hidden;
}

.content-wrapper {
  flex: 1;
  min-height: 0;
  padding: 0 24px 8px;
  overflow-y: auto;
}

.settings-card {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 16px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
}

.settings-card :deep(.el-card__header) {
  padding: 12px 20px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.settings-card :deep(.el-card__body) {
  padding: 20px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.settings-form {
  max-width: 560px;
  margin: 0 auto;
}

.form-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin-top: 4px;
}

.token-toggle {
  cursor: pointer;
  user-select: none;
  font-size: 16px;
  color: var(--color-text-tertiary);
  transition: color 0.2s;
}

.token-toggle:hover {
  color: var(--color-text-primary);
}

.about-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 560px;
  margin: 0 auto;
}

.about-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  padding: 4px 0;
}

.about-label {
  color: var(--color-text-secondary);
}

.about-value {
  color: var(--color-text);
  font-family: var(--font-exo2);
}
</style>
