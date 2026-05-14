# ConnectionAlert 横幅优化设计方案

> 日期：2026-05-14  
> 状态：待确认

## 背景

ConnectionAlert.vue 是 Desktop 顶部全局横幅，在 Admin 连接不通时显示。加入 Bearer token 认证后，"连接失败"有多种原因（token 未填、token 错误、Admin 未启动、URL 错误、网络不通），但当前横幅只显示笼统的提示，且没有 token 输入入口。

## 1. 失败场景及对应提示

| 场景 | 触发条件 | 图标 | 颜色 | 提示文案 |
|---|---|---|---|---|
| 未配置 | 首次使用，无 URL/Token 配置 | `InfoFilled` | 蓝色 `#eff6ff` / `#93c5fd` | Admin 服务未配置，请填写连接信息 |
| Token 未填 | 服务端返回 401，且本地无 Token | `Lock` | 橙色 `#fff7ed` / `#fdba74` | 需要认证，请填写 Token |
| Token 错误 | verify 接口返回非 200 | `Lock` | 红色 `#fef2f2` / `#fca5a5` | Token 不正确，请检查后重试 |
| Admin 未启动 | URL 可达但服务未运行（ECONNREFUSED） | `CircleCloseFilled` | 红色 `#fef2f2` / `#fca5a5` | Admin 服务未启动或端口未开放 |
| URL 错误 | DNS 解析失败或格式错误 | `WarningFilled` | 红色 `#fef2f2` / `#fca5a5` | Admin 地址无效，请检查 URL |
| 网络不通 | fetch 抛 NetworkError / timeout | `WarningFilled` | 红色 `#fef2f2` / `#fca5a5` | 无法连接 Admin 服务（网络不通或 Mixed Content 限制） |
| 连接断开 | 心跳检测从 CONNECTED -> DISCONNECTED | `Loading` | 黄色 `#fefce8` / `#fde047` | Admin 连接已断开，正在自动重连… |
| 连接成功 | 恢复连接 | `CircleCheckFilled` | 绿色 `#f0fdf4` / `#86efac` | Admin 服务已连接 |

## 2. UI 布局设计

### 2.1 整体布局

```
┌─────────────────────────────────────────────────────────────────────┐
│ <Lock/> Token 不正确，请检查后重试                      <ArrowDown/> 收起 │
├─────────────────────────────────────────────────────────────────────┤
│ URL: [http://localhost:13000_________] Token: [••••••] <View/>   │
│ [测试连接] [保存]                                    前往设置页 ->  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 元素说明

**第一行（标题栏，始终可见）：**
- 左侧：图标 + 状态文案
- 右侧：收起/展开按钮（`<ArrowDown/>` / `<ArrowRight/>`），收起后只显示这一行

**第二行（操作区，展开时可见）：**
- URL 输入框：宽度 240px，带前缀 `URL:` 标签
- Token 输入框：宽度 200px，`type="password"`，右侧有 `<View/>` / `<Hide/>` 切换显示/隐藏（复用 Settings.vue 的 `showToken` 模式）
- 「测试连接」按钮：普通样式，loading 时禁用
- 「保存」按钮：primary 样式，仅在测试通过后可点击
- 「前往设置页 ->」链接：右对齐，跳转完整设置页

### 2.3 收起逻辑

- 默认**展开**
- 用户点击 `<ArrowDown/>` 后收起为单行横幅（仅图标 + 文案 + 展开按钮）
- 连接成功后横幅消失，收起状态不保留
- 再次出现故障时默认展开

### 2.4 特殊场景简化

- **未配置（UNCONFIGURED）**：不显示收起按钮，强制展开，提示用户完成配置
- **连接断开（DISCONNECTED）**：只显示第一行，不显示操作区（因为有自动重连），附加"前往设置页"链接

## 3. 交互流程设计

### 3.1 用户恢复连接的完整流程

```
看到横幅（区分了具体原因）
  │
  ├─ Token 问题 → 修改 Token → 测试连接 → 成功 → 保存
  ├─ URL/网络问题 → 修改 URL → 测试连接 → 成功 → 保存
  ├─ 不想在此修改 → 点击"前往设置页" → Settings.vue 完整配置
  └─ 连接断开 → 自动重连中（无需操作）→ 成功则横幅自动消失
```

### 3.2 按钮状态逻辑

| 按钮 | 默认 | 测试中 | 测试通过 | 测试失败 |
|---|---|---|---|---|
| 测试连接 | 可点 | loading/禁用 | 可点（改 URL/Token 后重新测） | 可点 |
| 保存 | 禁用 | 禁用 | 可点 | 禁用 |
| 前往设置页 | 始终可点 | — | — | — |

### 3.3 自动重连机制

**DISCONNECTED 状态自动重连（已有 30s 心跳，扩展逻辑）：**

- 心跳检测发现断开 → 状态设为 DISCONNECTED → 横幅显示"已断开，正在重连…"
- 每隔 30s 重新尝试连接（复用现有 `HEALTH_CHECK_INTERVAL`）
- 重连成功 → 显示绿色"已连接"横幅 2 秒后自动隐藏
- 重连失败 → 保持 DISCONNECTED 状态，横幅保持显示
- 连续失败 5 次后 → 状态降级为 CONN_FAILED，提示文案从"正在重连"变为"连接失败，请检查配置"，显示完整操作区

## 4. 技术实现要点

### 4.1 ConnectionState 扩展

在 `adminConnection.ts` 中新增细分状态：

```typescript
export type ConnectionState =
  | 'UNCONFIGURED'      // 未配置
  | 'CONFIGURING'       // 正在测试连接
  | 'CONFIG_ERROR'      // 地址格式错误
  | 'AUTH_REQUIRED'     // 需要认证（401 + 无 token）
  | 'AUTH_FAILED'       // Token 错误
  | 'CONN_FAILED'       // 连接失败（网络/服务不可达）
  | 'CONNECTED'         // 已连接
  | 'DISCONNECTED';     // 断开（自动重连中）
