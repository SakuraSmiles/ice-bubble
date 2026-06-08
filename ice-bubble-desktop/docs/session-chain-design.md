# Session Chain 技术设计文档

> 状态：待实现  
> 日期：2026-06-08  
> 作者：dev2（评审 + 设计）  
> 实现者：dev1

## 1. 需求概述

**核心问题**：Agent 的对话会分散在多个 session 中（如 `agent:main:main`、`agent:main:webchat:xxx`），用户在 Desktop 中查看某个 session 时，只能看到该 session 内的消息，无法看到同一 agent 的完整对话链。

**目标**：让 Desktop 聊天面板自动跨 session 加载同一 agent 的连续对话，形成"会话链"，用户无需手动切换 session 即可看到完整上下文。

**关键决策回顾**：
- 父子关系判定：基于 **时间连续性 + agent_id + user_msgs ≥ 2（有实质对话）**，而非 parent session key
- 消息硬上限：**1000 条**，超出时淘汰最旧消息
- Session Chain API 由 Admin 后端提供，前端消费

---

## 2. 后端：Session Chain API 设计

### 2.1 新增端点：`GET /api/sessions/chain`

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_key` | string | ✅ | 当前 session key（Gateway 格式或 SQLite 格式均可） |
| `max_chain_length` | number | ❌ | 链中最多包含的 session 数量，默认 5，最大 10 |
| `min_user_messages` | number | ❌ | 判定"有实质对话"的最少 user 消息数，默认 2 |
| `max_gap_hours` | number | ❌ | 允许的最大 session 间隔（小时），默认 24 |

#### 返回结构

```typescript
interface SessionChainResponse {
  /** 当前 session */
  current: ChainSession;
  /** 按时间排列的完整链（从最旧到最新），current 在其中 */
  chain: ChainSession[];
  /** 链中当前 session 的索引（0-based） */
  currentIndex: number;
  /** 是否还有更早的 session 可以链接（用于前端 loadMore） */
  has_older: boolean;
}

interface ChainSession {
  session_key: string;        // SQLite 格式的 session key
  agent_id: string;
  agent_name: string | null;
  avatar: string | null;
  channel: string | null;
  message_count: number;     // user+agent 消息数（不含 system/tool）
  user_message_count: number; // 仅 user 消息数
  first_message_at: string | null;
  last_message_at: string | null;
  first_message: string | null; // 首条 user 消息摘要
  label: string | null;
}
```

#### 父子关系判定算法

```
输入: current_session_key, agent_id
输出: 按时间排序的 session 链

1. 从 admin_sessions 中找出所有 session_key 满足:
   - agent_id = ? (同 agent)
   - session_key NOT LIKE '%.trajectory'
   - session_key NOT LIKE '%.checkpoint'
   - session_key NOT LIKE 'agent:daily-reporter:%'
   - message_count > 1
   
2. 过滤"有实质对话":
   - user_message_count >= min_user_messages (默认 2)
   
3. 时间连续性分组（贪心算法）:
   - 按 last_message_at DESC 排序
   - 从 current session 开始，向前（更早）扩展链：
     - 取链中最早 session 的 first_message_at
     - 如果下一个候选项的 last_message_at 与之的间隔 <= max_gap_hours
     - 且链长度 < max_chain_length
     - 则加入链
   - 同样向后（更新）扩展
   
4. 返回排序后的链（first_message_at ASC）
```

#### SQL 查询设计

```sql
-- 步骤 1: 查同 agent 的所有有实质对话的 session
-- 已有索引: idx_admin_sessions_agent (agent_id)
-- 需要: 额外按 last_message_at 排序 → 复合索引可优化但非必须
--         (数据量级约每 agent 几十个 session，全表扫描 agent 子集足够快)

