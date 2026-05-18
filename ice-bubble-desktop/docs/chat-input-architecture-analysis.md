# 聊天输入框优化分析 — 代码架构 + 可维护性

> 分析时间：2026-05-16
> 分析者：三宝（dev3）

---

## 一、当前架构问题诊断

### 1.1 输入框分裂（最严重）

| | `Workspace.vue` 内联输入框 | `MessageInput.vue` 组件 |
|---|---|---|
| **位置** | `Workspace.vue` template | `components/MessageInput.vue` |
| **状态** | ✅ 正在使用 | ❌ 未被导入 |
| **功能** | 文本输入 + 附件上传 + 拖拽 + 手动 resize | 文本输入 + 中止按钮 + streaming 视觉反馈 |
| **streaming 支持** | ❌ 无 | ✅ `streaming` prop → 中止按钮 + 红色虚线边框 |
| **loading 支持** | ❌ 仅 `sending` ref | ✅ `loading` prop → 输入框遮罩 + spinner |
| **维护成本** | 两套代码并存，修改一个需改另一个 | 孤立组件，越改越偏离实际使用 |

**根因**：`MessageInput.vue` 可能是先开发的组件，后来 `Workspace.vue` 因需要附件上传、拖拽等功能，直接内联了一套简化实现，但没有整合进组件。

### 1.2 状态断裂（影响用户体验）

```
Workspace.vue                    ChatTimeline.vue
├── sending: ref(false)          ├── useChatData()
│   └── 仅标记"我在发请求"        │   └── showTypingIndicator: ref(false)
│                                └── useGatewayStream()
│                                    └── 内部知道 streaming 状态
│                                        但无法传递出去！
```

**问题链**：
1. `useGatewayStream` 内部处理 `chat:delta`/`chat:final`/`chat:error` 事件，完全知道 Agent 是否在 streaming
2. `showTypingIndicator` 在 `useChatData` 中，仅控制打字指示器 UI
3. `Workspace.vue` 的 `sending` 只在 HTTP 请求期间为 true，Gateway WS 模式下发完消息就立即 false
4. **结果**：Agent 正在流式输出时，输入框没有中止按钮，没有禁用，用户可能重复发送

### 1.3 Workspace.vue 职责爆炸（~600 行）

```
Workspace.vue 当前职责：
├── 页面路由管理 (list/chat/loading 视图切换)
├── 会话自动查找 & 跳转
├── 会话选择处理
├── 输入框逻辑 (textarea + resize + drag)
├── 附件管理 (add/remove/clear/preview)
├── 文件选择 & paste & drag-drop 事件
├── 消息发送 (Gateway WS + HTTP fallback)
└── optimistic message 更新
```

单文件包含 8 个互不相关的职责，违反单一职责原则。

---

## 二、架构改进方案

### 2.1 目标架构

```
Workspace.vue（页面容器，~150 行）
├── 路由状态管理（list/chat/loading）
├── 会话自动查找 & 选择
└── ChatView.vue（聊天子视图）

ChatView.vue（聊天视图，~120 行）
├── ChatTimeline.vue（消息列表）
├── ChatInputArea.vue（输入区域 — 新组件）
└── useAgentActivity()（共享 Agent 活动状态）

ChatInputArea.vue（输入区域 — 替代 Workspace 内联实现）
├── ChatInputBox.vue（复用/改进 MessageInput.vue）
├── AttachmentBar.vue（附件预览/管理）
├── useAttachmentManager()（附件逻辑 composable）
└── useMessageSender()（发送逻辑 composable）
```

### 2.2 核心设计决策

#### 决策 1：`useAgentActivity` composable — 统一 Agent 活动状态

