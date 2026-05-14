# ice-bubble 安全审计报告

> 日期：2026-05-14
> 概述：覆盖 Token 认证、CORS 策略、SQL 注入、路径穿越、XSS 五大安全维度，识别出 Admin CORS `*` 宽松配置为最高风险。

**审计日期：** 2026-05-14
**项目路径：** `/mnt/d/workspace/ice-bubble`
**审计范围：** ice-bubble-admin、ice-bubble-collector-openclaw、ice-bubble-desktop

---

## 1. Token 认证覆盖检查

### 状态：🟡 部分安全，存在遗漏风险

**Admin（`ice-bubble-admin/src/index.ts`）**

所有 `/api/*` 路由统一在 `app.use('/api', createBearerAuthMiddleware(authToken))`（第 218 行）之后注册，认证中间件对所有 `/api/*` 请求强制执行。

**无需认证的路由（设计如此）：**

| 路由 | 位置 | 说明 |
|------|------|------|
| `GET /api/auth/status` | 第 170 行 | 公开端点：查询是否配置了 token |
| `POST /api/auth/verify` | 第 184 行 | 公开端点：验证 token 是否有效 |
| `GET /api/resources/avatars/:filename` | 第 203 行 | 头像文件（浏览器 `<img>` 无法携带 Authorization header） |
| `GET /health` | 第 384 行 | 健康检查 |

**`/api/resources/avatars/:filename` 头像端点 —— 有路径穿越防护，但实现方式存在差异：**

- **早期路由**（第 203 行，认证中间件之前）：
  ```ts
  const avatarsDirEarly = process.env.ADMIN_AVATARS_DIR || join(__dirname, '..', '..', 'data', 'avatars');
  app.get('/api/resources/avatars/:filename', (req, res) => {
    const filePath = join(avatarsDirEarly, req.params.filename);
  ```
  直接 `path.join` + `res.sendFile`，无 `..` 校验，**理论上可被路径穿越**（如 `GET /api/resources/avatars/../../../etc/passwd`）。

- **createResourcesRouter 中的头像端点**（`resources.ts` 第 33 行）：
  ```ts
  if (!filename || filename.includes('..') || filename.includes('/')) {
    return null; // 防止路径遍历攻击
  }
  ```
  有明确的 `..` 和 `/` 校验，比早期路由更安全。

**需要认证但遗漏的接口：** 无。

**Collector（`ice-bubble-collector-openclaw/src/api/server.ts`）**

- `/api/meta/*` 和 `/api/data/*` 路由均在 `createAuthMiddleware` 之后注册。
- 如果 `authToken` 为空（未配置），则**不启用认证**。这是设计选择，但意味着无配置时所有接口完全开放。

**风险说明：**
Admin 的早期头像端点（第 203 行）缺少 `..` 校验，存在低概率路径穿越风险。Collector 在未配置 token 时全开放。

**修复建议：**
1. 将 Admin 早期头像端点的 `req.params.filename` 也增加 `..` 和 `/` 校验，与 `resources.ts` 保持一致。
2. 在 Collector 中明确要求配置 token，避免无认证的部署状态。

---

## 2. CORS 策略审计

### 状态：🔴 有风险（Admin）/ 🟢 安全（Collector）

**Admin（`ice-bubble-admin/src/index.ts` 第 154 行）：**

```ts
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
```
- `origins: *` — 允许**任何来源**跨域访问。
- `credentials` 未设置（默认不带 cookie），但 `Authorization` header 仍可被恶意页面发起请求。
- 与 Bearer Token 认证结合：恶意网站可诱导已登录用户向 Admin API 发起跨域请求（CSRF 风险）。只要浏览器自动带上 `Authorization: Bearer <token>`，攻击即可成功。

**Collector（`ice-bubble-collector-openclaw/src/api/server.ts`）：**

```ts
if (isDev) {
  allowedOrigins = ['http://localhost:1420', 'http://localhost:14000'];
} else {
  allowedOrigins = _config.cors?.origins.filter(o => o !== '*');
}
```
- 明确过滤 `*` wildcard。
- 生产环境使用精确 origin 列表。**安全。**

**风险说明：**
Admin 的 `*` CORS 策略使任何网站都能向 Admin API 发起请求。结合 Bearer Token，只要浏览器发送认证 header，恶意网站即可代表用户操作。

**修复建议：**
1. Admin CORS 应限制为受控的前端地址（如 Desktop 的地址）。
2. 考虑使用 `Authorization` 以外的认证方式（如短期 JWT + 签名）来对抗 CSRF。

