<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { Refresh, Plus, Delete } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';

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
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_INTERVAL = 10000; // 10秒刷新一次
const error = ref('');

// 弹窗相关
const dialogVisible = ref(false);
const dialogLoading = ref(false);
const testingConnection = ref(false);
const formData = ref({
  baseUrl: '',
  moduleKey: '',
  name: '',
  enabled: true,
  pollInterval: 30000,
});
const editingModule = ref<Module | null>(null);

async function fetchModules() {
  loading.value = true;
  error.value = '';
  try {
    const listRes = await fetch('/api/modules');
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
    const listData = await listRes.json();

    const moduleDetails = await Promise.all(
      listData.modules.map(async (m: any) => {
        try {
          const detailRes = await fetch(`/api/modules/${m.moduleKey}`);
          if (!detailRes.ok) throw new Error(`HTTP ${detailRes.status}`);
          const detail = await detailRes.json();
          return {
            moduleKey: detail.moduleKey,
            name: detail.name,
            baseUrl: detail.baseUrl,
            enabled: detail.enabled,
            pollInterval: detail.pollInterval,
            registeredTime: detail.registeredTime,
            status: detail.status || { state: null, lastPollTime: null, lastError: null },
            version: detail.version || '-',
            registeredAt: detail.registeredTime
              ? new Date(detail.registeredTime).toLocaleString('zh-CN')
              : '-',
            runtimeStartTime: detail.status?.runtime?.startTime
              ? new Date(detail.status.runtime.startTime).toLocaleString('zh-CN')
              : '-',
          };
        } catch {
          return {
            ...m,
            status: { state: 'error', lastPollTime: null, lastError: '连接失败' },
            version: '-',
            registeredAt: m.registeredTime ? new Date(m.registeredTime).toLocaleString('zh-CN') : '-',
            runtimeStartTime: '-',
          };
        }
      })
    );

    modules.value = moduleDetails;
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
  
  // 2. 无运行时状态或 null（首次运行前 / admin）→ 显示"运行中"
  if (!mod.status?.state) return { label: '运行中', type: 'success' };
  
  // 3. 根据运行时状态
  switch (mod.status.state) {
    case 'running': return { label: '运行中', type: 'success' };
    case 'error': return { label: '异常', type: 'danger' };
    case 'stopped': return { label: '已停止', type: 'warning' };
    default: return { label: '未知', type: 'info' };
  }
}

function getLastError(mod: Module): string | null {
  return mod.status?.lastError || null;
}

function getLastPollTime(mod: Module): string | null {
  if (!mod.status?.lastPollTime) return null;
  return new Date(mod.status.lastPollTime).toLocaleString('zh-CN');
}

// 打开新增弹窗
function openAddDialog() {
  editingModule.value = null;
  formData.value = {
    baseUrl: '',
    moduleKey: '',
    name: '',
    enabled: true,
    pollInterval: 30000,
  };
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
  dialogVisible.value = true;
}

// 测试连接
async function testConnection() {
  if (!formData.value.baseUrl) {
    ElMessage.warning('请输入模块地址');
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
      ElMessage.success('连接成功，已自动获取模块Key');
    } else {
      ElMessage.warning('连接成功，但未获取到模块信息');
    }
  } catch (e: any) {
    ElMessage.error('连接失败: ' + (e.message || '网络错误'));
  } finally {
    testingConnection.value = false;
  }
}

// 保存模块
async function saveModule() {
  if (!formData.value.baseUrl || !formData.value.name) {
    ElMessage.warning('请填写完整信息');
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
    const url = isEdit ? '/api/modules/' + editingModule.value.moduleKey : '/api/modules';
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
  if (!confirm(`确定要删除模块「${mod.name}」吗？`)) return;

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

onMounted(() => {
  fetchModules();
  // 启动定时刷新
  refreshTimer = setInterval(fetchModules, REFRESH_INTERVAL);
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
    <div class="page-header">
      <h1 class="page-title">模块管理</h1>
      <div class="header-actions">
        <el-button :disabled="loading" circle @click="fetchModules">
          <el-icon><Refresh /></el-icon>
        </el-button>
        <el-button type="primary" circle @click="openAddDialog">
          <el-icon><Plus /></el-icon>
        </el-button>
      </div>
    </div>

    <el-card class="content-area">
      <div v-if="error" class="error-msg">{{ error }}</div>
      <div v-if="loading && modules.length === 0" class="loading-msg">加载中...</div>
      <div v-else-if="modules.length === 0" class="empty-msg">暂无模块</div>
      <div v-else class="cards-grid">
        <el-card
          v-for="mod in modules"
          :key="mod.moduleKey"
          class="module-card"
          @click="openEditDialog(mod)"
        >
          <div class="card-header">
            <div class="module-title">
              <h2 class="module-name">{{ mod.name }}</h2>
              <span class="module-key">{{ mod.moduleKey }}</span>
            </div>
            <div class="card-actions">
              <el-tag
              :type="getDisplayStatus(mod).type"
              size="small"
            >
              {{ getDisplayStatus(mod).label }}
            </el-tag>
              <el-button
                v-if="mod.moduleKey !== 'admin'"
                link
                @click.stop="deleteModule(mod)"
                @mouseenter="$event.target.style.color = 'var(--color-accent-red)'"
                @mouseleave="$event.target.style.color = 'var(--color-text-secondary)'"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
          <div class="card-body">
            <div class="info-row">
              <span class="info-label">版本</span>
              <span class="info-value">{{ mod.version || '-' }}</span>
            </div>
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
              <span class="info-value">{{ getLastPollTime(mod) }}</span>
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
        </el-card>
      </div>
    </el-card>

    <div class="copyright">
      <span>© 2026 IceBubble · Built with OpenClaw</span>
    </div>

    <!-- 新增/编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingModule ? '编辑模块' : '新增模块'"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form label-width="80px">
        <el-form-item label="地址">
          <el-input
            v-model="formData.baseUrl"
            placeholder="http://localhost:13100"
          />
        </el-form-item>
        <el-form-item label="Key">
          <el-input v-model="formData.moduleKey" placeholder="自动获取" disabled />
        </el-form-item>
        <el-form-item label="名字">
          <el-input v-model="formData.name" placeholder="请输入模块名称" />
        </el-form-item>
        <el-form-item label="轮询间隔">
          <el-input-number
            v-model="formData.pollInterval"
            :min="5000"
            :step="5000"
            controls-position="right"
          />
          <span class="form-tip">毫秒，最小 5000ms</span>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="formData.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button :loading="testingConnection" @click="testConnection">
          测试连接
        </el-button>
        <el-button
          type="primary"
          :loading="dialogLoading"
          @click="saveModule"
        >
          保存
        </el-button>
      </template>
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
  gap: 4px;
}

.module-name {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.3;
}

.module-key {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: monospace;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.info-label {
  color: var(--color-text-secondary);
}

.info-value {
  color: var(--color-text);
  font-weight: 500;
}

.info-value.url {
  font-size: 12px;
  color: var(--color-text-secondary);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>
.form-tip { margin-left: 8px; color: var(--color-text-secondary); font-size: 12px; }

