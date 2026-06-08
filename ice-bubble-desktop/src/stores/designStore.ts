/**
 * Design Store — 设计模块状态管理
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { DesignProject, DesignSSEEvent } from '../api/design';
import * as designApi from '../api/design';

// ============ 内部类型 ============

interface DesignMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface DesignArtifact {
  id: string;
  html: string;
  title: string;
}

// ============ Store ============

export const useDesignStore = defineStore('design', () => {
  // ====== 状态 ======
  const projects = ref<DesignProject[]>([]);
  const currentProjectId = ref<string | null>(null);
  const messages = ref<DesignMessage[]>([]);
  const artifacts = ref<DesignArtifact[]>([]);
  const isStreaming = ref(false);
  const streamText = ref('');
  const activeAbortController = ref<AbortController | null>(null);

  // ====== 计算属性 ======
  const currentProject = computed(() =>
    projects.value.find(p => p.id === currentProjectId.value)
  );

  const sortedArtifacts = computed(() =>
    [...artifacts.value].reverse()
  );

  // ====== 操作 ======

  async function loadProjects() {
    try {
      const res = await designApi.getDesignProjects();
      projects.value = res.projects || [];
    } catch (e) {
      console.warn('[designStore] Failed to load projects:', e);
      projects.value = [];
    }
  }

  async function createProject(name: string, description?: string): Promise<DesignProject> {
    const project = await designApi.createDesignProject({ name, description });
    projects.value.push(project);
    selectProject(project.id);
    return project;
  }

  function selectProject(projectId: string) {
    currentProjectId.value = projectId;
    messages.value = [];
    artifacts.value = [];
    streamText.value = '';
  }

  function sendMessage(message: string): AbortController {
    // 如果有活跃流，先中止
    if (activeAbortController.value) {
      activeAbortController.value.abort();
    }

    isStreaming.value = true;
    streamText.value = '';
    messages.value.push({ role: 'user', content: message, timestamp: Date.now() });

    const controller = designApi.createDesignChat(
      { message, projectId: currentProjectId.value || undefined },
      {
        onEvent: (event) => handleSSEEvent(event),
        onError: (err) => {
          console.error('[designStore] SSE error:', err);
          isStreaming.value = false;
          activeAbortController.value = null;
          // 将错误作为消息显示
          messages.value.push({
            role: 'assistant',
            content: `❌ 请求失败: ${err.message}`,
            timestamp: Date.now(),
          });
        },
        onDone: () => {
          isStreaming.value = false;
          activeAbortController.value = null;
          if (streamText.value) {
            messages.value.push({
              role: 'assistant',
              content: streamText.value,
              timestamp: Date.now(),
            });
            streamText.value = '';
          }
        },
      }
    );

    activeAbortController.value = controller;
    return controller;
  }

  function abortStream() {
    if (activeAbortController.value) {
      activeAbortController.value.abort();
      activeAbortController.value = null;
    }
    isStreaming.value = false;
    // 保存已接收的文本
    if (streamText.value) {
      messages.value.push({
        role: 'assistant',
        content: streamText.value,
        timestamp: Date.now(),
      });
      streamText.value = '';
    }
  }

  function handleSSEEvent(event: DesignSSEEvent) {
    const { sseEvent, data } = event;
    if (!data) return;

    // ── error / end（OD 终端事件） ───────────────────────
    if (sseEvent === 'error') {
      const msg = (data as any).message || (data as any).error?.message || '未知错误';
      messages.value.push({
        role: 'assistant',
        content: `❌ ${msg}`,
        timestamp: Date.now(),
      });
      return;
    }

    if (sseEvent === 'end') {
      // onDone 已经会在流结束时被调用
      return;
    }

    // ── agent 事件（OD 通用事件载体） ───────────────────
    // OD 的 agent 事件 data.type 可能是: status | text_delta | tool_use | tool_result ...
    const dataType = data.type as string | undefined;

    if (sseEvent === 'agent' && dataType === 'text_delta') {
      // OD: { type: 'text_delta', delta: '...' }
      const text = (data as any).delta || (data as any).content || '';
      if (typeof text === 'string') {
        streamText.value += text;
      }
      return;
    }

    if (sseEvent === 'agent' && dataType === 'status') {
      // OD: { type: 'status', label: 'running' } — 忽略，仅状态通知
      return;
    }

    // ── stdout 事件（部分 agent 通过 stdout 直接输出文本） ──
    if (sseEvent === 'stdout') {
      const chunk = (data as any).chunk;
      if (typeof chunk === 'string') {
        streamText.value += chunk;
      }
      return;
    }

    // ── 兼容旧格式: data 中直接带 type 字段 ─────────────
    switch (dataType) {
      case 'text_delta':
        streamText.value += (data as any).delta || (data as any).content || '';
        break;
      case 'artifact':
        artifacts.value.push({
          id: (data as any).artifact_id || `artifact-${Date.now()}`,
          html: (data as any).html || '',
          title: (data as any).title || `Artifact ${artifacts.value.length + 1}`,
        });
        break;
      case 'error':
        messages.value.push({
          role: 'assistant',
          content: `❌ ${(data as any).message || '未知错误'}`,
          timestamp: Date.now(),
        });
        break;
      // done / start / status 等事件无需处理
    }
  }

  return {
    // state
    projects,
    currentProjectId,
    messages,
    artifacts,
    isStreaming,
    streamText,
    // computed
    currentProject,
    sortedArtifacts,
    // actions
    loadProjects,
    createProject,
    selectProject,
    sendMessage,
    abortStream,
  };
});
