<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '@/api/client';
import type { SessionDTO } from '@/api/client';
import { useSessionGroupStore } from '@/stores/sessionGroupStore';
import { useSessionPreferencesStore } from '@/stores/sessionPreferencesStore';
import { gatewayClient } from '@/services/gateway-client';
import NewChatDialog from './NewChatDialog.vue';

const router = useRouter();
const route = useRoute();
const groupStore = useSessionGroupStore();
const prefsStore = useSessionPreferencesStore();

// ====== 数据 ======
const sessions = ref<SessionDTO[]>([]);
const collapsedGroups = ref<Set<number>>(new Set());
const showNewChat = ref(false);

let timer: ReturnType<typeof setInterval> | null = null;
let unsubSessionsChanged: (() => void) | null = null;

// ====== 过滤规则 ======
function shouldShow(s: SessionDTO): boolean {
  const key = s.session_key;
  // 不展示 subagent 会话
  if (key.includes(':subagent:')) return false;
  // 不展示 dreaming 会话（key 含 dreaming-）
  if (key.includes('dreaming-')) return false;
  // 不展示 dashboard 自动创建的会话
  if (key.includes(':dashboard:')) return false;
  // 不展示 cron 定时任务会话
  if (key.includes(':cron:')) return false;
  // 不展示没有 UUID 的短 key（如 agent:main:main），无法正确加载聊天
  if (!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return false;
  return true;
}

// ====== 分组计算 ======
const groupedSessions = computed(() => {
  const filtered = sessions.value.filter(shouldShow).filter(s => !prefsStore.isHidden(s.session_key));
  return groupStore.getGroupSessions(filtered);
});

// ====== 侧栏精简：置顶 + 每个 agent 当天/最近 3 个 ======
const sidebarSessions = computed(() => {
  const all = sessions.value.filter(shouldShow).filter(s => !prefsStore.isHidden(s.session_key));
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const autoPinned: SessionDTO[] = [];
  const autoPinnedKeys = new Set<string>();

  const pinned = all.filter(s => prefsStore.isPinned(s.session_key) && !autoPinnedKeys.has(s.session_key));
  const pinnedKeys = new Set(pinned.map(s => s.session_key));
  const excludedKeys = new Set([...autoPinnedKeys, ...pinnedKeys]);
  const groupedKeys = groupStore.groupedKeys;
  const ungrouped = all.filter(s => !excludedKeys.has(s.session_key) && !groupedKeys.has(s.session_key));

  const agentMap = new Map<string, SessionDTO[]>();
  for (const s of ungrouped) {
    const agentId = s.agent_id || 'unknown';
    const list = agentMap.get(agentId) || [];
    list.push(s);
    agentMap.set(agentId, list);
  }

  const recent: SessionDTO[] = [];
  for (const [, list] of agentMap) {
    list.sort((a, b) => {
      const ta = new Date(a.updated_at || a.last_message_at || a.created_at).getTime();
      const tb = new Date(b.updated_at || b.last_message_at || b.created_at).getTime();
      return tb - ta;
    });
    const todaySessions = list.filter(s => {
      const t = new Date(s.updated_at || s.last_message_at || s.created_at).getTime();
      return t >= todayStart;
    });
    const source = todaySessions.length > 0 ? todaySessions : list;
    recent.push(...source.slice(0, 3));
  }

  return { autoPinned, pinned, recent };
});

// ====== 辅助函数 ======
function stripMarkdown(text: string): string {
  let s = text;
  // 图片语法 ![alt](url) → 删除整段
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // 链接 [text](url) → text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 标题 # ## ### → 去掉
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用 > → 去掉
  s = s.replace(/^>\s?/gm, '');
  // 无序列表标记 - * + (仅行首)
  s = s.replace(/^[-*+]\s+/gm, '');
  // 加粗 **text** / __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  // 斜体 *text* (单星号，不匹配已处理的加粗)
  s = s.replace(/(?<!\*)\*(?!=\*)(.+?)(?<!\*)\*(?!=\*)/g, '$1');
  // 代码反引号
  s = s.replace(/`(.+?)`/g, '$1');
  // 系统消息视为空
  if (['NO_REPLY', 'HEARTBEAT_OK'].includes(s.trim())) return '';
  // 压缩空白
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function generateTitle(s: SessionDTO): string {
  if (s.label) return s.label;
  // 优先用 first_message，其次 last_message
  let raw = (s.first_message || '').trim();
  if (!raw || ['NO_REPLY', 'HEARTBEAT_OK'].includes(raw)) {
    raw = (s.last_message || '').trim();
  }
  let msg = stripMarkdown(raw);
  if (!msg) return '新对话';
  // 去掉以 [ 开头的标签前缀
  if (msg.startsWith('[')) {
    const closeIdx = msg.indexOf(']');
    if (closeIdx > 0 && closeIdx < msg.length - 1) {
      msg = msg.slice(closeIdx + 1).trim();
    }
  }
  if (!msg) return '新对话';
  return msg.length > 35 ? msg.slice(0, 35) + '…' : msg;
}

function formatTitle(s: SessionDTO, pinned?: boolean): string {
  const title = generateTitle(s);
  return pinned ? '📌 ' + title : title;
}

function generatePreview(s: SessionDTO): string {
  if (s.last_message) {
    let msg = stripMarkdown(s.last_message);
    if (!msg) return '';
    // 如果消息就是标题，不重复显示
    if (s.label && msg === s.label) return '';
    const title = generateTitle(s);
    if (msg === title) return '';
    return msg.length > 30 ? msg.slice(0, 30) + '…' : msg;
  }
  return '';
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function isActive(key: string): boolean {
  return route.path === `/workspace/${encodeURIComponent(key)}`;
}




function toggleGroup(groupId: number) {
  if (collapsedGroups.value.has(groupId)) {
    collapsedGroups.value.delete(groupId);
  } else {
    collapsedGroups.value.add(groupId);
  }
}

function handleClick(session: SessionDTO) {
  router.push(`/workspace/${encodeURIComponent(session.session_key)}`);
}

function handleChatCreated(sessionKey: string) {
  // 刷新列表
  fetchAll();
  // 跳转到新对话
  router.push(`/workspace/${encodeURIComponent(sessionKey)}`);
}

function goToAllSessions() {
  router.push('/sessions');
}

// ====== 右键菜单 ======
const contextMenu = ref<{
  visible: boolean;
  x: number;
  y: number;
  session: SessionDTO | null;
}>({ visible: false, x: 0, y: 0, session: null });

const groupSelectVisible = ref(false);
const addingToGroup = ref<SessionDTO | null>(null);

function onContextMenu(e: MouseEvent, session: SessionDTO) {
  e.preventDefault();
  contextMenu.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    session,
  };
}

function closeContextMenu() {
  contextMenu.value.visible = false;
}

async function handleAddToGroup() {
  if (!contextMenu.value.session) return;
  addingToGroup.value = contextMenu.value.session;
  groupSelectVisible.value = true;
  closeContextMenu();
}

async function handleGroupSelect(groupId: number) {
  if (!addingToGroup.value) return;
  try {
    await groupStore.addMember(groupId, addingToGroup.value.session_key);
    closeContextMenu();
  } catch (e: any) {
    console.error('加入分组失败:', e);
  }
  groupSelectVisible.value = false;
  addingToGroup.value = null;
}

async function handleRemoveFromGroup() {
  const session = contextMenu.value.session;
  if (!session) return;
  // 找到该 session 所在的 group
  for (const g of groupStore.groups) {
    if (g.members?.some(m => m.session_key === session.session_key)) {
      try {
        await groupStore.removeMember(g.id, session.session_key);
      } catch (e) {
        console.error('移除分组失败:', e);
      }
      break;
    }
  }
  closeContextMenu();
}

function closeGroupSelect() {
  groupSelectVisible.value = false;
  addingToGroup.value = null;
}

// ====== 数据获取 ======
async function fetchAll() {
  await Promise.all([
    fetchSessions(),
    groupStore.fetchGroups(),
  ]);
}

async function fetchSessions() {
  try {
    const data = await api.getUnifiedSessions({});
    let list = data.sessions || [];
    // 按更新时间排序（最新的在前）
    list.sort((a, b) => {
      const ta = a.updated_at || a.last_message_at || a.created_at;
      const tb = b.updated_at || b.last_message_at || b.created_at;
      return new Date(tb).getTime() - new Date(ta).getTime();
    });
    sessions.value = list;
  } catch (e) {
    // 静默失败
  }
}

// ====== 生命周期 ======
onMounted(async () => {
  if (!prefsStore.loaded) {
    await prefsStore.fetchPreferences();
  }
  fetchAll();

  unsubSessionsChanged = gatewayClient.on('sessions.changed', () => {
    fetchAll();
  });

  timer = setInterval(() => {
    if (!gatewayClient.isConnected) {
      fetchAll();
    }
  }, 60000);

  // 全局点击关闭右键菜单
  document.addEventListener('click', closeContextMenu);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (unsubSessionsChanged) { unsubSessionsChanged(); unsubSessionsChanged = null; }
  document.removeEventListener('click', closeContextMenu);
});
</script>

<template>
  <div class="session-list">
    <!-- 会话列表（精简模式） -->
    <div class="session-list-body">
      <div v-if="sessions.length === 0 && !prefsStore.loaded" class="session-empty">
        加载中...
      </div>
      <div v-else-if="sidebarSessions.pinned.length === 0 && sidebarSessions.recent.length === 0 && groupedSessions.grouped.length === 0" class="session-empty">
        暂无会话
      </div>



      <!-- 新建对话按钮（主会话下方） -->
      <div class="session-list-header">
        <el-button
          class="new-chat-btn"
          @click="showNewChat = true"
        >
          <el-icon><Plus /></el-icon>
          <span>新建对话</span>
        </el-button>
      </div>

      <!-- 分组区 -->
      <template v-for="group in groupedSessions.grouped" :key="group.group.id">
        <div class="group-section">
          <div class="group-header" @click="toggleGroup(group.group.id)">
            <el-icon class="group-arrow" :class="{ collapsed: collapsedGroups.has(group.group.id) }">
              <ArrowRight />
            </el-icon>
            <span class="group-icon">{{ group.group.icon || '📁' }}</span>
            <span class="group-name">{{ group.group.name }}</span>
            <span class="group-count">{{ group.sessions.length }}</span>
          </div>
          <Transition name="collapse">
            <div v-show="!collapsedGroups.has(group.group.id)" class="group-sessions">
              <div
                v-for="s in group.sessions"
                :key="s.session_key"
                class="session-item"
                :class="{ active: isActive(s.session_key) }"
                @click="handleClick(s)"
                @contextmenu="onContextMenu($event, s)"
              >
                <div class="session-item-main">
                  <div class="session-item-row">
                    <span class="session-item-title">{{ formatTitle(s, prefsStore.isPinned(s.session_key)) }}</span>
                    <span class="session-time">{{ formatTime(s.last_message_at || s.updated_at) }}</span>
                  </div>
                  <div class="session-item-sub">
                    <span v-if="s.agent_name" class="session-agent-name">{{ s.agent_name }}</span>
                    <template v-if="generatePreview(s)">
                      <span v-if="s.agent_name" class="session-sub-sep"> · </span>
                      <span>{{ generatePreview(s) }}</span>
                    </template>
                    <template v-else-if="!s.agent_name">暂无消息</template>
                  </div>
                </div>
              </div>
              <div v-if="group.sessions.length === 0" class="group-empty">空分组</div>
            </div>
          </Transition>
        </div>
      </template>

      <!-- 用户置顶会话 -->
      <template v-if="sidebarSessions.pinned.length > 0">
        <div v-if="groupedSessions.grouped.length > 0" class="section-divider"></div>
        <div class="section-label">📌 置顶</div>
        <div
          v-for="s in sidebarSessions.pinned"
          :key="s.session_key"
          class="session-item pinned"
          :class="{ active: isActive(s.session_key) }"
          @click="handleClick(s)"
          @contextmenu="onContextMenu($event, s)"
        >
          <div class="session-item-main">
            <div class="session-item-row">
              <span class="session-item-title">{{ formatTitle(s, true) }}</span>
              <span class="session-time">{{ formatTime(s.last_message_at || s.updated_at) }}</span>
            </div>
            <div class="session-item-sub">
              <span v-if="s.agent_name" class="session-agent-name">{{ s.agent_name }}</span>
              <template v-if="generatePreview(s)">
                <span v-if="s.agent_name" class="session-sub-sep"> · </span>
                <span>{{ generatePreview(s) }}</span>
              </template>
              <template v-else-if="!s.agent_name">暂无消息</template>
            </div>
          </div>
        </div>
      </template>

      <!-- 最近会话 -->
      <template v-if="sidebarSessions.recent.length > 0">
        <div v-if="groupedSessions.grouped.length > 0 || sidebarSessions.pinned.length > 0" class="section-divider"></div>
        <div class="section-label">最近会话</div>
        <div
          v-for="s in sidebarSessions.recent"
          :key="s.session_key"
          class="session-item session-item-compact"
          :class="{ active: isActive(s.session_key) }"
          @click="handleClick(s)"
          @contextmenu="onContextMenu($event, s)"
        >
          <div class="session-item-main">
            <div class="session-item-row">
              <span class="session-item-title">{{ formatTitle(s, prefsStore.isPinned(s.session_key)) }}</span>
              <span class="session-time">{{ formatTime(s.last_message_at || s.updated_at) }}</span>
            </div>
            <div class="session-item-sub">
              <span v-if="s.agent_name" class="session-agent-name">{{ s.agent_name }}</span>
              <template v-if="generatePreview(s)">
                <span v-if="s.agent_name" class="session-sub-sep"> · </span>
                <span>{{ generatePreview(s) }}</span>
              </template>
              <template v-else-if="!s.agent_name">暂无消息</template>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 底部：全部会话按钮 -->
    <div class="session-list-footer">
      <button class="all-sessions-btn" @click="goToAllSessions">
        📋 全部会话
      </button>
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <div class="context-menu-item" @click="handleAddToGroup">加入分组</div>
        <div class="context-menu-item danger" @click="handleRemoveFromGroup">从分组移除</div>
      </div>
    </Teleport>

    <!-- 分组选择浮窗 -->
    <Teleport to="body">
      <div
        v-if="groupSelectVisible"
        class="group-select-overlay"
        @click.self="closeGroupSelect"
      >
        <div class="group-select-popup">
          <div class="group-select-title">选择分组</div>
          <div
            v-for="g in groupStore.groups"
            :key="g.id"
            class="group-select-item"
            @click="handleGroupSelect(g.id)"
          >
            {{ g.icon || '📁' }} {{ g.name }}
          </div>
          <div v-if="groupStore.groups.length === 0" class="group-select-empty">
            暂无分组
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 新建对话弹窗 -->
    <NewChatDialog
      v-model:visible="showNewChat"
      @created="handleChatCreated"
    />
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.session-list-header {
  padding: 8px 10px;
  flex-shrink: 0;
}

.new-chat-btn {
  width: 100%;
  border-radius: var(--radius, 6px);
  border-style: dashed;
  font-size: 13px;
}

/* 会话列表 */
.session-list-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.session-list-body::-webkit-scrollbar {
  width: 4px;
}

.session-list-body::-webkit-track {
  background: transparent;
}

.session-list-body::-webkit-scrollbar-thumb {
  background: rgba(144, 147, 153, 0.2);
  border-radius: 2px;
}

.session-empty {
  text-align: center;
  padding: 20px 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  font-size: 12px;
}

/* 分组 */
.group-section {
  margin-bottom: 2px;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius, 6px);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  transition: background 0.15s;
  user-select: none;
}

.group-header:hover {
  background: var(--el-fill-color-light);
}

.group-arrow {
  transition: transform 0.2s ease;
  font-size: 12px;
  flex-shrink: 0;
}

.group-arrow.collapsed {
  transform: rotate(-90deg);
}

.group-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.group-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-count {
  font-size: 11px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  flex-shrink: 0;
}

.group-sessions {
  padding-left: 8px;
}

.group-empty {
  text-align: center;
  padding: 8px 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  font-size: 11px;
}

/* 分组折叠动画 */
.collapse-enter-active,
.collapse-leave-active {
  transition: max-height 0.25s ease, opacity 0.2s ease;
  overflow: hidden;
}

.collapse-enter-from,
.collapse-leave-to {
  opacity: 0;
  max-height: 0;
}

.collapse-enter-to,
.collapse-leave-from {
  opacity: 1;
  max-height: 500px;
}

/* 分割线 */
.section-divider {
  height: 1px;
  background: var(--color-border-subtle);
  margin: 6px 8px;
}

/* 会话项 */
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius, 6px);
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 1px;
}

