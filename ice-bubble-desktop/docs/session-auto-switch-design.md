# Session 自动切换跟随 技术设计文档

> 状态：待实现  
> 日期：2026-06-08  
> 作者：dev1  
> 实现范围：Desktop 前端

---

## 1. 需求概述

### 问题

OpenClaw Agent 在处理长对话时，上下文超过 token 限制后会自动创建新 session（如 `agent:main:main` → `agent:main:subagent:xxx` 或全新的 `agent:main:webchat:uuid`）。此时 Desktop 仍停在旧 session 的 SSE 监听和 Admin 轮询上，导致：

1. **消息丢失**：SSE 实时流订阅的是旧 session key，新 session 的新消息无法到达 Desktop
2. **轮询盲区**：Admin 轮询仅查旧 session 的 timeline，看不到新 session 的消息
3. **用户困惑**：用户以为 Agent 卡死了，实际在新 session 中继续回复

### 目标

Desktop 能自动检测到当前关注的 session 已被链上的新 session 替代，并自动切换到新 session，使用户无需手动操作即能继续对话。

---

## 2. 核心数据来源分析

### 2.1 `sessions.changed` 事件格式

Gateway 在 session 创建/状态变化时广播 `sessions.changed` 事件。经过 Admin 的 WS 代理，Desktop 收到的 payload 格式如下：

```typescript
interface SessionsChangedPayload {
  /** 发生变化的 session key（Gateway 格式，如 agent:main:main） */
  sessionKey: string;
  /** 变化原因："create" | "send" | "status" | "abort" 等 */
  reason?: string;
  /** 时间戳 */
  ts: number;
  
  // ── session 行信息（从 Gateway 存储读取）──
  /** 父 session key — 自动切换的关键字段 */
  parentSessionKey?: string;
  /** 子 session keys */
  childSessions?: string[];
  /** session 标签 */
  label?: string;
  /** session 状态 */
  status?: string;
  /** 是否有活跃 run */
  hasActiveRun?: boolean;
  /** 会话来源 */
  channel?: string;
  /** agent ID（仅 global session 时有值） */
  agentId?: string;
  
  // ... 更多字段（model, tokens, thinkingLevel 等，此处省略）
}
```

**关键字段**：`parentSessionKey` — 如果新 session 的 `parentSessionKey === 当前关注的 sessionKey`，说明当前 session 产生了子 session，需要切换。

### 2.2 Session Chain API（已设计）

Session Chain API（`/api/sessions/chain`）返回同一 agent 的时间连续 session 链：

```typescript
interface SessionChainResponse {
  current: ChainSession;
  chain: ChainSession[];       // 按 first_message_at ASC 排序
  currentIndex: number;
  has_older: boolean;
}
```

通过对比 `sessions.changed` 中的 `sessionKey` 是否在链的最末尾，可以判断是否需要跟随。

---

## 3. 自动跟随判定逻辑

### 3.1 判定条件

满足以下**全部**条件时触发自动跟随：

1. **当前不是"最新" session**：`chainSessions` 中当前 session 不是链的最末尾（`currentIndex < chain.length - 1`），或有新的 session 被追加到链尾
2. **新 session 是 Agent 自动创建的**：`sessions.changed` 事件的 `reason === "create"`
3. **新 session 在链的末尾**：通过 fetchSessionChain 刷新后，chain 末尾比之前多了一个 session
4. **用户没有主动切换过 session**：用户手动选择了某个 session 后，不应自动跟随（详见 3.3）

### 3.2 不触发跟随的条件

| 条件 | 原因 |
|------|------|
| `reason === "send"` | 只是发送消息，不是创建新 session |
| `reason === "status"` | 状态变化，不涉及 session 切换 |
| 新 session 的 `parentSessionKey !== 当前 sessionKey` | 不是从当前 session 派生的 |
| 用户正在手动切换 | 用户操作优先 |
| Agent 正在流式回复中（`isProcessing === true`） | 避免在 streaming 中间打断 |

### 3.3 用户交互保护

用户主动操作后，**禁用自动跟随**直到下一次路由变化：

```typescript
// 在 Workspace.vue 中维护
const autoFollowEnabled = ref(true);

// 用户通过 SessionSelector 手动切换时
function onSessionSelect(sessionKey: string) {
  autoFollowEnabled.value = false;  // 禁用自动跟随
  router.push('/workspace/' + encodeURIComponent(sessionKey));
}

// 路由变化时重新启用
watch(() => route.path, () => {
  autoFollowEnabled.value = true;
});
```

---

## 4. 实现方案

