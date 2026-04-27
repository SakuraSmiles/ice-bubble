/**
 * ice-bubble Admin - 消息元信息分析
 *
 * 从 data-repository.ts 提取，避免 subagent-event-parser 产生循环依赖。
 * 纯函数，不依赖任何模块内部状态。
 *
 * 模块化拆分：
 * - detect-cron: cron 任务检测
 * - detect-channel: 来源渠道检测
 * - detect-system-noise: 系统噪音检测
 */

// ==================== 子模块导入（内部使用 + 重新导出）====================

import {
  isCronMessage,
  extractCronContent,
} from './detect-cron';
import {
  hasSenderMetadata,
  extractSourceChannel,
  extractContentAfterSenderMetadata,
} from './detect-channel';
import {
  isUserSystemNoise,
  cleanUserContent,
  isAgentSystemNoise,
  isToolSystemNoise,
} from './detect-system-noise';

// 重新导出供外部使用

export {
  isCronMessage,
  extractCronContent,
  hasSenderMetadata,
  extractSourceChannel,
  extractContentAfterSenderMetadata,
  isUserSystemNoise,
  cleanUserContent,
  isAgentSystemNoise,
  isToolSystemNoise,
};

// ==================== 接口定义 ====================

/**
 * 消息元信息（不存储在 DB，运行时计算）
 */
export interface MessageMeta {
  is_cron: boolean;
  is_system_noise: boolean;
  clean_content: string;
  content_summary: string;
  source_channel: string | null;
}

// ==================== 主分析函数 ====================

/**
 * 分析消息元信息：系统噪音、cron 标记、内容清洗等
 */
export function analyzeMessageMeta(msg: {
  message_type: string;
  content: string | null;
  agent_name: string;
}): MessageMeta {
  const content = msg.content || '';
  const meta: MessageMeta = {
    is_cron: false,
    is_system_noise: false,
    clean_content: content,
    content_summary: '',
    source_channel: null,
  };

  if (msg.message_type === 'user') {
    // 检测定时任务
    if (content.startsWith('[cron:')) {
      meta.is_cron = true;
      meta.is_system_noise = true;
      meta.clean_content = extractCronContent(content);
    }
    // 检测系统执行通知（System: / System(...) 格式）
    else if (/^System[ :(]/.test(content) && content.length > 10) {
      meta.is_system_noise = true;
      meta.clean_content = content.replace(/^System[ :]\([^)]*\)/g, '').replace(/^System[ :]/g, '').trim() || content.substring(0, 150);
    }
    // 检测 Sender metadata 块（webchat 消息编码）
    else if (hasSenderMetadata(content)) {
      meta.source_channel = extractSourceChannel(content);
      meta.clean_content = extractContentAfterSenderMetadata(content);
    }
    // 处理仅有 [date] 前缀的消息（OpenClaw 上下文重建产生的截断版，缺少 Sender metadata）
    else if (/^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[^\]]*\] /.test(content)) {
      const afterDate = content.replace(/^\[[^\]]+\]\s*/, '').trim();
      if (afterDate === 'HEARTBEAT_OK' || afterDate === 'NO_REPLY' || !afterDate) {
        meta.is_system_noise = true;
        meta.clean_content = '';
      } else {
        meta.is_system_noise = true;
        meta.clean_content = afterDate;
      }
    }
    // 检测 HEARTBEAT_OK / NO_REPLY
    else if (content === 'HEARTBEAT_OK' || content === 'NO_REPLY') {
      meta.is_system_noise = true;
    }
    // 检测 heartbeat 轮询（Read HEARTBEAT.md）
    else if (/^Read HEARTBEAT\.md/.test(content)) {
      meta.is_system_noise = true;
      meta.clean_content = content.substring(0, 100);
    }
    // 检测异步执行命令完成/失败通知
    else if (/^(Exec completed|Exec failed)/.test(content)) {
      meta.is_system_noise = true;
      meta.clean_content = content.substring(0, 100);
    }
    // 检测 git commit 输出 / 编译输出
    else if (/^\[[a-z0-9]+\]/.test(content) &&
             (/(added \d+ files?|modules transformed|built in)/.test(content) ||
              /^(feat|fix|style|refactor|chore|docs|test)\(/.test(content))) {
      meta.is_system_noise = true;
      meta.clean_content = content.substring(0, 100);
    }
    // 检测异步命令完成通知
    else if (content.startsWith('An async command completion event was triggered')) {
      meta.is_system_noise = true;
      meta.clean_content = '';
    }
    // 检测预压缩内存写入
    else if (content.startsWith('Pre-compaction memory flush')) {
      meta.is_system_noise = true;
      meta.clean_content = '';
    }
    // 检测 OpenClaw 内部上下文块
    else if (content.startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) {
      meta.is_system_noise = true;
      meta.clean_content = '';
    }
  }

  // 检测 agent 噪音
  if (msg.message_type === 'agent') {
    if (isAgentSystemNoise(content)) {
      meta.is_system_noise = true;
      meta.clean_content = '';
    } else if (/^(暂无活跃子任务|任务状态巡检完成)/.test(content)) {
      meta.is_system_noise = true;
      meta.clean_content = content.substring(0, 100);
    }
  }

  // 检测 tool 空回复
  if (msg.message_type === 'tool' && isToolSystemNoise(content)) {
    meta.is_system_noise = true;
    meta.clean_content = '';
  }

  // 生成 content_summary
  if (meta.clean_content) {
    if (msg.message_type === 'tool') {
      meta.content_summary = meta.clean_content.substring(0, 60) + (meta.clean_content.length > 60 ? '...' : '');
    } else {
      meta.content_summary = meta.clean_content.substring(0, 120);
    }
  }

  return meta;
}

/**
 * 快速判断消息是否为系统噪音（用于 shouldSkip）
 * 不需要 clean_content / content_summary 时使用更轻量的版本
 */
export function isSystemNoise(messageType: string, content: string | null): boolean {
  if (messageType === 'user') return isUserSystemNoise(content || '');
  if (messageType === 'agent') return isAgentSystemNoise(content);
  if (messageType === 'tool') return isToolSystemNoise(content);
  return false;
}