SELECT 
  s.session_key,
  s.agent_id,
  a.agent_name,
  a.avatar,
  s.channel,
  s.message_count,
  s.first_message_at,
  s.last_message_at,
  s.label,
  -- 计算独立 user 消息数（排除 system 注入）
  (SELECT COUNT(*) FROM admin_messages m
   WHERE m.session_key = s.session_key
     AND m.message_type = 'user'
     AND m.content IS NOT NULL AND m.content != ''
     AND m.content NOT LIKE 'Sender (untrusted metadata)%'
     AND m.content NOT LIKE 'System (untrusted):%'
     AND m.content NOT LIKE 'System:%'
     AND instr(m.content, '[Subagent Context]') = 0
  ) as user_message_count,
  -- 首条实质 user 消息
  (SELECT m.content FROM admin_messages m
   WHERE m.session_key = s.session_key AND m.message_type = 'user'
     AND m.content IS NOT NULL AND m.content != ''
     AND m.content NOT LIKE 'Sender (untrusted metadata)%'
     AND m.content NOT LIKE 'System (untrusted):%'
     AND m.content NOT LIKE 'System:%'
     AND instr(m.content, '[Subagent Context]') = 0
   ORDER BY m.timestamp ASC LIMIT 1
  ) as first_message
FROM admin_sessions s
LEFT JOIN admin_agents a ON a.agent_id = s.agent_id
WHERE s.agent_id = ?
  AND s.session_key NOT LIKE '%.trajectory'
  AND s.session_key NOT LIKE '%.checkpoint'
  AND s.session_key NOT LIKE 'agent:daily-reporter:%'
  AND s.message_count > 1
ORDER BY s.last_message_at DESC
```

> **索引说明**：已有 `idx_admin_sessions_agent` 覆盖 `WHERE agent_id = ?`。`admin_messages` 上已有 `idx_admin_messages_session_type_ts (session_key, message_type, timestamp)`，可高效完成子查询。**无需新建索引**。

#### user_message_count >= 2 验证

此阈值沿用之前评估结论。理由：
- 排除仅 1 条 user 消息的 session（通常是打招呼或系统自动发起的短对话）
- 排除 0 条 user 消息的纯 agent 自动任务
- 2 条 user 消息表明有人类参与的多轮互动

#### 实现位置

- **新文件**: `src/api/data/sessions/chain.ts`
- **注册**: `src/api/data/sessions/index.ts` 中添加 `router.use(createChainRouter(config))`
- **依赖注入**: 通过 `SessionsRouterConfig` 的 `repository` 访问 `Database`

---

### 2.2 增强 Timeline API：支持跨 session 查询

#### 现有端点不变：`GET /api/messages/timeline`

#### 新增参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_keys` | string | ❌ | 逗号分隔的多个 session key，用于跨 session 查询 |
| `limit` | number | ❌ | 跨 session 总消息数上限，默认 50，最大 200 |

> **兼容性**：`session_key`（单）和 `session_keys`（多）互斥。如果同时传，`session_keys` 优先。不传时行为与现有一致。

#### 返回值变更

每条消息已有的 `session_key` 字段天然携带了消息来源 session 信息。**无需修改返回结构**。

前端通过对比消息的 `session_key` 字段来检测是否发生了 session 切换，从而插入分割线。

#### TimelineRepository 修改

在 `getMessagesTimeline` 的 `params` 中新增 `session_keys?: string[]`：

```typescript
// 在 session_key 解析逻辑之前，增加:
if (params.session_keys && params.session_keys.length > 0) {
  const resolvedKeys: string[] = [];
  for (const sk of params.session_keys) {
    const resolved = this.sessionRepo.resolveSessionKey(sk);
    resolvedKeys.push(...resolved);
  }
  const uniqueKeys = [...new Set(resolvedKeys)].filter(k => !k.endsWith('.trajectory'));
  if (uniqueKeys.length === 1) {
    contentConditions.push('m.session_key = ?');
    values.push(uniqueKeys[0]);
  } else if (uniqueKeys.length > 1) {
    contentConditions.push(`m.session_key IN (${uniqueKeys.map(() => '?').join(', ')})`);
    values.push(...uniqueKeys);
  }
}
// 原有的 session_key 单 key 逻辑变为 else 分支
```

> **注意**：tool_calls 查询也需要同步修改，复用相同的 resolvedKeys。

---

## 3. Desktop 前端改动

### 3.1 数据流概览

