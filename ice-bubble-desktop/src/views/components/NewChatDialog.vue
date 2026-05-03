<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api/client';
import { useSessionGroupStore } from '@/stores/sessionGroupStore';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void;
  (e: 'created', sessionKey: string): void;
}>();

const groupStore = useSessionGroupStore();

const agentId = ref('');
const label = ref('');
const groupId = ref<number | null>(null);
const agents = ref<{ agent_id: string; agent_name: string | null }[]>([]);
const loading = ref(false);
const creating = ref(false);

const dialogVisible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val),
});

const groupOptions = computed(() =>
  groupStore.groups.map(g => ({ label: g.name, value: g.id })),
);

onMounted(async () => {
  // 拉取 agent 列表
  try {
    const res = await api.getAgents();
    agents.value = res.agents.map(a => ({
      agent_id: a.agent_id,
      agent_name: a.agent_name || a.agent_id,
    }));
    if (agents.value.length > 0) {
      agentId.value = agents.value[0].agent_id;
    }
  } catch (e) {
    console.error('[NewChatDialog] fetchAgents failed:', e);
  }
});

async function handleCreate() {
  if (!agentId.value) {
    ElMessage.warning('请选择一个 Agent');
    return;
  }
  creating.value = true;
  try {
    const session = await api.createSession({
      agentId: agentId.value,
      label: label.value || undefined,
    });

    // 如果选了分组，加入分组
    if (groupId.value != null) {
      try {
        await groupStore.addMember(groupId.value, session.session_key);
      } catch (e) {
        console.warn('[NewChatDialog] 加入分组失败:', e);
      }
    }

    ElMessage.success('对话已创建');
    dialogVisible.value = false;
    label.value = '';
    groupId.value = null;
    emit('created', session.session_key);
  } catch (e: any) {
    ElMessage.error(e.message || '创建对话失败');
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="新建对话"
    width="420px"
    :close-on-click-modal="false"
    append-to-body
  >
    <el-form label-position="top" @submit.prevent="handleCreate">
      <el-form-item label="Agent">
        <el-select
          v-model="agentId"
          placeholder="选择 Agent"
          :loading="loading"
          style="width: 100%"
        >
          <el-option
            v-for="a in agents"
            :key="a.agent_id"
            :label="a.agent_name"
            :value="a.agent_id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="主题（可选）">
        <el-input
          v-model="label"
          placeholder="给对话起个名字..."
          maxlength="100"
          clearable
        />
      </el-form-item>

      <el-form-item label="分组（可选）">
        <el-select
          v-model="groupId"
          placeholder="不加入分组"
          clearable
          style="width: 100%"
        >
          <el-option
            v-for="g in groupOptions"
            :key="g.value"
            :label="g.label"
            :value="g.value"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="creating" @click="handleCreate">
        创建
      </el-button>
    </template>
  </el-dialog>
</template>
