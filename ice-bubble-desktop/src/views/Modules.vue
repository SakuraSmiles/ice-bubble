<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

import { Refresh, Plus, Delete, InfoFilled, VideoPlay, VideoPause } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { ElMessage, ElMessageBox } from 'element-plus';

interface ModuleStatus {
  state: 'running' | 'stopped' | 'error' | null;
  lastPollTime?: string;
  lastError?: string;
}

interface Module {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval: number;
  status: ModuleStatus;
  version?: string;
  registeredAt?: string;
  runtimeStartTime?: string;
}

const modules = ref<Module[]>([]);
const loading = ref(false);
// 卡片级别的 loading 状态
const cardLoading = ref<Record<string, boolean>>({});
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_INTERVAL = 10000; // 30秒刷新一次，10秒刷新
const error = ref('');

// 弹窗相关
const dialogVisible = ref(false);
const dialogLoading = ref(false);
const testingConnection = ref(false);
const testPass = ref(false);
const formRef = ref();
const formData = ref({
  baseUrl: '',
  moduleKey: '',
  name: '',
  enabled: true,
  pollInterval: 10000,
});
const editingModule = ref<Module | null>(null);

// 表单校验规则
const rules = {
  name: [
    { required: true, message: '请输入模块名称', trigger: 'blur' },
    { min: 2, max: 50, message: '名称长度为 2-50 个字符', trigger: 'blur' },
  ],
  baseUrl: [
    { required: true, message: '请输入模块地址', trigger: 'blur' },
    {
      validator: (_rule: any, value: string, callback: any) => {
        try {
          const url = new URL(value);
          if (!['http:', 'https:'].includes(url.protocol)) {
            callback(new Error('格式：http://localhost:13000 或 http://127.0.0.1:端口'));
            return;
          }
          const host = url.hostname;
          // 支持 localhost 或 4段IP
          const isLocalhost = host === 'localhost';
          const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
          if (!isLocalhost && !isIp) {
            callback(new Error('格式：http://localhost:13000 或 http://127.0.0.1:端口'));
            return;
          }
          // IP 每段 0-255
          if (isIp) {
            const parts = host.split('.').map(Number);
            if (parts.some(p => p > 255)) {
              callback(new Error('格式：http://localhost:13000 或 http://127.0.0.1:端口'));
              return;
            }
          }
          // 端口
          const port = parseInt(url.port, 10);
          if (!port || port < 1 || port > 65535) {
            callback(new Error('格式：http://localhost:13000 或 http://127.0.0.1:端口'));
            return;
          }
          callback();
        } catch {
          callback(new Error('格式：http://localhost:13000 或 http://127.0.0.1:端口'));
        }
      },
      trigger: 'blur',
    },
  ],
  pollInterval: [
    { required: true, message: '请输入轮询间隔', trigger: 'blur' },
    {
      validator: (_rule: any, value: number, callback: any) => {
        if (!Number.isInteger(value) || value <= 0) {
          callback(new Error('轮询间隔必须为正整数'));
        } else {
          callback();
        }
      },
      trigger: 'blur',
    },
  ],
};

async function fetchModules(showLoading = true) {
  if (showLoading) loading.value = true;
  error.value = '';
  try {
    // 模拟网络延迟，确保 loading 至少显示 0.8 秒
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const listRes = await fetch('/api/modules');
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
    const listData = await listRes.json();

    // API 已返回完整数据（包括状态），直接使用
    modules.value = listData.modules.map((m: any) => ({
      moduleKey: m.moduleKey,
      name: m.name,
      baseUrl: m.baseUrl,
      enabled: m.enabled,
      pollInterval: m.pollInterval,
      registeredTime: m.registeredTime,
      version: m.version || '-',
      status: m.status || { state: null, lastPollTime: null, lastError: null },
      registeredAt: m.registeredTime
        ? new Date(m.registeredTime).toLocaleString('zh-CN')
        : '-',
      runtimeStartTime: m.status?.runtime?.startTime
        ? new Date(m.status.runtime.startTime).toLocaleString('zh-CN')
        : '-',
    }));
  } catch (e: any) {
    error.value = e.message || '获取模块列表失败';
  } finally {
    loading.value = false;
  }
}

