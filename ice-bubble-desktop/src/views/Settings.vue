<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { api, type SettingsDTO } from '../api/client';
import { getAdminUrl, setAdminUrl, getAdminAuthToken, setAdminAuthToken } from '../config';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { ElMessage } from 'element-plus';
import { View, Hide } from '@element-plus/icons-vue';

// Desktop 版本（硬编码，从 package.json 构建时注入）
const DESKTOP_VERSION = '1.1.2';

// ====== 客户端配置 ======
const clientForm = reactive({
  adminUrl: '',
  authToken: '',
  showToken: false,
});

// ====== 服务端配置 ======
const serverForm = reactive({
  port: 13000,
  host: 'localhost',
  logLevel: 'info',
  logFormat: 'pretty',
  gatewayUrl: '',
  collectorBaseUrl: '',
  pollInterval: 60,
  batchSize: 500,
  healthDaysToKeep: 30,
  eventDaysToKeep: 90,
  statsDaysToKeep: 365,
  cleanupEnabled: true,
  walMode: true,
  foreignKeys: true,
  corsEnabled: true,
  corsOrigins: '',
});

const adminVersion = ref('');
const loading = ref(false);
const saving = ref(false);

// ====== 表单校验规则 ======
const rules = {
  port: [
    { required: true, message: '请输入端口', trigger: 'blur' },
    { type: 'number', min: 1, max: 65535, message: '端口范围 1-65535', trigger: 'blur' },
  ],
  host: [{ required: true, message: '请输入监听地址', trigger: 'blur' }],
  gatewayUrl: [
    { required: true, message: '请输入 Gateway 地址', trigger: 'blur' },
    { type: 'url', message: '请输入有效的 WebSocket 地址', trigger: 'blur' },
  ],
  collectorBaseUrl: [
    { required: true, message: '请输入 Collector 地址', trigger: 'blur' },
    { type: 'url', message: '请输入有效的 HTTP 地址', trigger: 'blur' },
  ],
  pollInterval: [
    { required: true, message: '请输入同步间隔', trigger: 'blur' },
    { type: 'number', min: 1, message: '最小值为 1', trigger: 'blur' },
  ],
  batchSize: [
    { required: true, message: '请输入批量大小', trigger: 'blur' },
    { type: 'number', min: 1, message: '最小值为 1', trigger: 'blur' },
  ],
  healthDaysToKeep: [
    { required: true, message: '请输入天数', trigger: 'blur' },
    { type: 'number', min: 1, message: '最小值为 1', trigger: 'blur' },
  ],
  eventDaysToKeep: [
    { required: true, message: '请输入天数', trigger: 'blur' },
    { type: 'number', min: 1, message: '最小值为 1', trigger: 'blur' },
  ],
  statsDaysToKeep: [
    { required: true, message: '请输入天数', trigger: 'blur' },
    { type: 'number', min: 1, message: '最小值为 1', trigger: 'blur' },
  ],
};

const formRef = ref();

// ====== 加载数据 ======
async function loadSettings() {
  loading.value = true;
  try {
    // 客户端配置从 localStorage 读取
    clientForm.adminUrl = getAdminUrl();
    clientForm.authToken = getAdminAuthToken();

    // 服务端配置从 API 读取
    const data: SettingsDTO = await api.getSettings();
    adminVersion.value = data.version;

    serverForm.port = data.server?.port ?? 13000;
    serverForm.host = data.server?.host ?? 'localhost';
    serverForm.logLevel = data.logging?.level ?? 'info';
    serverForm.logFormat = data.logging?.format ?? 'pretty';
    serverForm.gatewayUrl = data.gateway?.url ?? '';
    serverForm.collectorBaseUrl = data.dataSync?.collectorBaseUrl ?? '';
    serverForm.pollInterval = (data.dataSync?.pollInterval ?? 60000) / 1000; // 转为秒
    serverForm.batchSize = data.dataSync?.batchSize ?? 500;
    serverForm.healthDaysToKeep = data.cleanup?.healthDaysToKeep ?? 30;
    serverForm.eventDaysToKeep = data.cleanup?.eventDaysToKeep ?? 90;
    serverForm.statsDaysToKeep = data.cleanup?.statsDaysToKeep ?? 365;
    serverForm.cleanupEnabled = data.cleanup?.enabled ?? true;
    serverForm.walMode = data.database?.walMode ?? true;
    serverForm.foreignKeys = data.database?.foreignKeys ?? true;
    serverForm.corsEnabled = data.cors?.enabled ?? true;
    serverForm.corsOrigins = (data.cors?.origins ?? []).join('\n');
  } catch (e: any) {
    ElMessage.error('加载配置失败: ' + (e.message || '未知错误'));
  } finally {
    loading.value = false;
  }
}

