# P0 消息发送功能 — 实施计划

> 父任务: d3e5ace0-4ba5-4c28-97d1-eff654f0d046
> 日期: 2026-04-30
> 参与方: dev（后端）、dev1/依依（前端）

---

## 1. 总体架构

```
浏览器 (Vue 前端)
    │  POST /api/chat/send    SSE /api/chat/stream
    ▼
┌─────────────────────────────────────────────────┐
│  Desktop Express Server (ice-bubble-desktop)     │
│                                                  │
│  /api/chat/send     → ChatController.send()      │
│  /api/chat/stream   → SSE endpoint               │
│                                                  │
│  ChatController                             │
│    ├─ GatewayClient (WebSocket RPC → Gateway)    │
│    ├─ SSE Manager (广播消息给前端订阅者)           │
│    └─ Session Cache (session_key → id 映射)      │
└─────────────────────────────────────────────────┘
    │  WebSocket (RPC)
    ▼
  OpenClaw Gateway (ws://localhost:3012)
    │  chat.send / sessions.create / sessions.messages.subscribe
    ▼
  OpenClaw Agents
```

---

## 2. 后端任务拆分（dev）

### B1: Gateway WebSocket 连接管理

**文件**: `src/server/gateway/connection.ts`（新增）

**内容**:
- `class GatewayConnection`
  - `connect(gatewayUrl: string): Promise<void>` — 建立 WebSocket 连接
  - `disconnect(): void` — 关闭连接
  - `isConnected(): boolean`
  - `onReconnect(callback): void` — 重连回调
  - `onDisconnect(callback): void` — 断连回调
  - 内部逻辑: 自动重连（指数退避，最大 30s），心跳检测

**依赖**: 无（安装 `ws` npm 包）

**验收标准**:
- 能连接到 `ws://localhost:3012`
- 连接断开后自动重连
- `isConnected()` 状态准确

---

### B2: Gateway RPC 封装层

**文件**: `src/server/gateway/rpc.ts`（新增）

**内容**:
- `class GatewayRpc`
  - 构造函数接收 `GatewayConnection` 实例
  - `request(method: string, params?: object): Promise<any>` — 发送 JSON-RPC 请求，等待响应（基于 JSON-RPC 2.0 `id` 匹配）
  - `subscribe(method: string, params: object, handler: (result: any) => void): () => void` — 订阅事件流，返回取消订阅函数
  - 内部: 维护 `pendingRequests: Map<number, { resolve, reject, timer }>`，请求超时 30s

**Gateway RPC 调用点**:
| 方法 | 用途 |
|------|------|
| `sessions.create` | 创建/获取 session |
| `sessions.messages.subscribe` | 订阅 session 消息流 |
| `chat.send` | 发送消息 |

**依赖**: B1

**验收标准**:
- `request('sessions.create', { channel, agent })` 返回 session 对象
- `subscribe('sessions.messages.subscribe', { sessionId }, handler)` 收到消息推送
- 请求超时 30s 后 reject

---

### B3: SSE 推送管理器

**文件**: `src/server/chat/sse-manager.ts`（新增）

**内容**:
- `class SSEManager`
  - `addClient(sessionKey: string, res: ServerResponse): void` — 注册 SSE 客户端
  - `removeClient(res: ServerResponse): void` — 客户端断开时清理
  - `broadcast(sessionKey: string, event: object): void` — 向订阅指定 session 的所有客户端广播
  - `broadcastAll(event: object): void` — 全局广播（用于连接状态等）
  - 内部: `Map<string, Set<ServerResponse>>` 按 sessionKey 分组

**依赖**: 无

**验收标准**:
- 前端通过 `GET /api/chat/stream?session=xxx` 建立 SSE 连接
- `broadcast` 后前端收到对应事件
- 客户端断开后自动清理，无内存泄漏

---

### B4: Session 缓存（session_key ↔ session_id 映射）

**文件**: `src/server/chat/session-cache.ts`（新增）

**内容**:
- `class SessionCache`
  - `get(sessionKey: string): string | undefined` — 获取 Gateway session_id
  - `set(sessionKey: string, sessionId: string): void`
  - `clear(sessionKey: string): void`
  - 内部: 内存 Map，可选持久化到 JSON 文件

**依赖**: 无

**验收标准**:
- `sessions.create` 返回后缓存映射
- 下次发送消息时直接使用缓存，不重复创建