```typescript
// composables/useAgentActivity.ts
export function useAgentActivity(sessionKey: Ref<string | undefined>) {
  const isProcessing = ref(false)     // Agent 是否在处理（统一状态）
  const currentRunId = ref<string | null>(null)
  const streamState = ref<'idle' | 'thinking' | 'streaming' | 'error'>('idle')

  // 监听 Gateway 事件，自动更新状态
  onMounted(() => {
    const unsubChat = gatewayClient.on('chat', (payload: any) => {
      if (payload.sessionKey !== sessionKey.value) return
      const { state, runId } = payload
      currentRunId.value = runId
      switch (state) {
        case 'delta':   streamState.value = 'streaming'; isProcessing.value = true; break
        case 'final':   streamState.value = 'idle';      isProcessing.value = false; break
        case 'error':   streamState.value = 'error';     isProcessing.value = false; break
      }
    })
    const unsubAgent = gatewayClient.on('agent', (payload: any) => {
      if (payload.sessionKey !== sessionKey.value) return
      if (payload.stream === 'lifecycle') {
        const phase = payload.data?.phase
        if (phase === 'start') { streamState.value = 'thinking'; isProcessing.value = true }
        else if (phase === 'end' || phase === 'error') { streamState.value = 'idle'; isProcessing.value = false }
      }
    })
    onUnmounted(() => { unsubChat(); unsubAgent() })
  })

  async function abort() {
    if (currentRunId.value) {
      await gatewayClient.request('chat.abort', { sessionKey: sessionKey.value, runId: currentRunId.value })
    } else {
      await gatewayClient.abortTurn(sessionKey.value!)
    }
    streamState.value = 'idle'
    isProcessing.value = false
  }

  return { isProcessing, streamState, currentRunId, abort }
}
```

**为什么用 composable 而非 Pinia store？**
- 状态与 WebSocket 事件绑定，生命周期跟随组件
- 避免全局 store 中的 session 切换竞态
- `useChatData` 和 `ChatInputArea` 都可以 consume 这个 composable

#### 决策 2：改进 `MessageInput.vue` 为 `ChatInputBox.vue`

```vue
<!-- ChatInputBox.vue — 纯 UI 组件，不依赖业务逻辑 -->
<script setup lang="ts">
interface Props {
  disabled?: boolean
  streaming?: boolean          // Agent 正在流式输出
  streamState?: 'idle' | 'thinking' | 'streaming' | 'error'
  placeholder?: string
  hasAttachments?: boolean     // 控制底部操作栏显示
  maxLines?: number            // 默认 12
}

const emit = defineEmits<{
  send: [text: string]
  abort: []
  focus: []
  resize: [height: number]     // 通知父组件高度变化
}>()

defineExpose({ focus })
</script>
```

**设计原则**：
- **不管理发送逻辑**：只 emit `send` 事件，由父组件决定发 HTTP 还是 Gateway
- **不管理附件**：只接收 `hasAttachments` 信号，决定是否显示操作栏
- **不管理 streaming 状态来源**：只接收 props，不关心状态从哪来
- **职责纯粹**：UI 渲染 + 键盘事件 + 自适应高度

#### 决策 3：附件管理抽离为 `useAttachmentManager` composable

```typescript
// composables/useAttachmentManager.ts
export function useAttachmentManager(maxCount = 4) {
  const attachments = ref<ChatAttachment[]>([])
  const dragOver = ref(false)

  function add(file: File): boolean { /* ... */ }
  function remove(id: string): void { /* ... */ }
  function clear(): void { /* ... */ }
  function toPayloads(): AttachmentPayload[] { /* ... */ }
  function toDataUrls(): string[] { /* ... */ }

  // 返回事件处理器（可直接绑定到 template）
  function onFileSelect(): void { /* ... */ }
  function onFileChange(e: Event): void { /* ... */ }
  function onPaste(e: ClipboardEvent): void { /* ... */ }
  function onDragOver(e: DragEvent): void { /* ... */ }
  function onDragLeave(): void { /* ... */ }
  function onDrop(e: DragEvent): void { /* ... */ }

  return { attachments, dragOver, add, remove, clear, toPayloads, toDataUrls, onFileSelect, onFileChange, onPaste, onDragOver, onDragLeave, onDrop }
}
```

**好处**：
- 从 Workspace.vue 的 ~80 行附件代码中提取为可复用 composable
- 测试友好（纯逻辑，无 DOM 依赖）
- 未来可轻松支持文件类型、数量限制配置

