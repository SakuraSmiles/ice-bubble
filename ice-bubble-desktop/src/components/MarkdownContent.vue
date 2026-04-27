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
}

/* 标题 */
.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin-top: 1em;
  margin-bottom: 0.5em;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-content :deep(h1) { font-size: 1.5em; }
.markdown-content :deep(h2) { font-size: 1.3em; }
.markdown-content :deep(h3) { font-size: 1.1em; }

/* 段落 */
.markdown-content :deep(p) {
  margin: 0 0 0.5em 0;
}

/* 代码块 */
.markdown-content :deep(pre) {
  background-color: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  margin: 0.5em 0;
}

.markdown-content :deep(pre code) {
  font-family: 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.9em;
  background: none;
  padding: 0;
  border-radius: 0;
}

/* 行内代码 */
.markdown-content :deep(code:not(pre code)) {
  background-color: var(--el-color-primary-light-9);
  padding: 2px 4px;
  border-radius: 3px;
  font-size: 0.9em;
}

/* 引用 */
.markdown-content :deep(blockquote) {
  margin: 0.5em 0 0.5em 10px;
  padding: 0.5em 1em;
  border-left: 3px solid var(--el-color-primary);
  background-color: var(--el-fill-color-lighter);
  border-radius: 0 4px 4px 0;
  color: var(--el-text-color-regular);
}

.markdown-content :deep(blockquote p) {
  margin: 0;
}

/* 表格 */
.markdown-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.9em;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--el-border-color-lighter);
  padding: 0.5em 0.75em;
  text-align: left;
}

.markdown-content :deep(th) {
  background-color: var(--el-fill-color-light);
  font-weight: 600;
}

.markdown-content :deep(tr:nth-child(even) td) {
  background-color: var(--el-fill-color-lighter);
}

/* 列表 */
.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.markdown-content :deep(li) {
  margin: 0.25em 0;
}

/* 链接 */
.markdown-content :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

/* 水平线 */
.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--el-border-color-lighter);
  margin: 1em 0;
}

/* 图片 */
.markdown-content :deep(img) {
  max-width: 100%;
  border-radius: 4px;
}

/* 加粗 & 斜体 */
.markdown-content :deep(strong) { font-weight: 600; }
.markdown-content :deep(em) { font-style: italic; }
</style>