---

### B5: Chat Controller — 消息发送 API

**文件**: `src/server/chat/controller.ts`（新增）

**内容**:
- `class ChatController`
  - 构造函数接收 `GatewayRpc`、`SSEManager`、`SessionCache`
  - `async send(sessionKey: string, message: string): Promise<{ success: boolean, error?: string }>`
    1. 从 `SessionCache` 获取 session_id，无则调用 `sessions.create`
    2. 调用 `chat.send({ sessionId, message })`
    3. 返回发送结果

**依赖**: B2, B3, B4

**验收标准**:
- `POST /api/chat/send { sessionKey, message }` 返回 `{ success: true }`
- 首次发送自动创建 session，后续复用
- Gateway 不可用时返回 `{ success: false, error: "Gateway not connected" }`

---

### B6: Chat Controller — 消息流订阅

**文件**: `src/server/chat/controller.ts`（在 B5 的同一文件中扩展）

**内容**:
- `subscribeToSession(sessionKey: string, res: ServerResponse): void`
  1. 调用 `SSEManager.addClient()` 注册
  2. 调用 `GatewayRpc.subscribe('sessions.messages.subscribe', { sessionId }, handler)`
  3. handler 中调用 `SSEManager.broadcast()` 转发给前端
  4. 返回 cleanup 函数，在 res close 时调用

**依赖**: B2, B3, B4

**验收标准**:
- 前端建立 SSE 连接后，该 session 的新消息实时推送
- 断开 SSE 后停止订阅，无泄漏

---

### B7: Express 路由注册

**文件**: `src/server/index.ts`（修改）

**内容**:
- 导入 `ChatController`，实例化
- 注册路由:
  - `POST /api/chat/send` → `controller.send()`
  - `GET /api/chat/stream` → SSE endpoint
- 初始化时自动连接 Gateway

**依赖**: B5, B6, B1

**验收标准**:
- 服务启动后 Gateway 自动连接
- `/api/chat/send` 和 `/api/chat/stream` 可正常访问

---

### B8: Chat API Client 前端接口（后端负责定义接口格式）

**文件**: `src/api/client.ts`（修改，追加方法）

**内容**:
- `api.chat.send(sessionKey: string, message: string): Promise<{ success: boolean }>`
- `createChatSSEStream(sessionKey: string): EventSource` — 返回 SSE EventSource

**依赖**: B7（后端 API 就绪后才有意义）

**验收标准**:
- TypeScript 类型正确
- 方法签名与后端路由匹配

---

## 3. 前端任务拆分（dev1/依依）

### F0: 前后端接口协议类型定义

**文件**: `src/types/chat.ts`（新增）

**内容**:

```typescript
// 消息发送请求
interface ChatSendRequest {
  sessionKey: string
  message: string
}

// 消息发送响应
interface ChatSendResponse {
  success: boolean
  messageId?: string
  error?: string
}

// SSE 消息事件
interface SSEMessageEvent {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  messageId: string
}

// SSE 错误事件
interface SSEErrorEvent {
  message: string
}

// SSE 连接状态事件
interface SSEStatusEvent {
  connected: boolean
}

// Session 列表项
interface SessionItem {
  sessionKey: string
  agent: string
  channel: string
  lastActive: string
  title?: string
}
```

**验收标准**:
- 所有类型与后端接口协议完全一致
- `src/api/client.ts` 和 composable 统一从此文件导入类型
- 无 `any` 类型

---

### F1: API Client — 消息发送与 SSE 流

**文件**: `src/api/client.ts`（修改，追加方法）

**新增函数**:

```typescript
async chatSend(sessionKey: string, message: string): Promise<ChatSendResponse>
createChatStream(sessionKey: string): EventSource
```

**实现要点**:
- `chatSend`: `POST /api/chat/send`，Content-Type: `application/json`，body 为 `ChatSendRequest`
- `createChatStream`: 返回 `new EventSource('/api/chat/stream?session=' + encodeURIComponent(sessionKey))`，调用方负责监听 `message`/`error`/`status` 事件并调用 `.close()`

**依赖**: F0（类型定义）

**验收标准**:
- `chatSend('agent:main:main', 'hello')` → `POST /api/chat/send { sessionKey: 'agent:main:main', message: 'hello' }`
- `createChatStream` 返回的 EventSource 能正确监听三种事件类型
- 请求失败时抛出包含 `error` 字段的错误
- TypeScript 类型无报错