#### 决策 4：发送逻辑抽离为 `useMessageSender` composable

```typescript
// composables/useMessageSender.ts
export function useMessageSender(
  sessionKey: Ref<string>,
  gatewayConnected: Ref<boolean>,
  onOptimisticMessage: (content: string, dataUrls: string[]) => void,
) {
  const sending = ref(false)

  async function send(text: string, attachmentPayloads?: AttachmentPayload[]) {
    if (sending.value || !sessionKey.value) return
    sending.value = true
    try {
      if (gatewayConnected.value) {
        await gatewayClient.sendMessage(sessionKey.value, text, attachmentPayloads)
      } else {
        // HTTP fallback
        const res = await request('/chat/send', { ... })
        if (!data.success) throw new Error(data.error)
      }
      onOptimisticMessage(text, attachments.value.map(a => a.dataUrl))
    } catch (e) {
      throw e // 让调用方处理回滚
    } finally {
      sending.value = false
    }
  }

  return { sending, send }
}
```

### 2.3 状态流转图

```
┌─────────────────────┐     streaming props     ┌──────────────────┐
│  useAgentActivity   │────────────────────────▶│  ChatInputBox    │
│                     │                         │                  │
│  isProcessing ──────┼──▶ disabled input       │  abort button    │
│  streamState ───────┼──▶ visual feedback      │  streaming style │
│  abort() ◀──────────┼──▶ click abort          │                  │
└─────────────────────┘                         └──────────────────┘
         │
         │ send() result triggers
         ▼
┌─────────────────────┐     optimistic msg      ┌──────────────────┐
│  useMessageSender   │────────────────────────▶│  ChatTimeline    │
│                     │                         │                  │
│  sending ───────────┼──▶ button spinner       │  addOptimistic() │
│  send()             │                         │  WS updates      │
└─────────────────────┘                         └──────────────────┘
```

---

## 三、组件接口设计

### 3.1 ChatInputArea.vue（容器组件）

```vue
<script setup lang="ts">
// Props: 极简
defineProps<{
  sessionKey: string
  canSend: boolean  // 由外部控制（session 是否有效）
}>()

// 内部组合：
// - useAgentActivity(sessionKey) → isProcessing, streamState, abort
// - useAttachmentManager() → 附件 CRUD + 事件处理
// - useMessageSender(sessionKey, connected, onOptimistic) → sending, send
// - useChatInputStore().bind(sessionKey, inputText) → 输入缓存

// 职责：组装子组件 + 连接数据流
</script>

<template>
  <div class="chat-input-area" @dragover="onDragOver" @drop="onDrop">
    <AttachmentBar v-if="attachments.length" :items="attachments" @remove="removeAttachment" />
    <ChatInputBox
      :streaming="isProcessing"
      :stream-state="streamState"
      :disabled="!canSend"
      :has-attachments="attachments.length > 0"
      @send="handleSend"
      @abort="abort"
    />
  </div>
</template>
```

### 3.2 ChatInputBox.vue（纯 UI）

```
Props:
  disabled: boolean              — 禁用输入
  streaming: boolean             — Agent 处理中（禁用输入 + 显示中止）
  streamState: 'idle' | 'thinking' | 'streaming' | 'error' — 视觉状态
  placeholder: string            — 占位文本
  hasAttachments: boolean        — 是否显示附件按钮

Events:
  send(text: string)             — 用户确认发送
  abort()                        — 用户点击中止

Slots:
  #action-left                   — 左侧操作区扩展点（如附件按钮）
  #action-right                  — 右侧操作区扩展点

Expose:
  focus()                        — 聚焦输入框
```

### 3.3 AttachmentBar.vue（附件预览）

```
Props:
  items: ChatAttachment[]        — 附件列表

Events:
  remove(id: string)             — 移除指定附件
```

---

## 四、渐进式迁移路径

### Phase 0: 准备（1-2 天，零风险）

1. **创建 `useAgentActivity` composable**
   - 不替换任何现有代码
   - 在 `ChatTimeline.vue` 中试用，确认状态更新正确
   - 与现有 `showTypingIndicator` 并行运行，对比行为