// ====== 保存客户端配置 ======
function saveClientConfig() {
  if (clientForm.adminUrl.trim()) {
    setAdminUrl(clientForm.adminUrl.trim());
  }
  if (clientForm.authToken.trim()) {
    setAdminAuthToken(clientForm.authToken.trim());
  }
  ElMessage.success('客户端配置已保存');
}

// ====== 保存服务端配置 ======
async function saveServerConfig() {
  try {
    await formRef.value.validate();
  } catch {
    return;
  }

  saving.value = true;
  try {
    const body: Partial<SettingsDTO> = {
      server: {
        port: serverForm.port,
        host: serverForm.host,
      },
      logging: {
        level: serverForm.logLevel,
        format: serverForm.logFormat,
      },
      gateway: {
        url: serverForm.gatewayUrl,
      },
      dataSync: {
        collectorBaseUrl: serverForm.collectorBaseUrl,
        pollInterval: serverForm.pollInterval * 1000, // 转回毫秒
        batchSize: serverForm.batchSize,
      },
      cleanup: {
        enabled: serverForm.cleanupEnabled,
        healthDaysToKeep: serverForm.healthDaysToKeep,
        eventDaysToKeep: serverForm.eventDaysToKeep,
        statsDaysToKeep: serverForm.statsDaysToKeep,
      },
      database: {
        walMode: serverForm.walMode,
        foreignKeys: serverForm.foreignKeys,
      },
      cors: {
        enabled: serverForm.corsEnabled,
        origins: serverForm.corsOrigins.split('\n').map(s => s.trim()).filter(Boolean),
      },
    };

    const result = await api.updateSettings(body);

    if (result.success) {
      ElMessage.success({
        message: '服务端配置已保存。部分配置需要重启 Admin 服务才生效（端口、监听地址、数据库、日志级别）',
        duration: 5000,
      });
    } else {
      ElMessage.warning('配置未发生变化');
    }
  } catch (e: any) {
    ElMessage.error('保存失败: ' + (e.message || '未知错误'));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  loadSettings();
});
</script>