---

### F2: useChat Composable

**文件**: `src/composables/useChat.ts`（新增）

**导出函数**: `useChat(sessionKey: Ref<string>)`

**返回值**:

```typescript
interface UseChatReturn {
  messages: Ref<ChatMessage[]>
  isSending: Ref<boolean>
  isStreaming: Ref<boolean>
  send: (message: string) => Promise<void>
  abort: () => void
  error: Ref<string | null>
  reconnect: () => void
}

interface ChatMessage {
  id: string          // messageId，客户端生成的用 'local_' 前缀
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isLocal: boolean    // optimistic update 标记，服务端确认后置 false
}
```

**核心逻辑**:

1. **`send(message: string)`**:
   - 校验非空、非发送中
   - 追加 `{ id: 'local_' + uuid, role: 'user', content: message, timestamp: Date.now(), isLocal: true }` 到 messages
   - 设置 `isSending = true`
   - 调用 `api.chatSend(sessionKey.value, message)`
   - 成功: 标记 `isLocal = false`
   - 失败: 设置 `error`，保留消息但标记为发送失败（UI 展示重试按钮）
   - finally: `isSending = false`

2. **`abort()`**:
   - 关闭当前 EventSource
   - `isStreaming = false`
   - 追加一条系统消息「已中止生成」

3. **SSE 连接管理**:
   - `watch(sessionKey, ...)` 切换 session 时关闭旧 EventSource，建立新连接
   - 监听 `message` 事件 → 追加 assistant 消息到 messages，`isStreaming = true`
   - 监听 `error` 事件 → 设置 `error`，自动重试（最多 3 次，间隔 2s/4s/8s）
   - 监听 `status` 事件 → 更新连接状态
   - 组件卸载时 `onUnmounted` 关闭 EventSource

4. **`reconnect()`**:
   - 手动重连 SSE，清除错误状态

**依赖**: F1（API Client）

**验收标准**:
- `send('hello')` 后 messages 数组立即包含一条 role=user 的消息（optimistic update）
- SSE 收到消息后自动追加 assistant 消息
- `abort()` 立即停止流式输出
- 切换 `sessionKey` 时旧连接关闭、新连接建立
- 连续快速发送消息时 `isSending` 状态正确
- 组件卸载后无内存泄漏（EventSource 已关闭）

---

### F3: SessionSelector 下拉选择组件

**文件**: `src/components/SessionSelector.vue`（新增）

**Props**:

```typescript
interface Props {
  modelValue: string           // 当前选中的 sessionKey
  sessions: SessionItem[]      // 全量 session 列表
  loading?: boolean            // 加载状态，默认 false
}

// Emits
declare const emit = defineEmits<{
  (e: 'update:modelValue', sessionKey: string): void
  (e: 'refresh'): void         // 刷新列表
}>()
```

**UI 结构**:

```
┌─────────────────────────────────────┐
│ 🔽 agent:main:main          🔄 ⟷  │  ← 触发器：当前 session + 刷新按钮
├─────────────────────────────────────┤
│ 📁 main (默认)                      │  ← 按 agent 分组
│   ├─ main                           │  ← channel 级别
│   │   ├─ agent:main:main  ●active   │  ← session 项，高亮当前选中
│   │   └─ agent:main:dev             │
│   └─ discord                        │
│       └─ agent:main:discord:xxx     │
│ 📁 dev                              │
│   └─ agent:dev:subagent:xxx         │
└─────────────────────────────────────┘
```

**核心函数**:

- `groupedSessions: ComputedRef<Map<string, SessionItem[]>>` — 按 `session.agent` 分组
- `selectSession(key: string)` — emit `update:modelValue`，关闭下拉
- `formatSessionLabel(item: SessionItem): string` — 人类可读的 session 标签

**交互行为**:
- 点击触发器展开/收起下拉面板
- 点击 session 项 → 切换到该 session，触发 `useChat` 的 sessionKey watch
- 默认选中 `agent:main:main`
- 点击外部区域关闭下拉（`onClickOutside`）
- 支持键盘上下箭头选择、Enter 确认
- 加载中显示骨架屏或 spinner

**依赖**: F0（类型定义）