```
用户打开 session
    ↓
ChatTimeline.onMounted
    ↓
useChatData.loadLatest()
    ├── fetchSessionChain(sessionKey) → 获取链
    ├── 用链中所有 session_key 请求 /messages/timeline?session_keys=...
    ├── 存 chainKeys 到本地状态
    └── 开始正常轮询（基于当前 session）
    ↓
用户滚动到顶部 → loadMore()
    ├── chainCursor: 链中当前位置（向前）
    ├── 如果链中还有更早的 session → 请求该 session 的消息
    ├── 合并到消息列表头部
    └── 插入 session 切换分割线
    ↓
sessions.changed 事件
    ├── 重新 fetchSessionChain
    ├── 如果当前 session 不在链中（agent 新建了 session）→ 自动跟随
    └── 链变化时更新 UI
```

### 3.2 Session Chain 获取

**新增函数位置**：`useChatData.ts` 中新增

```typescript
// 新增状态
const chainSessions = ref<ChainSession[]>([]);  // 链中所有 session
const chainCurrentIndex = ref(-1);              // 当前 session 在链中的位置
const chainHasOlder = ref(false);               // 链前方是否还有更多
const chainCursor = ref(0);                     // loadMore 向前遍历的位置

// 新增类型
interface ChainSession {
  session_key: string;
  agent_id: string;
  agent_name: string | null;
  avatar: string | null;
  channel: string | null;
  message_count: number;
  user_message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  first_message: string | null;
  label: string | null;
}

async function fetchSessionChain(sessionKey: string): Promise<void> {
  try {
    const res = await request(`/sessions/chain?session_key=${encodeURIComponent(sessionKey)}`);
    if (!res.ok) return;
    const data = await res.json();
    chainSessions.value = data.chain || [];
    chainCurrentIndex.value = data.currentIndex;
    chainHasOlder.value = data.has_older;
    chainCursor.value = 0; // reset cursor
  } catch (e) {
    console.warn('[useChatData] fetchSessionChain failed', e);
    // 降级：无 chain 数据，按原有逻辑走
  }
}
```

### 3.3 修改 `loadLatest()` 

在 `loadLatest()` 中，获取 Admin timeline 时使用链：

```typescript
// 原来: const adminUrl = `/messages/timeline?limit=${PAGE_SIZE}&${filters.value}`;
// 改为: 如果有 chain，用 session_keys 查询链中所有 session

async function loadLatest() {
  const sessionKey = getSessionKey();
  const gen = ++generation.value;
  
  // ... (缓存检查逻辑不变)
  
  loading.value = true;
  knownIds.value = new Set();
  idAlias.value = new Map();
  resetAdminCursor();
  
  try {
    // 新增: 先获取 session chain
    if (sessionKey) {
      await fetchSessionChain(sessionKey);
    }
    
    // 构建查询参数
    const chainKeys = chainSessions.value
      .filter(s => s.message_count > 0)
      .map(s => s.session_key);
    
    const useChain = chainKeys.length > 1;
    const queryParams = useChain
      ? `limit=${PAGE_SIZE}&session_keys=${chainKeys.map(k => encodeURIComponent(k)).join(',')}&exclude_system_noise=true&exclude_cron=true&message_types=user,agent`
      : `${filters.value}`; // 原有逻辑
    
    const adminUrl = `/messages/timeline?${queryParams}`;
    // ... 后续逻辑不变
```

### 3.4 修改 `filters` computed

保留原有 `filters` 作为 fallback，新增 `chainFilters`：

```typescript
const chainFilters = computed(() => {
  const chainKeys = chainSessions.value
    .filter(s => s.message_count > 0)
    .map(s => s.session_key);
  if (chainKeys.length <= 1) return null; // 无 chain 或只有当前 session
  
  const agentId = getSessionKey()?.match(/^agent:([^:]+)/)?.[1];
  const parts = [
    `session_keys=${chainKeys.map(k => encodeURIComponent(k)).join(',')}`,
    'exclude_system_noise=true',
    'exclude_cron=true',
    'message_types=user,agent'
  ];
  if (agentId) parts.push(`agent_ids=${agentId}`);
  return parts.join('&');
});
```

在 `pollNewMessages()` 和 `loadMore()` 中优先使用 `chainFilters.value`，为 null 时 fallback 到 `filters.value`。