```

### 4.2 adminConnection.ts 修改

**configure() 方法改造：**

当前 `configure()` 只返回 boolean，无法区分失败原因。改为：

```typescript
export interface ConfigureResult {
  success: boolean;
  error?: 'NETWORK' | 'AUTH_REQUIRED' | 'AUTH_FAILED' | 'INVALID_URL' | 'SERVER_ERROR';
}

async configure(url: string, authToken?: string): Promise<ConfigureResult>
```

**detectConnection() 改造：**

健康检测失败时，根据错误类型细分状态：
- `TypeError` (fetch failed) → `CONN_FAILED`（网络不通）
- HTTP 401 → `AUTH_REQUIRED`（需认证）或 `AUTH_FAILED`（token 错误，区分逻辑：本地有 token 则为 AUTH_FAILED）
- HTTP 5xx → `CONN_FAILED`（Admin 未启动）
- 其他 → `CONN_FAILED`

**新增方法：**

```typescript
// 获取当前 token
getCurrentToken(): string

// 获取重连失败次数（用于 UI 判断是否从 DISCONNECTED 降级）
getReconnectFailCount(): number
```

### 4.3 ConnectionAlert.vue 改造

- 引入 Token 输入框（密码模式 + 显示切换）
- `statusMessage` / `statusIcon` / `alertStyle` 改为根据新状态分支
- 新增 `collapsed` ref 控制收起/展开
- 测试连接时同时传 URL 和 Token 给 `adminConnection.configure()`
- 保存时调用 `setAdminUrl()` + `setAdminAuthToken()`

### 4.4 与 Settings.vue / Setup.vue 的关系

**不建议抽取公共连接表单组件**，原因：
- 三处 UI 形态差异大（横幅紧凑 vs 设置页完整表单 vs 向导页居中卡片）
- 硬抽取一个公共组件会引入过多 props 控制布局差异，得不偿失

**建议做法：**
- Settings.vue 和 Setup.vue 的连接测试逻辑已经比 adminConnection 更丰富（分步 verify），保持现状
- ConnectionAlert.vue 直接调用 `adminConnection.configure()` 即可，该方法承担"快速配置"职责
- 三个页面共享 `adminConnection` 作为数据源，UI 各自独立实现

### 4.5 文件修改清单

| 文件 | 改动 |
|---|---|
| `src/utils/adminConnection.ts` | 扩展 ConnectionState 类型、ConfigureResult 接口、configure() 返回细分错误、detectConnection() 错误细分、新增 getCurrentToken() |
| `src/components/ConnectionAlert.vue` | 新增 Token 输入框、收起/展开、根据新状态显示不同文案/颜色/图标、DISCONNECTED 简化显示 |

## 5. 视觉效果

### 5.1 配色方案

使用 CSS 变量，与 Element Plus 语义色一致：

```css
/* 蓝色 - 未配置 */
--alert-bg-info: #eff6ff;
--alert-border-info: #93c5fd;

/* 橙色 - 需要认证 */
--alert-bg-warning: #fff7ed;
--alert-border-warning: #fdba74;

/* 红色 - 错误 */
--alert-bg-danger: #fef2f2;
--alert-border-danger: #fca5a5;

/* 黄色 - 断开/重连中 */
--alert-bg-caution: #fefce8;
--alert-border-caution: #fde047;

/* 绿色 - 连接成功（短暂显示） */
--alert-bg-success: #f0fdf4;
--alert-border-success: #86efac;
```

### 5.2 动画过渡

- **展开/收起**：`max-height` + `opacity` transition，300ms ease，避免突兀
- **状态切换**：背景色和边框色用 `transition: all 0.3s ease`
- **图标切换**：无动画（图标切换动画效果差，保持即时替换）

### 5.3 连接成功后的反馈

**方案：短暂绿色提示后自动隐藏**

- 状态变为 CONNECTED 后，横幅变为绿色 + "Admin 服务已连接"
- 显示 2 秒后自动隐藏（`setTimeout` + `opacity` 淡出 transition）
- 不需要用户手动关闭
- 如果在 2 秒内再次断开，直接切换回对应错误状态（取消淡出定时器）

### 5.4 收起状态的视觉

收起后横幅高度从约 80px 缩至约 36px，只保留：
- 左侧：图标 + 状态文案（一行）
- 右侧：展开按钮 `<ArrowRight/>`

圆角、内边距保持一致，只是内容减少。

---

## 附录：改动前后对比

### Before
- 只有 URL 输入框
- 所有失败统一显示 "Admin 服务连接失败"
- 红色横幅，无区分
- Token 只能在 Settings 页配置

### After
- URL + Token 双输入框
- 8 种细分状态，各自独立文案/配色
- 支持 InfoFilled / Lock / CircleCloseFilled / WarningFilled / Loading / CircleCheckFilled 图标
- 支持收起/展开
- 断开自动重连，无需用户干预
- 快速修复和跳转设置页两种路径
- 成功后绿色闪烁 2 秒消失