**验收标准**:
- sessions 按正确分组展示
- 选中项有高亮状态
- 点击 session 项后 `modelValue` 更新
- 点击外部关闭下拉
- 键盘导航可用（上下+Enter）
- 空列表时显示「暂无 session」提示

---

### F4: MessageInput 输入组件

**文件**: `src/components/MessageInput.vue`（新增）

**Props**:

```typescript
interface Props {
  disabled?: boolean           // 禁用输入（如连接断开时），默认 false
  sending?: boolean             // 发送中状态，默认 false
  streaming?: boolean           // 流式输出中，默认 false
  placeholder?: string          // 输入框占位文本，默认 '输入消息...'
}

// Emits
declare const emit = defineEmits<{
  (e: 'send', message: string): void
  (e: 'abort'): void
}>()
```

**UI 结构**:

```
┌──────────────────────────────────┐
│  textarea（自动伸缩高度）    🛑 ➤ │  ← 中止按钮 + 发送按钮
│  placeholder: 输入消息...        │
└──────────────────────────────────┘
```

**核心逻辑**:

- **textarea 自动伸缩**: 监听 `input` 事件，动态调整高度（min: 40px, max: 200px），内容清空时回弹到 min
- **发送触发**:
  - 点击 ➤ 按钮或按 `Ctrl+Enter` 触发 `emit('send', text.trim())`
  - 发送后清空 textarea
  - `sending || streaming || !text.trim()` 时按钮 disabled
- **中止按钮** 🛑:
  - 仅在 `streaming` 为 true 时显示
  - 点击触发 `emit('abort')`
- **状态样式**:
  - `disabled` 时 textarea 灰色 + 不可编辑
  - `sending` 时发送按钮显示 spinner
  - `streaming` 时发送按钮隐藏，中止按钮显示

**ref 定义**:
- `textareaRef: Ref<HTMLTextAreaElement | null>`
- `inputText: Ref<string>` — v-model 绑定

**验收标准**:
- 空内容时发送按钮 disabled
- `Ctrl+Enter` 正确触发发送
- textarea 高度随内容自动调整
- `streaming` 时中止按钮可见、发送按钮隐藏
- 发送后 textarea 清空
- `disabled` 时整个组件不可交互

---

### F5: ChatPanel 主面板集成

**文件**: `src/components/ChatPanel.vue`（修改）

**改动概述**: 将现有的单 session 聊天面板改造为支持多 session 切换的完整聊天界面

**Props**:

```typescript
interface Props {
  sessions: SessionItem[]       // session 列表（由父组件传入或从 store 获取）
}
```

**UI 布局**:

```
┌─────────────────────────────────────────┐
│  [SessionSelector v-model="currentKey"] │  ← 顶部：session 选择器
├─────────────────────────────────────────┤
│                                         │
│  MessageList                            │  ← 中部：消息列表（滚动区域）
│    ├─ MessageBubble (user)              │
│    ├─ MessageBubble (assistant)        │
│    └─ MessageBubble (system/abort)       │
│                                         │
├─────────────────────────────────────────┤
│  [MessageInput @send @abort]            │  ← 底部：输入区
└─────────────────────────────────────────┘
```

**核心逻辑**:

- 引入 `useChat(currentSessionKey)` composable
- `currentSessionKey: Ref<string>` — 双向绑定 SessionSelector
- `watch(currentSessionKey, ...)` 切换 session 时清空 messages、重新建立 SSE
- 消息列表 `auto-scroll`：新消息到来时自动滚到底部（`nextTick` + `scrollIntoView`）
- 本地消息标记：`isLocal` 为 true 时显示发送中动画
- 发送失败消息显示「重试」按钮

**子组件引用**:
- `<SessionSelector v-model="currentSessionKey" :sessions="sessions" />`
- `<MessageInput :sending="isSending" :streaming="isStreaming" @send="send" @abort="abort" />`
- `<MessageBubble v-for="msg in messages" :key="msg.id" :message="msg" />`

**验收标准**:
- 选择不同 session 后消息列表切换（同一 session 的历史通过 SSE 重连后获取，或通过 `chat.send` 触发 Gateway 返回历史）
- 输入框发送消息后消息列表实时更新
- 流式输出时中止按钮可用，点击后停止生成
- 切换 session 时不会出现消息串台
- 窗口大小变化时布局自适应

---

### F6: Session 列表数据获取

**文件**: `src/stores/chatStore.ts`（新增，Pinia store）