// 完整状态判断（配置状态 enabled + 运行时状态 state 综合计算）
function getDisplayStatus(mod: Module): { label: string; type: string } {
  // 1. 禁用状态
  if (!mod.enabled) return { label: '已停止', type: 'info' };

  // 2. 根据运行时状态
  const state = mod.status?.state;
  switch (state) {
    case 'running': return { label: '运行中', type: 'success' };
    case 'error': return { label: '异常', type: 'danger' };
    case 'stopped': return { label: '已停止', type: 'warning' };
    default: return { label: '运行中', type: 'success' }; // 默认为运行中
  }
}

function getLastError(mod: Module): string | null {
  return mod.status?.lastError || null;
}

function getLastPollTime(mod: Module): string | null {
  if (!mod.status?.lastPollTime) return null;
  return new Date(mod.status.lastPollTime).toLocaleString('zh-CN');
}

// 判断是否为 admin 模块
function isAdminModule(): boolean {
  return editingModule.value?.moduleKey === 'admin';
}

// 打开新增弹窗
function openAddDialog() {
  editingModule.value = null;
  formData.value = {
    baseUrl: '',
    moduleKey: '',
    name: '',
    enabled: true,
    pollInterval: 10000,
  };
  testPass.value = false;
  formRef.value?.resetFields();
  dialogVisible.value = true;
}

// 打开编辑弹窗
function openEditDialog(mod: Module) {
  editingModule.value = mod;
  formData.value = {
    baseUrl: mod.baseUrl,
    moduleKey: mod.moduleKey,
    name: mod.name,
    enabled: mod.enabled,
    pollInterval: mod.pollInterval,
  };
  testPass.value = false;
  formRef.value?.resetFields();
  dialogVisible.value = true;
}

// 测试连接
async function testConnection() {
  try {
    await formRef.value.validateField('baseUrl');
  } catch {
    return;
  }

  testingConnection.value = true;
  try {
    // 通过 admin API 测试连接（统一处理跨域）
    const res = await fetch('/api/modules/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: formData.value.baseUrl })
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`该地址未提供 /api/meta/status 接口，可能是非 Collector 模块或地址错误`);
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.moduleKey) {
      formData.value.moduleKey = data.moduleKey;
      testPass.value = true;
      ElMessage.success('连接成功，已自动获取模块Key');
    } else {
      ElMessage.warning('连接成功，但未获取到模块信息');
    }
  } catch (e: any) {
    testPass.value = false;
    ElMessage.error('连接失败: ' + (e.message || '网络错误'));
  } finally {
    testingConnection.value = false;
  }
}

// 保存模块
async function saveModule() {
  try {
    await formRef.value.validate();
  } catch {
    return;
  }

  // 必须先测试连接获取 moduleKey
  if (!formData.value.moduleKey) {
    ElMessage.warning('请先点击"测试连接"验证模块');
    return;
  }

  dialogLoading.value = true;
  try {
    const baseUrl = formData.value.baseUrl.trim().replace(/\/$/, '');
    const body = {
      moduleKey: formData.value.moduleKey.trim(),
      name: formData.value.name,
      baseUrl,
      enabled: formData.value.enabled,
      pollInterval: formData.value.pollInterval,
    };

    const isEdit = !!editingModule.value;
    const url = isEdit && editingModule.value ? '/api/modules/' + editingModule.value.moduleKey : '/api/modules';
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    ElMessage.success(isEdit ? '模块更新成功' : '模块添加成功');
    dialogVisible.value = false;
    fetchModules();
  } catch (e: any) {
    ElMessage.error('保存失败: ' + (e.message || '未知错误'));
  } finally {
    dialogLoading.value = false;
  }
}

