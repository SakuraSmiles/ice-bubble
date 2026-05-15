<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { adminConnection, type ConnectionState, type ConfigureResult } from '../utils/adminConnection';
import { isUrlValid } from '../utils/validators';
import {
  InfoFilled,
  Lock,
  CircleCloseFilled,
  WarningFilled,
  Loading,
  CircleCheckFilled,
  ArrowDown,
  ArrowRight,
  View,
  Hide,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';

const emit = defineEmits<{
  (e: 'connection-change', connected: boolean): void;
}>();

const router = useRouter();

const currentState = ref<ConnectionState>('UNCONFIGURED');
const inputUrl = ref(adminConnection.getCurrentUrl() || '');
const inputToken = ref(adminConnection.getCurrentToken() || '');
const testing = ref(false);
const saving = ref(false);
const testPass = ref(false);
const inputError = ref('');
const showToken = ref(false);
const collapsed = ref(false);
let unsubscribe: (() => void) | null = null;

// ============ 状态 -> UI 映射 ============

const statusMessage = computed(() => {
  switch (currentState.value) {
    case 'UNCONFIGURED':
      return 'Admin 服务未配置，请填写连接信息';
    case 'CONFIGURING':
      return '正在测试 Admin 服务连接...';
    case 'CONFIG_ERROR':
      return 'Admin 地址无效，请检查 URL';
    case 'AUTH_REQUIRED':
      return '需要认证，请填写 Token';
    case 'AUTH_FAILED':
      return 'Token 不正确，请检查后重试';
    case 'CONN_FAILED':
      return 'Admin 服务未启动或端口未开放';
    case 'DISCONNECTED':
      return 'Admin 连接已断开，正在自动重连…';
    case 'CONNECTED':
      return 'Admin 服务已连接';
    default:
      return '';
  }
});

const statusIconComponent = computed(() => {
  switch (currentState.value) {
    case 'UNCONFIGURED':
      return InfoFilled;
    case 'CONFIG_ERROR':
      return WarningFilled;
    case 'AUTH_REQUIRED':
    case 'AUTH_FAILED':
      return Lock;
    case 'CONN_FAILED':
      return CircleCloseFilled;
    case 'CONFIGURING':
      return Loading;
    case 'DISCONNECTED':
      return Loading;
    case 'CONNECTED':
      return CircleCheckFilled;
    default:
      return InfoFilled;
  }
});

const alertColorClass = computed(() => {
  switch (currentState.value) {
    case 'UNCONFIGURED':
      return 'alert-info';
    case 'AUTH_REQUIRED':
      return 'alert-warning';
    case 'CONFIG_ERROR':
    case 'AUTH_FAILED':
    case 'CONN_FAILED':
      return 'alert-danger';
    case 'DISCONNECTED':
      return 'alert-caution';
    default:
      return 'alert-danger';
  }
});

/** 是否显示操作区（展开区） */
const showActionArea = computed(() => {
  if (currentState.value === 'DISCONNECTED') return false;
  if (currentState.value === 'UNCONFIGURED') return true; // 强制展开，但不显示收起按钮
  if (currentState.value === 'CONNECTED') return false;
  return !collapsed.value;
});

/** 是否显示收起按钮 */
const showCollapseButton = computed(() => {
  return currentState.value !== 'UNCONFIGURED'
    && currentState.value !== 'DISCONNECTED'
    && currentState.value !== 'CONNECTED'
    && currentState.value !== 'CONFIGURING';
});



// ============ 交互逻辑 ============

function toggleCollapse() {
  collapsed.value = !collapsed.value;
}

async function testConnection() {
  const url = inputUrl.value.trim();
  if (!url) {
    inputError.value = '请输入 Admin 服务地址';
    return;
  }
  if (!isUrlValid(url)) {
    inputError.value = '格式：http(s)://地址:端口，如 http://localhost:13000';
    return;
  }
  inputError.value = '';
  testing.value = true;
  testPass.value = false;
  try {
    const result: ConfigureResult = await adminConnection.configure(url, inputToken.value || undefined);
    if (result.success) {
      testPass.value = true;
      ElMessage.success({ message: '连接成功', duration: 2000, grouping: true });
    } else {
      ElMessage.error({ message: result.error || '连接失败', duration: 2000, grouping: true });
      // 根据错误类型更新 token 相关状态
      if (result.error === 'AUTH_REQUIRED') {
        inputToken.value = '';
      }
    }
  } finally {
    testing.value = false;
  }
}

async function saveConnection() {
  const url = inputUrl.value.trim();
  if (!url || !testPass.value) return;
  saving.value = true;
  try {
    // configure 已经在 testConnection 中调用过并成功，这里只确保保存
    await adminConnection.configure(url, inputToken.value || undefined);
    ElMessage.success({ message: '配置已保存', duration: 2000, grouping: true });
  } finally {
    saving.value = false;
  }
}

function onInputChange() {
  inputError.value = '';
  testPass.value = false;
}

function goToSettings() {
  router.push('/settings');
}

// ============ 生命周期 ============

currentState.value = adminConnection.getState();

watch(currentState, () => {
  // 重新出现故障时默认展开
  collapsed.value = false;
});

onMounted(() => {
  unsubscribe = adminConnection.onStateChange((state) => {
    currentState.value = state;
    emit('connection-change', state === 'CONNECTED');
  });

  if (!adminConnection.getCurrentUrl()) {
    currentState.value = 'UNCONFIGURED';
  }

});

onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});
</script>