---

## 3. SQL 注入检查

### 状态：🟢 安全

所有数据库操作均使用 `better-sqlite3` 的**参数化查询**（`?` 占位符），未发现字符串拼接构建 SQL 的情况。

**Admin 典型用法：**

```ts
// data-repository.ts
this.db.prepare(`SELECT * FROM admin_sessions WHERE session_key = ?`).get(sessionKey)
this.db.prepare(`DELETE FROM admin_messages WHERE id IN (${placeholders})`)  // placeholders 为 ?*N 字符串，非用户输入
```

**Collector 典型用法：**

```ts
// sqlite-manager.ts
db.prepare(`SELECT * FROM session_messages WHERE session_key = ?`).get(sessionKey)
```

**动态 `WHERE` 子句构建：**

`data-repository.ts` 中多处通过 `conditions` 数组 + `values` 数组拼接 `WHERE` 子句：

```ts
// 第 259 行
const conditions: string[] = [];
if (params.agent_id) { conditions.push('agent_id = ?'); values.push(params.agent_id); }
const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
```

`conditions` 中的字段名是代码固定的（如 `'agent_id = ?'`），不是用户输入，**无注入风险**。

**无风险发现。**

---

## 4. 路径穿越检查

### 状态：🟡 基本安全，但早期头像端点有隐患

**Admin 头像处理：**

1. **早期路由**（`index.ts` 第 203 行）：
   ```ts
   const filePath = join(avatarsDirEarly, req.params.filename);
   res.sendFile(filePath);
   ```
   无 `..` 校验，**有路径穿越风险**。

2. **createResourcesRouter**（`resources.ts` 第 33 行）：
   ```ts
   if (!filename || filename.includes('..') || filename.includes('/')) {
     return null;
   }
   ```
   有校验，但仅拦截 `..` 和 `/`，未使用 `path.resolve` 规范化，仍可能通过 `abc/../../../` 等方式绕过（虽然 `..` 被过滤，绕过难度高）。

**Admin Workspace API（`workspace.ts`）：**

通过 `workspace-service.ts` 中的 `resolveSafePath` 防护：

```ts
const ALLOWED_ROOTS = ['/mnt/d/workspace', '/home/dabai', '/home/dabai/.openclaw/workspace'];
export function resolveSafePath(raw: string): string | null {
  if (normalized.includes('..')) return null;
  const resolved = path.resolve(normalized);
  if (!ALLOWED_ROOTS.some(root => resolved.startsWith(root + '/') || resolved === root)) {
    return null;
  }
  return resolved;
}
```

结合 `validateDirectory` 检查目录存在性，**安全。**

**Collector：**
无文件读取接口。

**修复建议：**
1. Admin 早期头像端点增加文件名白名单校验（仅允许字母数字下划线等）。
2. 考虑统一使用 `resources.ts` 的头像路由，删除早期路由。

---

## 5. Desktop XSS 风险

### 状态：🟢 安全

**`v-html` 使用情况：**

Desktop 中有一处 `v-html` 使用：

```vue
<!-- MarkdownContent.vue 第 3 行 -->
<div ref="contentRef" v-html="renderedContent"></div>
```

**关键防护：`renderMarkdown` 使用了 DOMPurify 清洗：**

```ts
// utils/markdown.ts 第 67 行
const raw = marked.parse(content, { async: false }) as string;
const clean = DOMPurify.sanitize(raw);
```

标记后的内容经过 `DOMPurify.sanitize()` 处理，XSS payload（如 `<img src=x onerror=...>`）会被清除。**安全。**

**其他检查：**
- `dangerouslySetInnerHTML` — 未发现。
- `innerHTML` 直接赋值 — 未发现。
- URL/Token/消息内容的用户输入均通过 Vue 模板插值（自动转义）或 `renderMarkdown` 处理。

---

## 总结

| 检查项 | 状态 | 风险等级 |
|--------|------|----------|
| Token 认证覆盖 | 🟡 早期头像端点无认证前校验 | 中 |
| CORS 策略 | 🔴 Admin origins: * 过于宽松 | 高 |
| SQL 注入 | 🟢 全部参数化查询 | 低 |
| 路径穿越 | 🟡 早期头像端点缺校验 | 中 |
| Desktop XSS | 🟢 DOMPurify 防护到位 | 低 |

**最优先修复项：** Admin CORS `*` 配置，应限制为受控的前端域名。

---

*审计工具：静态代码审查（无动态扫描）*