<template>
  <div class="settings-page" v-loading="loading">
    <PageHeader title="配置" subtitle="查看和编辑 Admin 及客户端配置" />

    <div class="content-wrapper">
      <!-- 卡片1：客户端配置 -->
      <el-card class="settings-card" shadow="never">
        <template #header>
          <span class="card-title">客户端配置</span>
        </template>
        <el-form label-width="120px" label-position="right" class="settings-form">
          <el-form-item label="Admin 地址">
            <el-input v-model="clientForm.adminUrl" placeholder="http://localhost:13000" />
          </el-form-item>
          <el-form-item label="Auth Token">
            <el-input
              v-model="clientForm.authToken"
              :type="clientForm.showToken ? 'text' : 'password'"
              placeholder="Bearer Token"
            >
              <template #suffix>
                <el-icon class="token-toggle" @click="clientForm.showToken = !clientForm.showToken">
                  <View v-if="clientForm.showToken" />
                  <Hide v-else />
                </el-icon>
              </template>
            </el-input>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="saveClientConfig">保存客户端配置</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 卡片2：服务端配置 -->
      <el-card class="settings-card" shadow="never">
        <template #header>
          <span class="card-title">服务端配置</span>
        </template>
        <el-form ref="formRef" :model="serverForm" :rules="rules" label-width="120px" label-position="right" class="settings-form">
          <div class="form-section-title">网络</div>
          <el-form-item label="Admin 端口" prop="port">
            <el-input-number v-model="serverForm.port" :min="1" :max="65535" controls-position="right" />
            <span class="form-hint">修改后需重启服务</span>
          </el-form-item>
          <el-form-item label="监听地址" prop="host">
            <el-input v-model="serverForm.host" placeholder="0.0.0.0" />
            <span class="form-hint">修改后需重启服务</span>
          </el-form-item>
          <el-form-item label="Gateway 地址" prop="gatewayUrl">
            <el-input v-model="serverForm.gatewayUrl" placeholder="ws://127.0.0.1:18789" />
          </el-form-item>

          <div class="form-section-title">日志</div>
          <el-form-item label="日志级别">
            <el-select v-model="serverForm.logLevel">
              <el-option label="debug" value="debug" />
              <el-option label="info" value="info" />
              <el-option label="warn" value="warn" />
              <el-option label="error" value="error" />
            </el-select>
            <span class="form-hint">修改后需重启服务</span>
          </el-form-item>

          <div class="form-section-title">数据同步</div>
          <el-form-item label="Collector 地址" prop="collectorBaseUrl">
            <el-input v-model="serverForm.collectorBaseUrl" placeholder="http://localhost:13100" />
          </el-form-item>
          <el-form-item label="同步间隔" prop="pollInterval">
            <el-input-number v-model="serverForm.pollInterval" :min="1" :step="10" controls-position="right" />
            <span class="form-hint">秒</span>
          </el-form-item>
          <el-form-item label="同步批量" prop="batchSize">
            <el-input-number v-model="serverForm.batchSize" :min="1" :step="100" controls-position="right" />
          </el-form-item>

          <div class="form-section-title">数据归档</div>
          <el-form-item label="归档清理">
            <el-switch v-model="serverForm.cleanupEnabled" />
          </el-form-item>
          <el-form-item label="归档天数" prop="healthDaysToKeep">
            <el-input-number v-model="serverForm.healthDaysToKeep" :min="1" controls-position="right" />
            <span class="form-hint">健康数据保留天数</span>
          </el-form-item>
          <el-form-item label="事件天数" prop="eventDaysToKeep">
            <el-input-number v-model="serverForm.eventDaysToKeep" :min="1" controls-position="right" />
            <span class="form-hint">事件数据保留天数</span>
          </el-form-item>
          <el-form-item label="统计天数" prop="statsDaysToKeep">
            <el-input-number v-model="serverForm.statsDaysToKeep" :min="1" controls-position="right" />
            <span class="form-hint">统计数据保留天数</span>
          </el-form-item>

          <div class="form-section-title">数据库</div>
          <el-form-item label="WAL 模式">
            <el-switch v-model="serverForm.walMode" />
            <span class="form-hint">修改后需重启服务</span>
          </el-form-item>
          <el-form-item label="外键约束">
            <el-switch v-model="serverForm.foreignKeys" />
            <span class="form-hint">修改后需重启服务</span>
          </el-form-item>

          <div class="form-section-title">CORS</div>
          <el-form-item label="启用 CORS">
            <el-switch v-model="serverForm.corsEnabled" />
          </el-form-item>
          <el-form-item label="允许来源">
            <el-input
              v-model="serverForm.corsOrigins"
              type="textarea"
              :rows="3"
              placeholder="每行一个来源地址"
            />
          </el-form-item>

          <el-form-item class="save-row">
            <el-button type="primary" :loading="saving" @click="saveServerConfig">
              保存服务端配置
            </el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 卡片3：关于 -->
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
            <span class="about-label">Desktop 版本</span>
            <span class="about-value">{{ DESKTOP_VERSION }}</span>
          </div>
          <div class="about-row">
            <span class="about-label">Admin 版本</span>
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

.form-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 20px 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.form-section-title:first-child {
  margin-top: 0;
}

.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
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

.save-row {
  margin-top: 20px;
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