.session-item:hover {
  background: var(--el-fill-color-light);
}

.session-item.active {
  background: var(--color-accent-blue-subtle, rgba(64, 158, 255, 0.10));
  box-shadow: inset 3px 0 0 var(--color-accent-blue, #409eff);
}

.session-item.active .session-item-title {
  color: var(--color-accent-blue, #409eff);
  font-weight: 600;
}

.session-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.session-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.session-item-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.session-item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
  flex: 1;
  min-width: 0;
}

.session-item-sub {
  font-size: 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-agent-name {
  color: var(--color-text-tertiary, var(--color-text-secondary));
}

.session-model-badge {
  font-size: 11px;
  color: var(--color-accent-blue);
  background: rgba(64, 158, 255, 0.08);
  padding: 0 5px;
  border-radius: 3px;
  font-weight: 500;
}

.session-sub-sep {
  color: var(--color-text-quaternary, var(--color-text-tertiary, var(--color-text-secondary)));
}

.session-time {
  font-size: 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  white-space: nowrap;
  flex-shrink: 0;
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  z-index: 3000;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  box-shadow: var(--el-box-shadow-light);
  padding: 4px 0;
  min-width: 140px;
}

.context-menu-item {
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
  color: var(--color-text);
}

.context-menu-item:hover {
  background: var(--el-fill-color-light);
}

.context-menu-item.danger {
  color: var(--el-color-danger);
}

.context-menu-item.danger:hover {
  background: var(--el-color-danger-light-9);
}

/* 分组选择浮窗 */
.group-select-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
}

.group-select-popup {
  background: var(--el-bg-color);
  border-radius: 8px;
  box-shadow: var(--el-box-shadow);
  padding: 12px 0;
  min-width: 200px;
  max-width: 320px;
}

.group-select-title {
  padding: 4px 16px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--el-border-color-lighter);
  margin-bottom: 4px;
}