// 删除模块
async function deleteModule(mod: Module) {
  try {
      await ElMessageBox.confirm(
        `确定要删除模块「${mod.name}」吗？`,
        '删除确认',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
      );
    } catch { return; }

  try {
    const res = await fetch(`/api/modules/${mod.moduleKey}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success('模块已删除');
    fetchModules();
  } catch (e: any) {
    ElMessage.error('删除失败: ' + (e.message || '未知错误'));
  }
}

async function toggleModule(mod: Module) {
  // 卡片级别 loading 检查
  if (cardLoading.value[mod.moduleKey]) return;
  cardLoading.value[mod.moduleKey] = true;
  try {
    // 立即更新本地状态，按钮立即变化
    const newEnabled = !mod.enabled;
    mod.enabled = newEnabled;
    
    const res = await fetch(`/api/modules/${mod.moduleKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled })
    });
    if (!res.ok) {
      // 回滚状态
      mod.enabled = !newEnabled;
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success(newEnabled ? '模块已启用' : '模块已停用');
    // 后台静默刷新，不显示 loading
    fetchModules(false);
  } catch (e: any) {
    ElMessage.error('操作失败: ' + (e.message || '未知错误'));
  } finally {
    cardLoading.value[mod.moduleKey] = false;
  }
}

async function testModuleConnection(mod: Module) {
  if (testingConnection.value) return;
  testingConnection.value = true;
  try {
    const res = await fetch('/api/modules/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: mod.baseUrl })
    });
    const data = await res.json();
    
    if (data.success) {
      ElMessage.success('连接成功');
    } else {
      ElMessage.error(data.error || '连接失败');
    }
  } catch (e: any) {
    ElMessage.error('连接测试失败: ' + (e.message || '未知错误'));
  } finally {
    testingConnection.value = false;
  }
}

