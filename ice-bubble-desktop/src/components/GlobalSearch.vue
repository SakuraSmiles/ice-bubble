<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { Search } from '@element-plus/icons-vue';
import { request } from '../api/client';
import type { SessionDTO, AgentDTO } from '../api/client';

const router = useRouter();

// =========== Props/Emit ===========
const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

// =========== 搜索状态 ===========
const keyword = ref('');
const loading = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

// =========== 搜索结果类型 ===========
interface SearchResult {
  type: 'session' | 'agent';
  title: string;
  subtitle: string;
  /** 跳转路径 */
  to: string;
  /** 匹配内容预览（含高亮标记） */
  matchPreview?: string;
}

const results = ref<SearchResult[]>([]);

// =========== 弹窗打开时自动聚焦并清空 ===========
watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      keyword.value = '';
      results.value = [];
      nextTick(() => inputRef.value?.focus());
    }
  }
);

// =========== 搜索逻辑（防抖） ===========
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw) {
    results.value = [];
    return;
  }

  loading.value = true;
  try {
    const fetched: SearchResult[] = [];

    // 1. 搜索会话（标题 + 最后一条消息内容）
    const sessionsRes = await request(`/sessions/unified?search=${encodeURIComponent(kw)}&limit=10`);
    if (sessionsRes.ok) {
      const data = await sessionsRes.json();
      const sessions: SessionDTO[] = (data as { sessions: SessionDTO[] }).sessions || [];
      for (const s of sessions) {
        const title = s.label || s.agent_name || s.session_key;
        fetched.push({
          type: 'session',
          title,
          subtitle: s.agent_name ? `Agent: ${s.agent_name}` : s.session_key,
          to: `/chat/${encodeURIComponent(s.session_key)}`,
          matchPreview: s.last_message || undefined,
        });
      }
    }

    // 2. 搜索成员
    const agentsRes = await request('/agents');
    if (agentsRes.ok) {
      const data = await agentsRes.json();
      const agents: AgentDTO[] = (data as { agents: AgentDTO[] }).agents || [];
      const kwLower = kw.toLowerCase();
      for (const a of agents) {
        const name = a.agent_name || a.agent_id;
        if (name.toLowerCase().includes(kwLower)) {
          fetched.push({
            type: 'agent',
            title: name,
            subtitle: `活跃会话: ${a.session_count} · 消息: ${a.message_count}`,
            to: `/agents`,
          });
        }
      }
    }

    // 3. 搜索消息内容
    const msgsRes = await request(`/messages/timeline?search=${encodeURIComponent(kw)}&limit=10&exclude_system_noise=true&exclude_cron=true`);
    if (msgsRes.ok) {
      const data = await msgsRes.json();
      const msgs: Array<{ session_key: string; agent_name?: string; content_summary?: string; content?: string; clean_content?: string }> =
        (data as { messages: Array<{ session_key: string; agent_name?: string; content_summary?: string; content?: string; clean_content?: string }> }).messages || [];
      const seenKeys = new Set(fetched.filter(r => r.type === 'session').map(r => r.to));
      for (const m of msgs) {
        const to = `/chat/${encodeURIComponent(m.session_key)}`;
        if (seenKeys.has(to)) continue;
        seenKeys.add(to);
        fetched.push({
          type: 'session',
          title: m.agent_name || m.session_key,
          subtitle: '消息匹配',
          to,
          matchPreview: m.content_summary || m.clean_content || m.content || undefined,
        });
      }
    }

    results.value = fetched;
  } catch (e) {
    console.error('[GlobalSearch] 搜索失败:', e);
  } finally {
    loading.value = false;
  }
}

watch(keyword, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doSearch, 300);
});

// =========== 关闭 ===========
function close() {
  emit('update:modelValue', false);
}

function goTo(item: SearchResult) {
  close();
  // 聊天路由使用 workspace/:key
  if (item.type === 'session') {
    router.push('/workspace/' + encodeURIComponent(item.to.split('/').pop() || ''));
  } else {
    router.push(item.to);
  }
}

// =========== 高亮匹配 ===========
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, ch => map[ch] || ch);
}