### 3.5 `loadMore()` 跨 session 扩展

```typescript
async function loadMore() {
  if (loadingMore.value || !hasMore.value || messages.value.length === 0) return;
  
  // 检查硬上限
  if (messages.value.length >= 1000) {
    // 淘汰最旧的消息，保留最新的 800 条，留出 loadMore 的空间
    const trimmed = messages.value.slice(-800);
    messages.value = trimmed;
    // 重建 knownIds（只保留现有消息的 id）
    knownIds.value = new Set(trimmed.map(m => m.id));
  }
  
  loadingMore.value = true;
  const el = containerRef.value;
  const prevScrollTop = el?.scrollTop ?? 0;
  const prevScrollHeight = el?.scrollHeight ?? 0;
  const gen = generation.value;
  
  try {
    // 使用链中的 filters（跨 session）
    const activeFilters = chainFilters.value || filters.value;
    let beforeTs: string;
    if (adminPageCursor) {
      beforeTs = adminPageCursor;
    } else {
      const oldest = messages.value[0].timestamp;
      beforeTs = new Date(new Date(oldest).getTime() - 1).toISOString();
    }
    
    const url = `/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(beforeTs)}&${activeFilters}`;
    const res = await request(url);
    // ... (后续去重、合并逻辑与现有 loadMore 一致)
    
    // 边界检测: chainFilters 存在但 admin 返回空 → 可能链中更早的 session 没有消息
    // 此时 hasMore 根据 data.has_more 判断即可
  } catch { /* 同现有 */ }
  finally {
    loadingMore.value = false;
    await nextTick();
    if (el) {
      const delta = el.scrollHeight - prevScrollHeight;
      el.scrollTop = prevScrollTop + delta;
    }
  }
}
```

### 3.6 Session 切换分割线

**数据结构**：在 `groupedMessages` computed 中，检测相邻消息的 `session_key` 变化：

```typescript
// 在 groupedMessages computed 的日期分割线逻辑之后，添加 session 切换分割线
const withSessionDividers: MsgGroup[] = [];
let lastSessionKey = '';

for (const grp of withDividers) {
  // 检测 session 切换
  if (grp.type !== 'date-divider') {
    const grpSessionKey = grp.messages[0]?.session_key || '';
    if (lastSessionKey && grpSessionKey && grpSessionKey !== lastSessionKey) {
      // 在日期分割线之前（或消息组之前）插入 session 切换分割线
      withSessionDividers.push({
        type: 'session-divider',   // 新类型
        agentId: '',
        agentName: null,
        avatar: null,
        timestamp: grp.timestamp,
        messages: [],
        toolMsgs: [],
        hiddenToolCount: 0,
        sessionLabel: getSessionLabel(grpSessionKey), // 从 chain 中查找 label 或 first_message
        dateLabel: formatDateLabel(grp.timestamp),
      });
    }
    if (grpSessionKey) lastSessionKey = grpSessionKey;
  }
  withSessionDividers.push(grp);
}

function getSessionLabel(sessionKey: string): string {
  const chainSession = chainSessions.value.find(s => s.session_key === sessionKey);
  if (chainSession?.label) return chainSession.label;
  if (chainSession?.first_message) {
    return chainSession.first_message.substring(0, 40) + (chainSession.first_message.length > 40 ? '...' : '');
  }
  // 从 session_key 推断
  const parts = sessionKey.split(':');
  return parts.slice(-2).join(':');
}
```

**types.ts 扩展**：

```typescript
// 在 MsgGroup union type 中新增:
| {
    type: 'session-divider';
    sessionLabel: string;
    dateLabel: string;
    // ... 其他必要字段
  }
```

### 3.7 ChatTimeline.vue 渲染 session-divider

```html
<!-- 在 template 中，date-divider 之后添加 -->
<template v-else-if="grp.type === 'session-divider'" class="session-divider">
  <span class="session-divider-line"></span>
  <span class="session-divider-text">会话切换 · {{ grp.dateLabel }}</span>
  <span class="session-divider-detail">{{ grp.sessionLabel }}</span>
  <span class="session-divider-line"></span>
</template>
```

**样式**：

