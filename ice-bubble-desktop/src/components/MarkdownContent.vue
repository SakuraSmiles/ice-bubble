<template>
  <div v-if="content" class="markdown-content" :style="{ maxHeight }">
    <div v-html="renderedContent"></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '@/utils/markdown';

interface Props {
  content: string;
  maxHeight?: string;
}

const props = defineProps<Props>();

const renderedContent = computed(() => renderMarkdown(props.content));
</script>

<style scoped>
.markdown-content {
  overflow-y: auto;
  line-height: 1.6;
  word-break: break-word;
  color: var(--el-text-color-regular);
}

/* ========== 标题：极简直排版，无装饰 ========== */
.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin-top: 1.5em;
  margin-bottom: 0.75em;
  font-weight: 600;
  line-height: 1.25;
  color: var(--el-text-color-primary);
}

.markdown-content :deep(h1) { font-size: 1.6em; }
.markdown-content :deep(h2) { font-size: 1.35em; }
.markdown-content :deep(h3) { font-size: 1.15em; }

/* ========== 段落 ========== */
.markdown-content :deep(p) {
  margin: 0 0 0.5em 0;
}

/* ========== 代码块 ========== */
.markdown-content :deep(pre) {
  background: #282c34;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 16px;
  overflow-x: auto;
  margin: 0.75em 0;
}

.markdown-content :deep(pre code) {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.85em;
  line-height: 1.5;
  padding: 0;
}

/* ========== 行内代码 — GitHub 灰 ========== */
.markdown-content :deep(code:not(pre code)) {
  background: rgba(175, 184, 193, 0.2);
  color: var(--el-text-color-primary);
  padding: 0.2em 0.4em;
  border-radius: 6px;
  font-size: 0.85em;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
}

/* ========== 引用块 — 纯线条，无背景 ========== */
.markdown-content :deep(blockquote) {
  margin: 0.75em 0;
  padding: 0 1em;
  border-left: 0.25em solid var(--el-color-primary);
  color: var(--el-text-color-secondary);
}

.markdown-content :deep(blockquote p) {
  margin: 0.5em 0;
}

/* ========== 表格 — GitHub 极简 ========== */
.markdown-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  border-spacing: 0;
  margin: 1em 0;
  font-size: 0.9em;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 6px 13px;
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--el-fill-color);
  font-weight: 600;
}

.markdown-content :deep(tr:nth-child(even) td) {
  background: var(--el-fill-color);
}

/* ========== 列表 ========== */
.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 2em;
}

.markdown-content :deep(li) {
  margin: 0.25em 0;
}

/* ========== 链接 — 唯一蓝色 ========== */
.markdown-content :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

/* ========== 水平线 ========== */
.markdown-content :deep(hr) {
  border: 0;
  border-bottom: 1px solid var(--el-border-color);
  margin: 1.5em 0;
  background: none;
}

/* ========== 图片 ========== */
.markdown-content :deep(img) {
  max-width: 100%;
  border-radius: 6px;
  box-sizing: border-box;
}

/* ========== 文本样式 ========== */
.markdown-content :deep(strong) { font-weight: 600; }
.markdown-content :deep(em) { font-style: italic; }
</style>