### 4.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                     Workspace.vue                        │
│  ┌─────────────┐  ┌───────────────┐  ┌───────────────┐ │
│  │ SessionSelector│  │ ChatTimeline  │  │ 输入区        │ │
│  └──────┬──────┘  └───────┬───────┘  └───────────────┘ │
│         │                 │                              │
│         │   sessionKey    │  sessions.changed 事件       │
│         │   双向绑定       │  监听 + auto-follow 逻辑     │
│         ▼                 ▼                              │
│  ┌──────────────────────────────────────────────────┐   │
│  │           auto-follow 状态机                      │   │
│  │  autoFollowEnabled / pendingAutoSwitch            │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 4.2 实现步骤

#### Step 1: ChatTimeline 增强 `sessions.changed` 监听

位置：`src/views/components/ChatTimeline.vue`

当前已有的监听仅调用了 `fetchSessionChain`，需要增加发射事件：

```typescript
// ChatTimeline.vue — 修改 sessions.changed 回调
unsubSessionsChanged = wsManager.clientRef.on('sessions.changed', async (payload: unknown) => {
  if (!props.sessionKey) return;
  
  const data = payload as { 
    sessionKey?: string; 
    reason?: string;
    parentSessionKey?: string;
  };
  
  // 保存变更前的 chain 状态
  const prevChainLength = chatData.chainSessions.value.length;
  
  // 刷新 chain
  await chatData.fetchSessionChain(props.sessionKey);
  
  const chain = chatData.chainSessions.value;
  if (chain.length === 0) return;
  
  // 找到发生变化的 session
  const changedSessionKey = data.sessionKey;
  
  // 检查是否需要自动跟随
  const currentIndex = chain.findIndex(
    s => s.session_key === chatData.resolveSessionKeyToAdmin?.(props.sessionKey!)
  );
  
  // 判定条件：
  // 1. 新 session（reason === "create"）
  // 2. 当前 session 在链中部（不是最末尾）
  // 3. 链尾 session 不为空且有新变化
  if (
    data.reason === 'create' &&
    currentIndex >= 0 &&
    currentIndex < chain.length - 1 &&
    changedSessionKey
  ) {
    const latestInChain = chain[chain.length - 1];
    // 发出的 changed session 就是链尾的最新 session
    if (latestInChain.session_key === changedSessionKey ||
        latestInChain.session_key === props.sessionKey) {
      // 发出通知给父组件
      emit('sessionChainAdvanced', {
        newSessionKey: latestInChain.session_key,
        oldSessionKey: props.sessionKey,
        reason: 'agent_created_new_session',
      });
    }
  }
});
```

需要新增 emit：

```typescript
const emit = defineEmits<{
  (e: 'sessionChainAdvanced', payload: { 
    newSessionKey: string; 
    oldSessionKey: string; 
    reason: string;
  }): void;
}>();
```

#### Step 2: Workspace.vue 处理自动跟随

位置：`src/views/Workspace.vue`

```typescript
// 新增状态
const autoFollowEnabled = ref(true);       // 用户手动切换后禁用
const pendingAutoSwitch = ref<string | null>(null);  // 等待切换的目标 session key
const lastAutoSwitchTime = ref(0);          // 防止短时间内多次切换

// 监听 ChatTimeline 的 sessionChainAdvanced 事件
function onSessionChainAdvanced(payload: { 
  newSessionKey: string; 
  oldSessionKey: string; 
  reason: string;
}) {
  // 保护：用户手动切换后不自动跟随
  if (!autoFollowEnabled.value) return;
  
  // 保护：3 秒内不重复切换
  if (Date.now() - lastAutoSwitchTime.value < 3000) return;
  
  // 保护：agent 正在处理时不切换（等 chat.final 后再切）
  if (isAgentProcessing.value) {
    // 暂存，等处理完再切
    pendingAutoSwitch.value = payload.newSessionKey;
    return;
  }
  
  // 执行切换
  performAutoSwitch(payload.newSessionKey);
}

function performAutoSwitch(newSessionKey: string) {
  lastAutoSwitchTime.value = Date.now();
  pendingAutoSwitch.value = null;
  
  // 更新当前 session 映射
  const agentKey = getAgentKey(selectedAgent.value);
  agentSessionMap[agentKey] = newSessionKey;
  
  // 更新 localStorage（main agent）
  if (selectedAgent.value.agent === 'main' && selectedAgent.value.platform === 'openclaw') {
    setMainSessionKey(newSessionKey);
  }
  
  // 导航到新 session
  router.replace('/workspace/' + encodeURIComponent(newSessionKey));
}
```