```css
.session-divider {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 16px 0 8px;
  user-select: none;
}
.session-divider-line {
  width: 100%;
  height: 1px;
  background: var(--el-color-warning-light-5);
}
.session-divider-text {
  font-size: 12px;
  color: var(--el-color-warning);
  font-weight: 500;
}
.session-divider-detail {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### 3.8 `sessions.changed` 事件监听

**位置**：`ChatTimeline.vue` 的 `onMounted` 中（已有 Gateway 订阅）

**逻辑**：

```typescript
// ChatTimeline.vue
let unsubSessionsChanged: (() => void) | null = null;

onMounted(async () => {
  await chatData.loadLatest();
  gwStream.subscribe();
  chatData.checkBottom();
  nextTick(() => chatData.scrollToBottom(false));
  
  // 新增: 监听 session 变化
  unsubSessionsChanged = wsManager.clientRef.on('sessions.changed', async () => {
    const sessionKey = props.sessionKey;
    if (!sessionKey) return;
    
    // 重新获取 chain
    await chatData.fetchSessionChain(sessionKey);
    
    // 检查当前 session 是否仍在链中
    const chain = chatData.chainSessions.value;
    if (chain.length === 0) return;
    
    // 找到链中最后一个 session（最新的）
    const latestSession = chain[chain.length - 1];
    if (latestSession.session_key !== chatData.resolveSessionKeyToAdmin(sessionKey)) {
      // agent 可能创建了新 session → 通知父组件
      emit('sessionChanged', latestSession);
    }
  });
});

onUnmounted(() => {
  gwStream.unsubscribe();
  chatData.stopPolling();
  if (unsubSessionsChanged) { unsubSessionsChanged(); unsubSessionsChanged = null; }
});
```

> **注意**：session key 的自动跟随需要父组件（AllSessions.vue 或 ChatPanel.vue）配合。`sessions.changed` 事件触发后，前端**不会**自动切换当前查看的 session，而是**更新链数据**。如果用户想看最新 session，需要手动切换或通过一个明确的"跳转到最新"提示。

### 3.9 消息合并、去重、排序

**核心原则**：利用已有的 `knownIds` + `idAlias` 机制。

- 跨 session 加载时，每个 session 的消息 ID 前缀为 `admin_${sqlite_id}`，天然不同
- 排序统一按 `timestamp ASC`
- 去重依赖现有的 `findMatchingMessage()` (content-based matching)

**无需额外去重逻辑**，现有机制已足够。

### 3.10 硬上限 1000 条淘汰策略

```typescript
const MAX_MESSAGES = 1000;
const TRIM_TO = 800; // 淘汰到 800 条，留出 200 条 loadMore 空间

