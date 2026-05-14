import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';

// 仅注册常用语言（tree-shaking 友好）
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import sql from 'highlight.js/lib/languages/sql';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml'; // HTML
import markdown from 'highlight.js/lib/languages/markdown';
import shell from 'highlight.js/lib/languages/shell';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('shell', shell);

// 配置 marked
marked.setOptions({
  gfm: true,
  breaks: true,
});

// 自定义 code renderer 注入语法高亮
const renderer = new Renderer();
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const highlighted = hljs.highlight(text, { language: lang }).value;
      return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    } catch (_e) { void _e; }
  }
  // 尝试自动检测
  try {
    const highlighted = hljs.highlightAuto(text).value;
    return `<pre><code class="hljs">${highlighted}</code></pre>`;
  } catch {
    return `<pre><code>${text}</code></pre>`;
  }
};

marked.setOptions({ renderer });

// LRU 缓存（最多 200 条）
const cache = new Map<string, string>();
const MAX_CACHE = 200;

export function renderMarkdown(content: string): string {
  if (!content) return '';
  content = content.trim();

  // 命中缓存
  const cached = cache.get(content);
  if (cached !== undefined) return cached;

  // 解析 + 清洗
  const raw = marked.parse(content, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw);

  // LRU 淘汰
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(content, clean);

  return clean;
}

export function clearMarkdownCache(): void {
  cache.clear();
}