function highlightPreview(text: string): string {
  if (!text) return '';
  const escaped = escapeHtml(text);
  const kw = keyword.value.trim();
  if (!kw) return escaped;
  const escapedKw = escapeHtml(kw);
  const regex = new RegExp(escapedKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(regex, m => `<mark>${m}</mark>`);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="search-fade">
      <div v-if="modelValue" class="global-search-overlay" @click.self="close">
        <div class="global-search-dialog">
          <div class="search-input-wrap">
            <el-icon class="search-icon"><Search /></el-icon>
            <input
              ref="inputRef"
              v-model="keyword"
              class="search-input"
              placeholder="输入关键词搜索会话、成员和消息…"
              @keydown.escape="close"
            />
            <kbd class="search-kbd">ESC</kbd>
          </div>

          <!-- 空状态：未输入关键词 -->
          <div v-if="!keyword.trim() && results.length === 0" class="search-empty">
            <span class="empty-icon">🔍</span>
            <span class="empty-text">输入关键词搜索会话、成员和消息</span>
          </div>

          <!-- 加载中 -->
          <div v-if="loading" class="search-loading">
            <el-icon class="is-loading"><Search /></el-icon>
            <span>搜索中…</span>
          </div>

          <!-- 无结果 -->
          <div v-if="!loading && keyword.trim() && results.length === 0" class="search-empty">
            <span class="empty-icon">📭</span>
            <span class="empty-text">未找到匹配结果</span>
          </div>

          <!-- 结果列表 -->
          <div v-if="results.length > 0" class="search-results">
            <div
              v-for="(item, idx) in results"
              :key="idx"
              class="search-item"
              @click="goTo(item)"
            >
              <div class="search-item-header">
                <span class="search-item-tag" :class="item.type">
                  {{ item.type === 'session' ? '会话' : '成员' }}
                </span>
                <span class="search-item-title" v-html="highlightPreview(item.title)" />
              </div>
              <div class="search-item-subtitle">{{ item.subtitle }}</div>
              <div
                v-if="item.matchPreview"
                class="search-item-preview"
                v-html="highlightPreview(item.matchPreview?.slice(0, 120))"
              />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.global-search-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  justify-content: center;
  padding-top: 15vh;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(4px);
}

.global-search-dialog {
  width: 560px;
  max-width: 90vw;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-overlay, #fff);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

/* 输入区 */
.search-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border-subtle, #e1e4e8);
}

.search-icon {
  font-size: 18px;
  color: var(--color-text-tertiary, #8c959f);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 15px;
  color: var(--color-text, #1f2328);
  background: transparent;
  line-height: 1.5;
}

.search-input::placeholder {
  color: var(--color-text-tertiary, #8c959f);
}

.search-kbd {
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid var(--color-border-subtle, #e1e4e8);
  border-radius: 4px;
  background: var(--color-bg-subtle, #f6f8fa);
  color: var(--color-text-tertiary, #8c959f);
  flex-shrink: 0;
}

/* 空状态/加载中 */
.search-empty,
.search-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 8px;
  color: var(--color-text-tertiary, #8c959f);
  font-size: 14px;
}

.empty-icon {
  font-size: 32px;
}

/* 结果列表 */
.search-results {
  overflow-y: auto;
  padding: 8px;
  flex: 1;
  max-height: calc(60vh - 60px);
}

.search-item {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.search-item:hover {
  background: var(--ib-hover-bg, rgba(9, 105, 218, 0.06));
}

.search-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}

.search-item-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
  flex-shrink: 0;
}

.search-item-tag.session {
  background: var(--color-accent-blue-subtle, #ddf4ff);
  color: var(--color-accent-blue, #0969da);
}

.search-item-tag.agent {
  background: var(--color-accent-green-subtle, #dafbe1);
  color: var(--color-accent-green, #1a7f37);
}

.search-item-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text, #1f2328);
}

.search-item-subtitle {
  font-size: 12px;
  color: var(--color-text-tertiary, #8c959f);
  padding-left: 48px;
}

.search-item-preview {
  font-size: 12px;
  color: var(--color-text-secondary, #656d76);
  padding-left: 48px;
  margin-top: 4px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* mark 高亮 */
:deep(mark) {
  background: #fff3bf;
  color: inherit;
  border-radius: 2px;
  padding: 0 2px;
}

/* 过渡动画 */
.search-fade-enter-active {
  transition: opacity 0.15s ease;
}
.search-fade-enter-active .global-search-dialog {
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.search-fade-leave-active {
  transition: opacity 0.1s ease;
}
.search-fade-leave-active .global-search-dialog {
  transition: transform 0.1s ease, opacity 0.1s ease;
}
.search-fade-enter-from {
  opacity: 0;
}
.search-fade-enter-from .global-search-dialog {
  transform: translateY(-12px) scale(0.97);
  opacity: 0;
}
.search-fade-leave-to {
  opacity: 0;
}
.search-fade-leave-to .global-search-dialog {
  transform: translateY(-8px) scale(0.98);
  opacity: 0;
}
</style>
