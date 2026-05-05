<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { adminConnection, type ConnectionState } from '../utils/adminConnection';
import { isUrlValid } from '../utils/validators';

const emit = defineEmits<{
  (e: 'connection-change', connected: boolean): void;
}>();

const currentState = ref<ConnectionState>('UNCONFIGURED');
// 立即初始化，从持久化配置读取当前地址
const inputUrl = ref(adminConnection.getCurrentUrl() || '');
const testing = ref(false);
const saving = ref(false);
const testPass = ref(false);
const inputError = ref('');

let unsubscribe: (() => void) | null = null;

const statusMessage = computed(() => {
  switch (currentState.value) {
    case 'UNCONFIGURED':
      return 'Admin 服务未配置';
    case 'CONFIGURING':
      return '正在测试 Admin 服务连接...';
    case 'CONFIG_ERROR':
      return 'Admin 服务地址格式错误';
    case 'CONN_FAILED':
      return 'Admin 服务连接失败';
    case 'DISCONNECTED':
      return 'Admin 服务连接已断开';
    case 'CONNECTED':
      return 'Admin 服务已连接';
    default:
      return '';
  }
});

const statusIcon = computed(() => {
  switch (currentState.value) {
    case 'CONNECTED':
      return '✓';
    case 'DISCONNECTED':
    case 'CONN_FAILED':
    case 'CONFIG_ERROR':
      return '⚠️';
    case 'CONFIGURING':
      return '⏳';
    default:
      return '📡';
  }
});

const alertStyle = computed(() => {
  return { background: '#fef0f0', borderColor: '#fecaca' };
});



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
  try {
    const success = await adminConnection.configure(url);
    testPass.value = success;
  } finally {
    testing.value = false;
  }
}

async function saveConnection() {
  const url = inputUrl.value.trim();
  if (!url) return;
  saving.value = true;
  try {
    await adminConnection.configure(url);
  } finally {
    saving.value = false;
  }
}

function onInputChange() {
  inputError.value = '';
  testPass.value = false;
}

// 同步状态
currentState.value = adminConnection.getState();

onMounted(() => {
  // 订阅状态变化
  unsubscribe = adminConnection.onStateChange((state) => {
    currentState.value = state;
    emit('connection-change', state === 'CONNECTED');
  });

  // 如果有配置但未检测过，先触发一次检测
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
  <div v-if="currentState !== 'CONNECTED'" class="connection-alert" :style="alertStyle">
    <span class="alert-icon">{{ statusIcon }}</span>
    <span class="alert-message">{{ statusMessage }}</span>

    <div class="alert-controls">
      <el-input
        v-model="inputUrl"
        placeholder="http(s)://地址:端口"
        size="small"
        class="url-input"
        :class="{ 'has-error': inputError }"
        :disabled="currentState === 'CONFIGURING'"
        @change="onInputChange"
        @keyup.enter="testConnection"
      />
      <span v-if="inputError" class="input-error">{{ inputError }}</span>
      <el-button
        size="small"
        :loading="testing"
        :disabled="currentState === 'CONFIGURING'"
        @click="testConnection"
      >
        测试连接
      </el-button>
      <el-button
        type="primary"
        size="small"
        :loading="saving"
        :disabled="currentState === 'CONFIGURING' || !testPass"
        @click="saveConnection"
      >
        保存
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.connection-alert {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border: 1px solid;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.alert-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.alert-message {
  color: var(--color-text-primary);
  font-weight: 500;
  flex-shrink: 0;
}

.alert-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
}

.url-input {
  width: 220px;
}

.url-input :deep(.el-input__wrapper) {
  font-size: 12px;
}

.input-error {
  font-size: 11px;
  color: var(--el-color-danger);
  white-space: nowrap;
}
</style>