2. **完善 `MessageInput.vue`**
   - 补充附件相关 props/slots
   - 统一 CSS 变量命名（当前混用 `--el-*` 和 `--color-*`）
   - 重命名为 `ChatInputBox.vue`

### Phase 1: 创建新组件（2-3 天，低风险）

1. **抽离 composable**：
   - `useAttachmentManager` 从 Workspace.vue 提取
   - `useMessageSender` 从 Workspace.vue 提取
   - 单元测试覆盖核心逻辑

2. **创建 `ChatInputArea.vue`**：
   - 组装 `ChatInputBox` + `AttachmentBar`
   - 使用新 composable
   - 在 Workspace.vue 旁并行存在

### Phase 2: 切换引用（1 天，中风险）

1. **Feature flag 控制**：
   ```vue
   <!-- Workspace.vue -->
   <ChatInputArea v-if="USE_NEW_INPUT" :session-key="sessionKey" :can-send="canSend" />
   <!-- 旧输入框保留作为 fallback -->
   <div v-else class="chat-input-bar">...</div>
   ```

2. **灰度测试**：确认所有场景正常后移除旧代码

### Phase 3: 拆分 Workspace.vue（1-2 天，中风险）

1. **创建 `ChatView.vue`**：
   - 移动 ChatTimeline + ChatInputArea + 相关逻辑
   - Workspace.vue 仅保留路由和会话选择

2. **清理**：移除 Workspace.vue 中的输入框代码（~250 行）

---

## 五、风险评估与缓解

### 5.1 回归风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| streaming 状态传递延迟导致中止按钮闪烁 | 中 | 低 | Phase 0 并行验证，确认时序正确 |
| 输入框高度 resize 行为不一致 | 低 | 中 | 复用 Workspace 已验证的 resize 逻辑到 composable |
| 附件上传失败后状态未清理 | 中 | 高 | `useMessageSender` catch 中回滚，测试覆盖 |
| session 切换时输入缓存丢失 | 低 | 高 | `useChatInputStore.bind` 已验证，迁移时保持不变 |
| Gateway 断连后 fallback 行为异常 | 低 | 高 | `useMessageSender` 保留 HTTP fallback 逻辑 |
| `showTypingIndicator` 与新 `isProcessing` 冲突 | 中 | 中 | Phase 0 先统一状态源，再替换消费方 |

### 5.2 关键保护策略

1. **不一次性重写**：Phase 0-3 每步都可独立回滚
2. **Feature flag 切换**：新旧实现可并存
3. **composable 先行**：先提取逻辑（可单独测试），再改 UI
4. **保持 Gateway fallback**：HTTP fallback 路径不改动，仅迁移位置

### 5.3 测试建议

```
测试优先级：
P0 — useAgentActivity 状态机（thinking→streaming→idle/error 转换）
P0 — useMessageSender 发送 + 回滚（成功/失败/断连场景）
P1 — ChatInputBox streaming/disabled 视觉状态
P1 — 附件 CRUD（add/remove/clear/超过上限）
P2 — session 切换输入缓存保留
P2 — resize 行为（drag + auto）
```

---

## 六、总结

### 核心问题
1. **输入框分裂** → 两套代码，维护成本高，用户体验不一致
2. **状态断裂** → `showTypingIndicator` 和 `sending` 各自为政，无法反映真实 Agent 状态
3. **Workspace 职责爆炸** → 600+ 行单文件，包含 8 个不相关职责

### 解决方案
1. **统一状态源**：`useAgentActivity` composable 作为唯一的 "Agent 是否在处理" 状态
2. **组件解耦**：`ChatInputBox`（纯 UI）+ `ChatInputArea`（容器）+ composable（逻辑）
3. **渐进迁移**：4 个 Phase，每步可独立回滚，Feature flag 切换

### 预期收益
- Workspace.vue 从 ~600 行 → ~150 行（减少 75%）
- 输入框相关代码从单文件散布 → 3 个组件 + 3 个 composable
- streaming 中止功能从"未实现"→"完整支持"
- 状态管理从"断裂"→"统一"