**触发 pendingAutoSwitch 的时机**：在 `isAgentProcessing` 变为 `false` 时检查：

```typescript
// 在 Workspace.vue 中 watch isAgentProcessing
watch(isAgentProcessing, (newVal, oldVal) => {
  // 从 processing → idle，检查是否有待处理的切换
  if (oldVal && !newVal && pendingAutoSwitch.value && autoFollowEnabled.value) {
    // 延迟 500ms，等 chat.final 的 pollNow 完成
    setTimeout(() => {
      if (pendingAutoSwitch.value) {
        performAutoSwitch(pendingAutoSwitch.value);
      }
    }, 500);
  }
});
```

#### Step 3: 路由监听恢复跟随

```typescript
// 在 Workspace.vue 的路由 watch 中
watch(() => route.path, async () => {
  // ... 现有逻辑 ...
  
  // 恢复自动跟随（用户可能是手动切的）
  if (!urlSessionKey.value) return; // /chat 路由不处理
  
  // 如果是从 pendingAutoSwitch 触发的导航，保持 enabled
  // 否则检查是否用户手动切换
  if (pendingAutoSwitch.value && 
      urlSessionKey.value === pendingAutoSwitch.value) {
    // 自动切换触发，保持 enabled
    return;
  }
  
  // 用户可能通过 URL 直接访问或从浏览器前进/后退触发
  // 不在此处修改 autoFollowEnabled，由步骤 3.3 的逻辑处理
}, { immediate: true });
```

#### Step 4: SessionSelector 手动切换标记

位置：`src/views/components/SessionSelector.vue`

SessionSelector 需要 emit 用户手动切换事件：

```typescript
// 新增 emit
const emit = defineEmits<{
  (e: 'update:modelValue', sessionKey: string): void;
  (e: 'refresh'): void;
  (e: 'manualSwitch', sessionKey: string): void;  // 新增
}>();

// 在 handleSelect 中
function handleSelect(val: string) {
  emit('update:modelValue', val);
  emit('manualSwitch', val);  // 标记为用户手动切换
}
```

然后在 Workspace.vue 中响应：

```typescript
function onManualSessionSwitch(sessionKey: string) {
  autoFollowEnabled.value = false;
  pendingAutoSwitch.value = null;  // 取消任何待处理的自动切换
}
```

#### Step 5: 用户发送消息时保持跟随

用户发送消息时，应确保使用的是正确的 session key。当前逻辑已使用 `activeSessionKey`，如果自动跟随已完成切换，`activeSessionKey` 自然指向新 session。**无需额外修改**。

---

## 5. Session 切换时的数据流

### 5.1 切换过程中的消息处理

当自动切换发生时：

1. **旧 session 消息保留**：`ChatTimeline` 的 key 绑定到 `timelineKey`，`timelineKey` 在切换时会变化（因为 URL 变了），导致 ChatTimeline 组件**重建**

2. **消息不丢失**：
   - 切换前，`useChatData` 的消息缓存通过 `messageCache`（`syncCache()`）写入 `localStorage`
   - 切换后，新 ChatTimeline 实例的 `loadLatest()` 会：
     - 检查缓存（`messageCache.get(sessionKey)`）— **不会命中**，因为 session key 不同
     - 但 chain 加载会包含新旧两个 session，timeline API 用 `session_keys` 查询
     - 因此新 ChatTimeline 仍然能看到旧 session 的消息

3. **视觉体验**：用户看到的是一个消息列表，包含了旧 session 和新 session 的消息，中间用 `session-divider` 分割线分开。就像翻了一页书。

### 5.2 SSE 重连

ChatTimeline 重建时会重新执行 `onMounted`：
- `gwStream.subscribe()` 重新订阅 SSE 事件
- 订阅的 `sessionKey` 是新的 session key
- 轮询目标也自动切换到新 session

### 5.3 轮询切换

- `useChatData` 的 `startPolling()` 中的 `getSessionKey()` 返回新的 session key
- `chainFilters` computed 会自动包含新的 session
- 轮询 URL 自动指向新 session 的 timeline

---

## 6. 边界情况处理

### 6.1 Agent 在 streaming 中创建新 session

这种情况**不应该**发生（compaction 在 run 结束前不会触发），但作为防御：

- `pendingAutoSwitch` 机制确保在 `isProcessing` 变为 `false` 后才切换
- 如果在 streaming 中收到 `sessions.changed`，暂存到 `pendingAutoSwitch`

### 6.2 连续多次 session 创建

- `lastAutoSwitchTime` 防护：3 秒内不重复切换
- 如果 3 秒内收到多次事件，使用最后一次的 `newSessionKey`

