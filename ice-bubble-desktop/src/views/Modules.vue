<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

import { Refresh, Plus, Delete, InfoFilled, VideoPlay, VideoPause } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { formatTime } from '../utils/format.ts';
import { api } from '../api/client.ts';
import type { ModuleDTO } from '../api/client.ts';

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
const REFRESH_INTERVAL = 10000; // 10秒刷新一次
const error = ref('');

// 弹窗相关
const dialogVisible = ref(false);
const dialogLoading = ref(false);
const dialogTestingConnection = ref(false);
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
        } else if (value < 5000) {
          callback(new Error('轮询间隔最小为 5000ms'));
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
    const listData = await api.getModules();

    // API 已返回完整数据（包括状态），直接使用
    modules.value = listData.modules.map((m: ModuleDTO) => {
      const modStatus: ModuleStatus = {
        state: (m.status?.state as ModuleStatus['state']) ?? null,
        lastPollTime: m.status?.lastPollTime,
        lastError: m.status?.lastError,
      };
      return {
        moduleKey: m.moduleKey,
        name: m.name,
        baseUrl: m.baseUrl,
        enabled: m.enabled,
        pollInterval: m.pollInterval,
        version: m.version || '-',
        status: modStatus,
        registeredAt: m.registeredTime ? formatTime(m.registeredTime) : '-',
        runtimeStartTime: m.status?.runtime?.startTime ? formatTime(m.status.runtime.startTime) : '-',
      };
    });
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
  return formatTime(mod.status.lastPollTime);
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

  // URL 重复校验（检查是否已存在相同 URL 的模块，排除自己）
  const normalizedUrl = formData.value.baseUrl.trim().replace(/\/$/, '');
  const existingByUrl = modules.value.find(m => 
    m.baseUrl.replace(/\/$/, '') === normalizedUrl && 
    m.moduleKey !== formData.value.moduleKey  // 编辑模式下排除自己
  );
  if (existingByUrl) {
    ElMessage.error(`该 Collector URL 已注册为「${existingByUrl.name}」，请勿重复添加`);
    return;
  }

  dialogTestingConnection.value = true;
  try {
    // 通过 admin API 测试连接（统一处理跨域）
    const data = await api.testModuleConnection(formData.value.baseUrl);

    if (data.moduleKey) {
      // 编辑模式下直接使用 API 返回的 key，不做重复检测
      // 新增模式下检查 moduleKey 是否冲突，如果冲突则自动追加后缀
      const isEdit = !!editingModule.value;
      let moduleKey = data.moduleKey;
      if (!isEdit) {
        let suffix = 2;
        while (modules.value.some(m => m.moduleKey === moduleKey)) {
          moduleKey = `${data.moduleKey}-${suffix}`;
          suffix++;
        }
      }
      formData.value.moduleKey = moduleKey;
      testPass.value = true;
      
      if (!isEdit && moduleKey !== data.moduleKey) {
        ElMessage.success(`连接成功，模块Key已调整为「${moduleKey}」（避免冲突）`);
      } else {
        ElMessage.success('连接成功，已自动获取模块Key');
      }
    } else {
      ElMessage.warning('连接成功，但未获取到模块信息');
    }
  } catch (e: any) {
    testPass.value = false;
    ElMessage.error('连接失败: ' + (e.message || '网络错误'));
  } finally {
    dialogTestingConnection.value = false;
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
    const method = isEdit ? 'PUT' : 'POST';

    const res = await api.saveModule(body, method, isEdit && editingModule.value ? editingModule.value.moduleKey : undefined);

    if (res.error) {
      throw new Error(res.error);
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
    const res = await api.deleteModule(mod.moduleKey);
    if (res.error) {
      throw new Error(res.error);
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
    // 乐观更新 status 字段，使其与 enabled 保持一致
    mod.enabled = newEnabled;
    mod.status = mod.status || {};
    mod.status.state = newEnabled ? 'running' : 'stopped';
    
    const res = await api.toggleModule(mod.moduleKey, newEnabled);
    if (res.error) {
      // 回滚状态
      mod.enabled = !newEnabled;
      throw new Error(res.error);
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
  if (cardLoading.value[mod.moduleKey]) return;
  cardLoading.value[mod.moduleKey] = true;
  try {
    const data = await api.testModuleConnection(mod.baseUrl);

    if (data.success) {
      ElMessage.success('连接成功');
    } else {
      ElMessage.error(data.error || '连接失败');
    }
  } catch (e: any) {
    ElMessage.error('连接测试失败: ' + (e.message || '未知错误'));
  } finally {
    cardLoading.value[mod.moduleKey] = false;
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
      <el-button :disabled="loading" circle size="small" @click="fetchModules(true)">
        <el-icon><Refresh /></el-icon>
      </el-button>
      <el-button type="primary" circle size="small" @click="openAddDialog">
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
            <div class="title-row">
              <div class="module-title">
                <h2 class="module-name">
                  {{ mod.name }}
                  <el-button
                    v-if="mod.moduleKey !== 'admin'"
                    link
                    class="inline-delete-btn"
                    @click.stop="deleteModule(mod)"
                    @mouseenter="$event.target.style.color = 'var(--color-accent-red)'"
                    @mouseleave="$event.target.style.color = 'var(--color-text-secondary)'"
                  >
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </h2>
                <span class="module-key">{{ mod.moduleKey }} @ {{ mod.version || '-' }}</span>
              </div>
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
              <span class="info-value time">{{ mod.registeredAt || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">启动时间</span>
              <span class="info-value time">{{ mod.runtimeStartTime || '-' }}</span>
            </div>
            <div class="info-row" v-if="getLastPollTime(mod)">
              <span class="info-label">最后轮询</span>
              <span class="info-value time">{{ getLastPollTime(mod) || "-" }}</span>
            </div>
            <div class="info-row error-row" v-if="getLastError(mod)">
              <span class="info-label">错误</span>
              <span class="info-value error-text" :title="getLastError(mod) || undefined">{{ getLastError(mod) }}</span>
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
                :loading="cardLoading[mod.moduleKey]"
                :disabled="cardLoading[mod.moduleKey]"
                @click.stop="testModuleConnection(mod)"
              >
                测试连接
              </el-button>
              <el-button
                v-if="mod.moduleKey !== 'admin'"
                :type="mod.enabled ? '' : 'success'"
                :class="['action-btn', mod.enabled ? 'btn-stop' : 'btn-start']"
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
        <el-button :loading="dialogTestingConnection" @click="testConnection">
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

/* 停用按钮：悬停黄色浅底 */
.card-actions-bottom .btn-stop:hover {
  background: var(--color-accent-yellow-subtle) !important;
  border-color: var(--color-accent-yellow) !important;
  color: var(--color-accent-yellow) !important;
}

/* 停用按钮：icon 也变黄色 */
.card-actions-bottom .btn-stop:hover .el-icon {
  color: var(--color-accent-yellow) !important;
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
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.module-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.module-name {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.3;
  display: flex;
  align-items: center;
  gap: 8px;
}

.inline-delete-btn {
  font-size: 14px;
  opacity: 0.6;
}

.inline-delete-btn:hover {
  opacity: 1;
}

.module-key {
  font-size: 13px;
  color: var(--color-text-secondary);
  font-family: var(--font-exo2);
  opacity: 0.8;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0;
  margin: 0 -12px; /* Extend to card edges */
}



.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
  padding: 2px 0;
}

.info-label {
  color: var(--color-text-secondary);
  font-weight: 400;
  flex-shrink: 0;
  width: 80px;
  text-align: left;
  padding-right: 12px;
}

.info-value {
  color: var(--color-text);
  font-weight: 400;
  text-align: right;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-value.url {
  font-family: var(--font-exo2);
  font-size: 12px;
  color: var(--color-accent-green);
}

.info-value.time {
  font-family: var(--font-exo2);
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