.group-select-item {
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
  color: var(--color-text);
}

.group-select-item:hover {
  background: var(--el-fill-color-light);
}

.group-select-empty {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  text-align: center;
}

/* 分区标签 */
.section-label {
  padding: 6px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-tertiary, var(--color-text-secondary));
 text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* 主会话特殊样式 */
.main-session {
  background: rgba(64, 158, 255, 0.04);
  border-left: 3px solid var(--color-accent-blue, #409eff);
}

.main-session:hover {
  background: rgba(64, 158, 255, 0.08);
}

.main-session.active {
  background: rgba(64, 158, 255, 0.14);
  box-shadow: inset 3px 0 0 var(--color-accent-blue, #409eff);
}

.main-session.active .session-item-title {
  color: var(--color-accent-blue, #409eff);
  font-weight: 600;
}

/* 紧凑会话项（最近会话） */
.session-item-compact {
  padding: 5px 10px;
}

.session-item-compact .session-item-title {
  font-size: 12.5px;
  font-weight: 500;
}

.session-item-compact .session-item-sub {
  font-size: 11.5px;
}

/* 底部 */
.session-list-footer {
 padding: 8px 10px;
 flex-shrink: 0;
}

.all-sessions-btn {
  width: 100%;
 padding: 8px;
 border-radius: var(--radius, 6px);
 border: 1px solid var(--color-border-subtle);
 background: var(--color-bg-canvas);
 color: var(--color-text-secondary);
 font-size: 13px;
 cursor: pointer;
 transition: all 0.15s;
 text-align: center;
}

.all-sessions-btn:hover {
 background: var(--el-fill-color-light);
 color: var(--color-text);
 border-color: var(--color-border);
}
</style>