**Store**: `useChatStore`

**State**:

```typescript
interface ChatStoreState {
  sessions: SessionItem[]
  loading: boolean
}
```

**Actions**:

- `async fetchSessions(): Promise<void>` — 调用 `GET /api/sessions` 获取 session 列表
- `async createSession(agent: string, channel: string): Promise<SessionItem>` — 调用 `POST /api/sessions` 创建新 session

**Getters**:

- `defaultSessionKey: ComputedRef<string>` — 返回 `'agent:main:main'`

**依赖**: F0（类型定义）

**验收标准**:
- ChatPanel 挂载时自动加载 session 列表
- `fetchSessions` 失败时 `loading` 重置为 false，`sessions` 不被清空
- 新创建的 session 立即出现在列表中

---

## 4. 前后端接口对接格式

### POST /api/chat/send

**请求**:
```json
{
  "sessionKey": "agent:main:main",
  "message": "你好，测试消息"
}
```

**成功响应** (200):
```json
{
  "success": true,
  "messageId": "msg_abc123"
}
```

**错误响应** (200，业务错误):
```json
{
  "success": false,
  "error": "Gateway not connected"
}
```

**网络错误** (5xx/超时): 前端按网络异常处理，重试或提示用户

### GET /api/chat/stream?session=<sessionKey>

**连接**: 标准 SSE（`text/event-stream`），前端通过 `EventSource` 连接

**事件类型**:

| event | data 结构 | 说明 |
|-------|----------|------|
| `message` | `{ role, content, timestamp, messageId }` | 聊天消息推送 |
| `error` | `{ message }` | 订阅/流错误 |
| `status` | `{ connected: boolean }` | 连接状态心跳（每 30s） |

**断开**: 客户端关闭 EventSource，服务端清理资源

---

## 5. 前后端并行开发策略

### 并行策略：Mock 先行，接口驱动

```
时间线（并行开发）:

Hour 0:     双方对齐接口协议（本节第4节） ← 30min 同步会
            │
Hour 0.5 ───┤─── 后端 B1+B3+B4 ─── B2 ─── B5+B6 ─── B7 ── 联调
            │
Hour 0.5 ───┤─── 前端 F0(类型) ── F2(mock) ── F3 ── F4 ── F5 ── 联调
                       F6(mock API)
```

### 前端 Mock 方案

前端在后端 API 就绪前，用以下 mock 确保 UI 可独立开发和测试：

1. **`src/api/client.ts` mock 分支**:
   ```typescript
   // 在 api/client.ts 中
   const USE_MOCK = import.meta.env.VITE_MOCK_CHAT === 'true'

   if (USE_MOCK) {
     // chatSend: 延迟 500ms 返回成功
     // createChatStream: setInterval 每 2s 推送一条模拟 assistant 消息
   }
   ```

2. **`src/api/mock/chat.ts`（新增）**:
   - `mockChatSend(req: ChatSendRequest): Promise<ChatSendResponse>`
   - `mockChatStream(sessionKey: string, handlers: SSEHandlers): () => void` — 返回清理函数

3. **useChat composable 无需改动**: 因为 F2 依赖 F1（API Client），API Client 内部已处理 mock 分支

### 文件无冲突分析

| 前端文件 | 后端文件 | 冲突？ |
|----------|---------|--------|
| `src/types/chat.ts` | — | 无 |
| `src/api/client.ts` | `src/server/index.ts` | 无（不同文件，注意协调类型） |
| `src/composables/useChat.ts` | — | 无 |
| `src/components/SessionSelector.vue` | — | 无 |
| `src/components/MessageInput.vue` | — | 无 |
| `src/components/ChatPanel.vue` | — | 无 |
| `src/stores/chatStore.ts` | — | 无 |
| `src/api/mock/chat.ts` | — | 无 |

**结论: 前后端完全无文件冲突，可全速并行开发。**

### 联调检查清单

- [ ] F0 类型与后端 B5 响应格式一致
- [ ] F1 chatSend 发送格式与 B7 路由匹配
- [ ] F2 SSE 事件名与 B6 controller 广播的事件名一致
- [ ] F6 session 列表接口（需后端补充 `GET /api/sessions` 或使用 Gateway `sessions.list`）
- [ ] 关闭 VITE_MOCK_CHAT 后切换为真实 API 无报错

---

## 6. 依赖关系图