onMounted(() => {
  fetchModules();
  // 启动定时刷新
  refreshTimer = setInterval(() => fetchModules(false), REFRESH_INTERVAL);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <div class="modules-page">
    <PageHeader title="模块管理" subtitle="配置和管理模块信息">
      <el-button :disabled="loading" circle @click="fetchModules(true)">
        <el-icon><Refresh /></el-icon>
      </el-button>
      <el-button type="primary" circle @click="openAddDialog">
        <el-icon><Plus /></el-icon>
      </el-button>
    </PageHeader>

    <el-card class="content-area" v-loading="loading">
      <div v-if="error" class="error-msg">{{ error }}</div>
      <div v-if="!loading && modules.length === 0" class="empty-msg">暂无模块</div>
      <div v-if="!loading && modules.length > 0" class="cards-grid">
        <el-card
          v-for="mod in modules"
          :key="mod.moduleKey"
          class="module-card"
        >
          <div class="card-header">
            <div class="module-title-row">
              <div class="module-title">
                <h2 class="module-name">{{ mod.name }}</h2>
                <span class="module-key">{{ mod.moduleKey }} @ {{ mod.version || '-' }}</span>
              </div>
              <el-button
                v-if="mod.moduleKey !== 'admin'"
                link
                class="delete-btn"
                @click.stop="deleteModule(mod)"
                @mouseenter="$event.target.style.color = 'var(--color-accent-red)'"
                @mouseleave="$event.target.style.color = 'var(--color-text-secondary)'"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <div class="card-actions">
              <el-tag
              :type="getDisplayStatus(mod).type"
              size="small"
            >
              {{ getDisplayStatus(mod).label }}
            </el-tag>
            </div>
          </div>
          <div class="card-body">
            <div class="info-rows" @click="openEditDialog(mod)">
            <div class="info-row">
              <span class="info-label">注册时间</span>
              <span class="info-value">{{ mod.registeredAt || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">启动时间</span>
              <span class="info-value">{{ mod.runtimeStartTime || '-' }}</span>
            </div>
            <div class="info-row" v-if="getLastPollTime(mod)">
              <span class="info-label">最后轮询</span>
              <span class="info-value time-value">{{ getLastPollTime(mod) }}</span>
            </div>
            <div class="info-row error-row" v-if="getLastError(mod)">
              <span class="info-label">错误</span>
              <span class="info-value error-text">{{ getLastError(mod) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">地址</span>
              <span class="info-value url">{{ mod.baseUrl }}</span>
            </div>
            </div>
            
            <!-- 卡片底部操作按钮 -->
            <div class="card-actions-bottom">
              <el-button
                v-if="mod.moduleKey !== 'admin'"
                class="action-btn"
                :loading="testingConnection"
                :disabled="testingConnection"
                @click.stop="testModuleConnection(mod)"
              >
                测试连接
              </el-button>
              <el-button
                v-if="mod.moduleKey !== 'admin'"
                :type="mod.enabled ? 'warning' : 'success'"
                class="action-btn"
                :loading="cardLoading[mod.moduleKey]"
                :disabled="cardLoading[mod.moduleKey]"
                @click.stop="toggleModule(mod)"
              >
                <el-icon><VideoPlay v-if="!mod.enabled" /><VideoPause v-else /></el-icon>
                <span class="btn-text">{{ mod.enabled ? '停用' : '启用' }}</span>
              </el-button>
            </div>
          </div>
        </el-card>
      </div>
    </el-card>

    <AppFooter />

    <!-- 新增/编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingModule ? '编辑模块' : '新增模块'"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="formData" :rules="rules" label-width="80px" status-icon inline-message>
        <el-form-item label="地址" prop="baseUrl">
          <el-input
            v-model="formData.baseUrl"
            placeholder="http://localhost:13100"
          />
        </el-form-item>
        <el-form-item label="Key">
          <el-input v-model="formData.moduleKey" placeholder="自动获取" disabled />
        </el-form-item>
        <el-form-item label="名字" prop="name">
          <el-input v-model="formData.name" placeholder="请输入模块名称" />
        </el-form-item>
        <el-form-item label="轮询间隔" prop="pollInterval">
          <el-input-number
            v-model="formData.pollInterval"
            :min="5000"
            :step="5000"
            controls-position="right"
          />
          <span class="form-tip">毫秒，最小 5000ms</span>
        </el-form-item>
        </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button :loading="testingConnection" @click="testConnection">
          测试连接
        </el-button>
        <el-button
          :type="testPass ? 'primary' : 'default'"
          :loading="dialogLoading"
          :disabled="!testPass"
          @click="saveModule"
        >
          保存
        </el-button>
      </template>
      <div class="dialog-tip">
            <el-icon><InfoFilled /></el-icon>
            <span>保存前请先测试连接</span>
          </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.modules-page {
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 32px;
  box-sizing: border-box;
  min-height: calc(100vh - 1px);
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.card-actions-bottom {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.card-actions-bottom .action-btn {
  flex: 1;
  width: 0;
}


.card-actions-bottom .btn-text {
  margin-left: 4px;
  font-weight: 500;
}

.page-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.content-area {
  flex: 1;
  margin-bottom: 20px;
}

.cards-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.module-card {
  width: 360px;
  cursor: pointer;
}
.module-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 20px;
}

.card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.module-title {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.module-name {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.3;
}

.module-key {
  font-size: 13px;
  color: var(--color-text-secondary);
  font-family: monospace;
  opacity: 0.8;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  line-height: 1.6;
  min-height: 24px;
}

.info-label {
  color: var(--color-text-secondary);
  font-weight: 400;
  flex-shrink: 0;
  width: 80px; /* Fixed width for labels */
}

.info-value {
  color: var(--color-text);
  font-weight: 500;
  text-align: right;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-value.url {
  font-size: 12px;
  color: var(--color-accent-blue);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
  opacity: 0.9;
}

/* Time values - ensure consistent width */
.info-value.time-value {
  font-family: monospace;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.error-row .info-value.error-text {
  color: var(--color-accent-red);
  font-size: 12px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-msg {
  background: #ffebe9;
  border: 1px solid #cf222e40;
  color: var(--color-accent-red);
  padding: 12px 16px;
  border-radius: var(--radius);
  margin-bottom: 20px;
  font-size: 14px;
}

.loading-msg,
.empty-msg {
  color: #888;
  font-size: 14px;
  text-align: center;
  padding: 48px 0;
}

.copyright {
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 20px 0;
  margin-top: auto;
}

.dialog-tip {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  font-size: 12px;
  color: var(--el-color-warning-light-3);
  font-weight: 500;
  margin-top: -8px;
  padding-bottom: 4px;
}
</style>
<style>
.form-tip { margin-left: 8px; color: var(--color-text-secondary); font-size: 12px; }
</style>