<template>
  <div
    v-if="currentState !== 'CONNECTED' && currentState !== 'CONFIGURING'"
    class="connection-alert"
    :class="alertColorClass"
  >
      <!-- 第一行：标题栏 -->
      <div class="alert-header">
        <div class="alert-header-left">
          <el-icon class="alert-icon" :size="16"><component :is="statusIconComponent" /></el-icon>
          <span class="alert-message">{{ statusMessage }}</span>
        </div>
        <div class="alert-header-right">
          <el-button
            v-if="currentState === 'DISCONNECTED'"
            type="primary"
            link
            size="small"
            @click="goToSettings"
          >
            前往设置页 &gt;
          </el-button>
          <el-button
            v-if="showCollapseButton"
            link
            size="small"
            @click="toggleCollapse"
          >
            <el-icon :size="14">
              <ArrowDown v-if="!collapsed" />
              <ArrowRight v-else />
            </el-icon>
          </el-button>
        </div>
      </div>

      <!-- 第二行：操作区 -->
      <div v-show="showActionArea" class="alert-body">
        <div class="alert-body-controls">
          <div class="input-group">
            <label class="input-label">URL:</label>
            <el-input
              v-model="inputUrl"
              placeholder="http(s)://地址:端口"
              size="small"
              class="url-input"
              :class="{ 'has-error': inputError }"
              @change="onInputChange"
              @keyup.enter="testConnection"
            />
          </div>
          <div class="input-group">
            <label class="input-label">Token:</label>
            <el-input
              v-model="inputToken"
              :type="showToken ? 'text' : 'password'"
              placeholder="Bearer Token"
              size="small"
              class="token-input"
              @change="onInputChange"
              @keyup.enter="testConnection"
            >
              <template #suffix>
                <el-icon class="token-toggle" @click="showToken = !showToken">
                  <View v-if="showToken" />
                  <Hide v-else />
                </el-icon>
              </template>
            </el-input>
          </div>
          <el-button
            size="small"
            :loading="testing"
            @click="testConnection"
          >
            测试连接
          </el-button>
          <el-button
            type="primary"
            size="small"
            :loading="saving"
            :disabled="!testPass"
            @click="saveConnection"
          >
            保存
          </el-button>
        </div>
        <div class="alert-body-footer">
          <span v-if="inputError" class="input-error">{{ inputError }}</span>
          <el-button type="primary" link size="small" class="goto-settings" @click="goToSettings">
            前往设置页 &gt;
          </el-button>
        </div>
      </div>
    </div>
</template>

<style scoped>
/* ============ 配色变量 ============ */
.alert-info {
  --alert-bg: #eff6ff;
  --alert-border: #93c5fd;
}
.alert-warning {
  --alert-bg: #fff7ed;
  --alert-border: #fdba74;
}
.alert-danger {
  --alert-bg: #fef2f2;
  --alert-border: #fca5a5;
}
.alert-caution {
  --alert-bg: #fefce8;
  --alert-border: #fde047;
}
/* ============ 横幅容器 ============ */
.connection-alert {
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--alert-border, #fca5a5);
  border-radius: 6px;
  background: var(--alert-bg, #fef2f2);
  margin-bottom: 16px;
  overflow: hidden;
  transition: background 0.3s ease, border-color 0.3s ease;
}

/* ============ 标题行 ============ */
.alert-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  min-height: 36px;
}

.alert-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.alert-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.alert-icon {
  flex-shrink: 0;
  color: inherit;
}

.alert-message {
  font-size: 13px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}

/* ============ 操作区（展开/收起动画） ============ */
.alert-body {
  max-height: 200px;
  opacity: 1;
  overflow: hidden;
  transition: max-height 0.3s ease, opacity 0.3s ease;
  padding: 0 16px 12px;
}

.alert-body[style*="display: none"],
.alert-body[style*="display:none"] {
  max-height: 0;
  opacity: 0;
  padding: 0 16px;
}

.alert-body-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.alert-body-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.input-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.input-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
  white-space: nowrap;
}

.url-input {
  width: 240px;
}

.token-input {
  width: 200px;
}

.url-input :deep(.el-input__wrapper),
.token-input :deep(.el-input__wrapper) {
  font-size: 12px;
}

.token-toggle {
  cursor: pointer;
  color: var(--el-text-color-placeholder);
  transition: color 0.2s;
}

.token-toggle:hover {
  color: var(--el-text-color-primary);
}

.url-input.has-error :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.input-error {
  font-size: 11px;
  color: var(--el-color-danger);
  white-space: nowrap;
}

.goto-settings {
  margin-left: auto;
}
</style>