### 6.3 用户快速手动切换后又切回

- `autoFollowEnabled` 在用户手动切换时设为 `false`
- 下次路由变化时恢复 `true`（路由监听处理）

### 6.4 网络抖动导致的事件重复

- 使用 `prevChainLength` 对比，确保只在 session 链真正变化时才处理
- 去重逻辑在 `fetchSessionChain` 内部

### 6.5 Session Chain API 不可用

- 如果 `fetchSessionChain` 失败，不触发自动跟随
- 降级到原有行为（用户必须手动发现新 session）

---

## 7. 改动文件清单

| 文件 | 改动 | 预估行数 |
|------|------|----------|
| `src/views/components/ChatTimeline.vue` | 增强 `sessions.changed` 监听，新增 `sessionChainAdvanced` emit | ~25 行 |
| `src/views/Workspace.vue` | 新增 `autoFollowEnabled`/`pendingAutoSwitch` 状态机、`onSessionChainAdvanced` 处理函数、`watch(isAgentProcessing)` | ~60 行 |
| `src/views/components/SessionSelector.vue` | 新增 `manualSwitch` emit | ~5 行 |

**总计**：约 **90 行** 新增代码。

**注意**：Session Chain API 后端改动（约 160 行）已在 session-chain-design.md 中设计，此处不再重复。

---

## 8. 实现顺序

### Phase 1 — ChatTimeline 增强（dev1）
- 修改 `sessions.changed` 回调：检测 chain 变化 + emit `sessionChainAdvanced`
- 验证：console.log 确认 emit 正确触发

### Phase 2 — Workspace 状态机（dev1）
- 实现 `autoFollowEnabled` / `pendingAutoSwitch` / `lastAutoSwitchTime`
- 实现 `onSessionChainAdvanced` → `performAutoSwitch`
- 实现 `watch(isAgentProcessing)` → 延迟切换
- 验证：手动操作 → 自动切换 → 切回 → 再自动切换的完整流程

### Phase 3 — SessionSelector 整合（dev1）
- 新增 `manualSwitch` emit
- Workspace 响应：`autoFollowEnabled = false`

### Phase 4 — 边界测试
- Agent 创建新 session 时自动跟随
- 用户手动切换后不跟随
- 连续多次 session 创建
- Session Chain API 失败时的降级

---

## 9. 测试用例

| # | 场景 | 预期行为 |
|---|------|----------|
| 1 | Agent 上下文过长 → 自动创建新 session | Desktop 自动切换到新 session，消息列表包含两个 session 的消息 + 分割线 |
| 2 | 用户在自动切换后手动切回旧 session | 正常显示旧 session，不再自动跟随 |
| 3 | 用户切回旧 session 后，agent 又创建了新 session | **不跟随**（autoFollowEnabled=false） |
| 4 | 用户通过 SessionSelector 手动选择其他 session | **不跟随** |
| 5 | 用户刷新页面，回到 /chat | autoFollowEnabled 恢复 true |
| 6 | Session Chain API 返回 500 | 降级，不触发自动跟随 |
| 7 | Agent streaming 期间收到 sessions.changed | 暂存，streaming 结束后再切换 |
| 8 | 3 秒内收到多次 sessions.changed | 使用最后一次的 newSessionKey |

---

## 10. 附录：关键设计决策

### Q: 为什么不直接用 `parentSessionKey` 来切换？

A: `sessions.changed` 事件中的 `parentSessionKey` 是可靠的，但仅依赖它有两个问题：
1. 如果 Desktop 错过了 `create` 事件（如断连期间），后续收到 `status/send` 事件时也可能需要跟随
2. Session Chain API 提供的 `chain` 是时间连续性保证，可以与 `parentSessionKey` 交叉验证

因此方案使用 Session Chain（时间连续性 + 链尾检测）作为主判定逻辑，`sessions.changed` 的 `reason === 'create'` 和 `sessionKey` 作为触发信号。

### Q: 为什么不自动订阅新 session 的 SSE 而不切换 URL？

A: 如果只换 SSE 订阅不换 URL，会出现：
- 轮询还在旧 session 上（需额外改 poll 逻辑）
- 用户发送消息时 `activeSessionKey` 是旧的（需额外改发送逻辑）
- 页面刷新后回到旧 session（URL 没变）

URL 导航是最干净的方案，保持单一状态来源。

### Q: 自动切换会不会让用户困惑？

A: 有两个缓解措施：
1. Session-divider 分割线清晰标注了"会话切换"点
2. 用户可以随时通过 SessionSelector 切回旧 session
3. 用户手动切换一次后，自动跟随即被禁用
