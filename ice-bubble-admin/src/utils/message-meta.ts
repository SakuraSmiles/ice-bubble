/**
 * ice-bubble Admin - 消息元信息分析
 *
 * 从 data-repository.ts 提取，避免 subagent-event-parser 产生循环依赖。
 * 纯函数，不依赖任何模块内部状态。
 */

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
      const cronEnd = content.indexOf(']');
      const afterCron = cronEnd > 0 ? content.substring(cronEnd + 1).trim() : content;
      meta.clean_content = afterCron || content;
    }
    // 检测系统执行通知（System: / System(...) 格式）
    else if (/^System[ :(]/.test(content) && content.length > 10) {
      meta.is_system_noise = true;
      meta.clean_content = content.replace(/^System[ :]\([^)]*\)/g, '').replace(/^System[ :]/g, '').trim() || content.substring(0, 150);
    }
    // 检测 Sender metadata 块（webchat 消息编码）
    else if (content.startsWith('Sender (untrusted metadata)')) {
      const senderMatch = content.match(/```json\s*\{[\s\S]*?"label"\s*:\s*"([^"]+)"[\s\S]*?\}\s*```/);
      if (senderMatch) {
        meta.source_channel = senderMatch[1];
      }
      const pattern = /^Sender \(untrusted metadata\):\n```json\n[\s\S]*?\n```\n*\n*/;
      const afterMeta = content.replace(pattern, '').trim();
      const afterTime = afterMeta.replace(/^\[[^\]]+\]\s*/, '').trim();
      meta.clean_content = afterTime || content;
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
  }

  // 检测 agent 噪音
  if (msg.message_type === 'agent') {
    if (!content || content === 'NULL' || content === '') {
      meta.is_system_noise = true;
      meta.clean_content = '';
    } else if (content === 'HEARTBEAT_OK') {
      meta.is_system_noise = true;
      meta.clean_content = '';
    } else if (/^(暂无活跃子任务|任务状态巡检完成)/.test(content)) {
      meta.is_system_noise = true;
      meta.clean_content = content.substring(0, 100);
    }
  }

  // 检测 tool 空回复
  if (msg.message_type === 'tool' && (!content || content === 'NULL' || content === '' || content === '{}')) {
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
  if (!content || content === 'NULL' || content === '') return true;
  if (content === 'HEARTBEAT_OK' || content === 'NO_REPLY') return true;
  if (messageType === 'user') {
    if (content.startsWith('[cron:')) return true;
    if (/^System[ :(]/.test(content) && content.length > 10) return true;
    if (/^Read HEARTBEAT\.md/.test(content)) return true;
    if (/^(Exec completed|Exec failed)/.test(content)) return true;
    if (/^\[[a-z0-9]+\]/.test(content) &&
        (/(added \d+ files?|modules transformed|built in)/.test(content) ||
         /^(feat|fix|style|refactor|chore|docs|test)\(/.test(content))) {
      return true;
    }
  }
  if (messageType === 'agent') {
    if (content === 'NULL' || content === '') return true;
    if (/^(暂无活跃子任务|任务状态巡检完成)/.test(content)) return true;
  }
  if (messageType === 'tool' && (content === '{}' || content === '[]' || content === 'ok' || content === 'null')) {
    return true;
  }
  return false;
}