function enforceMessageLimit() {
  if (messages.value.length > MAX_MESSAGES) {
    const trimmed = messages.value.slice(-TRIM_TO);
    // 重建 knownIds
    const newKnownIds = new Set<string>();
    for (const m of trimmed) newKnownIds.add(m.id);
    knownIds.value = newKnownIds;
    messages.value = trimmed;
  }
}
```

**调用时机**：
- `loadMore()` 合并新消息之后
- `pollNewMessages()` 合并新消息之后
- `pollNow()` 合并之后

### 3.11 用户发送消息时的 session key 选择

**策略**：用户发送消息时，**始终使用当前选中的 session key**（`props.sessionKey`），不跟随 chain。

理由：
- Gateway 需要精确的 session key 来路由消息
- 用户可能在查看历史 session，但发消息应发到当前活跃 session
- 如果用户选中的就是最新 session，则无冲突

**现有逻辑无需修改**。`ChatPanel.vue` 中发送消息使用的是当前 `selectedSession.session_key`，这已经是正确的行为。

---

## 4. 改动文件清单

### 4.1 Admin 后端（ice-bubble-admin）

| 文件 | 改动 | 预估行数 |
|------|------|----------|
| `src/api/data/sessions/chain.ts` | **新建**。Session Chain API 路由 | ~120 行 |
| `src/api/data/sessions/index.ts` | 注册 chain 路由 | +3 行 |
| `src/storage/repositories/timeline-repository.ts` | `getMessagesTimeline()` 参数新增 `session_keys`，解析多 key 查询 | ~30 行改动 |
| `src/api/data/messages.ts` (或对应 timeline 端点文件) | 透传 `session_keys` 参数到 `TimelineRepository` | +5 行 |

### 4.2 Desktop 前端（ice-bubble-desktop）

| 文件 | 改动 | 预估行数 |
|------|------|----------|
| `src/views/components/chat/useChatData.ts` | 新增 `fetchSessionChain()`、`chainSessions` 等状态、修改 `loadLatest()`/`loadMore()`/`pollNewMessages()` 使用 chainFilters、新增 `enforceMessageLimit()` | ~100 行 |
| `src/views/components/chat/types.ts` | `MsgGroup` union 新增 `session-divider` 类型 | +10 行 |
| `src/views/components/ChatTimeline.vue` | 渲染 `session-divider` UI、监听 `sessions.changed`、emit `sessionChanged` | ~40 行 |
| `src/api/client.ts` | 新增 `fetchSessionChain()` API 方法 | +10 行 |

**总计**：约 **320 行**新增/修改代码。

---

## 5. 兼容性与回滚

### 5.1 破坏性分析

| 改动 | 是否破坏现有功能 | 原因 |
|------|-----------------|------|
| 新增 `GET /api/sessions/chain` | ❌ 无 | 纯新增端点 |
| Timeline API 新增 `session_keys` 参数 | ❌ 无 | 可选参数，不传时行为完全不变 |
| 前端 `useChatData` 修改 | ⚠️ 低风险 | chain 请求失败时 fallback 到原有逻辑 |
| 前端新增 `session-divider` UI | ❌ 无 | 新增渲染分支，不影响已有消息渲染 |

### 5.2 回滚方案

1. **后端回滚**：
   - 删除 `src/api/data/sessions/chain.ts`
   - 从 `index.ts` 移除 chain 路由注册
   - `TimelineRepository` 中 `session_keys` 参数可选，不删除也不影响
   
2. **前端回滚**：
   - `useChatData.ts` 中 `fetchSessionChain()` 失败时自动降级（已在设计中体现）
   - 删除 `session-divider` 相关的模板和样式
   - 恢复 `loadLatest()` 为原始逻辑

3. **一键开关**（推荐实现）：
   ```typescript
   // config/index.ts
   export const FEATURES = {
     sessionChain: true, // 设为 false 可全局关闭
   };
   ```

---

## 6. 实现顺序建议

1. **Phase 1 — 后端**（dev1 优先）
   - 实现 `GET /api/sessions/chain`
   - 增强 `TimelineRepository` 支持 `session_keys`
   - 用 curl/Postman 验证

2. **Phase 2 — 前端核心**（dev1）
   - `useChatData` 中实现 chain 获取和跨 session 查询
   - 修改 `loadLatest()` 使用 chain

3. **Phase 3 — 前端 UI**（dev1）
   - `session-divider` 渲染
   - `sessions.changed` 监听
   - 硬上限淘汰

4. **Phase 4 — 联调 + 边界测试**
   - 测试 agent 有多个 session 的场景
   - 测试 chain 请求失败的降级
   - 测试消息 1000 条上限

---

## 7. 附录：设计决策 Q&A

**Q: 为什么不用 parent session key 来建立链？**  
A: OpenClaw 的 session 创建机制中，新 session 不一定记录 parent。Agent 可以因各种原因（配置变更、crash 恢复、手动创建）产生新 session，这些场景下 parent 关系不可靠。基于时间连续性 + agent_id 的判定更健壮。

**Q: 为什么 max_gap_hours 默认 24？**  
A: 同一 agent 的连续对话通常在 24 小时内。超过 24 小时的间隔更可能是独立对话，不应强制串联。用户可通过参数调整。

**Q: chain 请求失败时怎么办？**  
A: 降级到原有行为——只查当前 session_key 的消息。前端通过 try/catch + chainKeys.length === 0 来检测。

**Q: 消息 1000 条上限是否太低？**  
A: 对于日常聊天场景足够。如果用户需要查看更多历史，应通过 AllSessions 页面选择具体 session 查看，而非在单次聊天面板中无限加载。
