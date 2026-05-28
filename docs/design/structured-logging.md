# ice-bubble 统一结构化日志方案设计

> 状态：草案 | 日期：2026-05-28

## 1. 现状分析

### 1.1 三个模块的 Logger 实现概览

| 维度 | admin | collector-openclaw | collector-opencode |
|------|-------|-------------------|-------------------|
| **依赖** | 无（自研） | winston ^3.11.0 | winston ^3.11.0 |
| **时间戳格式** | ISO 8601 (`2026-05-28T12:00:00.000Z`) | `YYYY-MM-DD HH:mm:ss` | `YYYY-MM-DD HH:mm:ss` |
| **日志级别来源** | 构造函数参数（默认 INFO） | `LOG_LEVEL` 环境变量 | `LOG_LEVEL` 环境变量 |
| **控制台彩色** | ❌ 无 | ✅ winston colorize | ✅ winston colorize |
| **Error 对象处理** | ❌ 仅 `Record<string,unknown>` | ✅ 自动提取 `message` + `stack` | ✅ 同 collector-openclaw |
| **子 Logger** | `child(name)` 创建 | winston `child({module})` | 同 collector-openclaw |
| **运行时改级别** | ✅ `setLevel()` | ❌ 无 | ❌ 无 |
| **文件输出** | ❌ 无 | ❌ 无 | ❌ 无 |
| **日志轮转** | ❌ 无 | ❌ 无 | ❌ 无 |
| **结构化输出** | 半结构化（data 字段序列化到行尾） | ❌ 纯文本 | ❌ 纯文本 |

### 1.2 输出格式对比

**admin** 格式：
```
2026-05-28T12:00:00.000Z INFO  [ice-bubble-admin]    Server started {"port":3000}
2026-05-28T12:00:01.000Z ERROR [db-manager          ] DB connection failed {"error":"timeout"}
```

**collector-openclaw / collector-opencode** 格式：
```
2026-05-28 12:00:00 [info]: [FileCollector] Starting file collection
2026-05-28 12:00:01 [error]: [CollectionPipeline] Pipeline failed { error: 'timeout', stack: '...' }
```

### 1.3 调用方使用模式

三个模块的使用模式高度一致：

```typescript
// 模式 1：默认单例
import { logger } from './utils/logger.js';
logger.info('Server started');

// 模式 2：模块化实例
import { Logger } from './utils/logger.js';
const log = new Logger('my-module');
log.info('doing work', { key: 'value' });
log.error('something failed', error);
```

admin 额外使用了 `child()` 和 `setLevel()` 两个 API。

### 1.4 核心问题

1. **格式不统一** — admin 用 ISO 时间戳 + 定长填充，collector 用 `YYYY-MM-DD HH:mm:ss` + 方括号
2. **无文件输出** — 所有日志只打到控制台，进程退出后日志丢失
3. **无日志轮转** — 即使加上文件输出，没有轮转会导致磁盘占满
4. **无结构化输出** — 当前都是纯文本行，难以被日志聚合工具（ELK、Loki、Datadog）消费
5. **admin 自研实现** — 无 Error stack 提取、无彩色输出，功能弱于 winston 版本
6. **代码重复** — collector-openclaw 和 collector-opencode 的 logger.ts 几乎一模一样

---

## 2. 方案设计

### 2.1 包位置决策：独立的 `@ice-bubble/logger` 包

**推荐：新建 `packages/logger` 作为独立包。**

理由：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 放 `@ice-bubble/types` | 少一个包 | types 是纯类型包（无运行时依赖），放入运行时代码违反职责单一；所有引 types 的包都会间接依赖 logger 的运行时依赖 |
| **独立 `@ice-bubble/logger`** ✅ | 职责清晰；可选依赖；独立版本管理 | 多一个 workspace 包 |
| 放各模块内 | 无 | 继续代码重复，违背统一目标 |

目录结构：

```
packages/logger/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # 公开 API
│   ├── logger.ts         # Logger 类
│   ├── levels.ts         # 日志级别定义
│   ├── formats.ts        # 格式化器
│   ├── transports.ts     # 传输器（控制台、文件）
│   └── config.ts         # 配置加载
```

### 2.2 日志库选型：Pino vs Winston vs 自研

| 维度 | **Pino** ✅ | Winston | 自研 |
|------|-----------|---------|------|
| 性能（ops/sec） | ~30,000（极端快） | ~5,000 | 取决于实现 |
| JSON 原生支持 | ✅ 一等公民 | 需配置 | 需实现 |
| 结构化日志 | ✅ 天然支持 | 需手动组合 | 需实现 |
| 文件轮转 | pino-roll / pino-daily-rotate | winston-daily-rotate-file | 需实现 |
| 生态/维护 | 活跃，Fastify 官方 | 活跃，老牌 | 无 |
| 体积 | ~7KB（核心） | ~200KB | ~2KB |
| 迁移成本 | admin 和 collector 都要改 | collector 已用 winston | admin 要改 |
| 彩色控制台 | pino-pretty | winston colorize | 需实现 |

**推荐：Pino。**

即使 collector 已经用了 winston，迁移成本并不高——三个模块的 Logger 都是薄封装，改动范围可控。Pino 在以下方面更适合本项目目标：

1. **JSON 结构化日志是默认行为**，不需要额外配置
2. **性能开销极低**，不会成为采集管线的瓶颈
3. **与 Node.js 生态深度集成**，Fastify、Next.js 等框架都有原生支持
4. **开发体验好**：`pino-pretty` 提供美观的控制台输出，生产环境用 JSON

> 备选：如果团队更熟悉 winston，用 winston + winston-daily-rotate-file 也能达到同样效果，只是 JSON 格式需要手动配置 `winston.format.json()`。

### 2.3 统一 API 设计

```typescript
// packages/logger/src/index.ts

import { Logger } from './logger.js';
import { LogLevel } from './levels.js';
import type { LogData } from './types.js';

// 默认 Logger 实例（用于简单场景）
export const logger: Logger;

// Logger 类（用于模块化场景）
export { Logger, LogLevel };
export type { LogData };

// 工厂函数
export function createLogger(name: string, opts?: LoggerOptions): Logger;
```

```typescript
// 使用方式 —— 与现有代码 100% 兼容
import { logger } from '@ice-bubble/logger';

logger.info('Server started', { port: 3000 });
logger.error('DB failed', err);
logger.warn('Slow query', { duration: 1200 });
logger.debug('Request headers', { headers: req.headers });

// 模块化 Logger
import { Logger } from '@ice-bubble/logger';
const log = new Logger('db-manager');
log.info('Connected', { dbPath: '/data/ice-bubble.db' });

// 子 Logger（兼容 admin 的 child() 用法）
const childLog = log.child('query');
childLog.debug('SELECT * FROM sessions');
```

**关键 API 对齐：**

| API | 现有 admin | 现有 collector | 统一方案 |
|-----|-----------|---------------|---------|
| `new Logger(name)` | ✅ | ✅ | ✅ |
| `logger.info(msg, data?)` | ✅ | ✅ | ✅ |
| `logger.warn(msg, data?)` | ✅ | ✅ | ✅ |
| `logger.error(msg, error?, data?)` | ✅（data 参数不同） | ✅ | ✅ |
| `logger.debug(msg, data?)` | ✅ | ✅ | ✅ |
| `logger.child(name)` | ✅ | ❌ | ✅ |
| `logger.setLevel(level)` | ✅ | ❌ | ✅ |

### 2.4 日志格式设计

#### 生产环境：JSON（机器可读）

```json
{
  "level": 30,
  "time": "2026-05-28T12:00:00.000Z",
  "pid": 12345,
  "hostname": "server-01",
  "name": "ice-bubble-admin",
  "module": "db-manager",
  "msg": "Connected to database",
  "data": {
    "dbPath": "/data/ice-bubble.db",
    "connectionTime": 42
  }
}
```

错误日志：
```json
{
  "level": 50,
  "time": "2026-05-28T12:00:01.000Z",
  "pid": 12345,
  "hostname": "server-01",
  "name": "ice-bubble-admin",
  "module": "api-server",
  "msg": "Request failed",
  "err": {
    "type": "Error",
    "message": "Connection refused",
    "stack": "Error: Connection refused\n    at ..."
  },
  "data": {
    "route": "/api/sessions",
    "method": "GET"
  }
}
```

**字段说明：**

| 字段 | 来源 | 说明 |
|------|------|------|
| `level` | pino 内置 | 数字级别（10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal） |
| `time` | pino 内置 | ISO 8601 毫秒时间戳 |
| `pid` | pino 内置 | 进程 ID |
| `hostname` | pino 内置 | 主机名 |
| `name` | 配置 | 服务名（`ice-bubble-admin` / `ice-bubble-collector-openclaw` 等） |
| `module` | Logger 实例 | 模块名（如 `db-manager`、`FileCollector`） |
| `msg` | 调用传入 | 日志消息 |
| `data` | 调用传入 | 附加结构化数据 |
| `err` | pino 内置 | 当传入 Error 对象时自动序列化 |

#### 开发环境：彩色可读文本（pino-pretty）

```
[2026-05-28 20:00:00.000] INFO  (ice-bubble-admin/db-manager): Connected to database
    dbPath: "/data/ice-bubble.db"
    connectionTime: 42
[2026-05-28 20:00:01.000] ERROR (ice-bubble-admin/api-server): Request failed
    err: {
      "type": "Error",
      "message": "Connection refused",
      "stack": "Error: Connection refused\n    at ..."
    }
    route: "/api/sessions"
    method: "GET"
```

通过环境变量切换：`NODE_ENV=development` 时使用 pino-pretty，否则输出 JSON。

### 2.5 传输器（Transports）设计

```
                    ┌─────────────────┐
                    │   Logger.log()   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   pino stream    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌────▼──────┐ ┌─────▼──────┐
     │ Console       │ │ File      │ │ File Error │
     │ (dev: pretty  │ │ (daily    │ │ (daily     │
     │  prod: json)  │ │  rotate)  │ │  rotate)   │
     └───────────────┘ └───────────┘ └────────────┘
```

**传输器配置：**

```typescript
interface LoggerConfig {
  // 服务名，用于日志标识
  name: string;

  // 日志级别（默认 info）
  level: LogLevel;

  // 控制台输出
  console: {
    enabled: boolean;           // 默认 true
    pretty: boolean;            // 默认 NODE_ENV !== 'production'
  };

  // 文件输出
  file: {
    enabled: boolean;           // 默认 true
    dir: string;                // 默认 './logs'
    maxDays: number;            // 默认 14（保留 14 天）
    maxSize: string;            // 默认 '10m'（单文件最大 10MB）
  };
}
```

**默认配置（环境变量驱动）：**

```bash
# 日志级别
LOG_LEVEL=info              # debug | info | warn | error

# 文件输出
LOG_FILE_ENABLED=true       # 是否写文件
LOG_FILE_DIR=./logs         # 日志目录
LOG_FILE_MAX_DAYS=14        # 保留天数
LOG_FILE_MAX_SIZE=10m       # 单文件最大大小

# 控制台
LOG_CONSOLE_ENABLED=true    # 是否输出到控制台（用 systemd 时建议 false）
LOG_PRETTY=true             # 开发模式美化输出（生产环境自动 false）
```

**文件命名规则：**

```
logs/
├── ice-bubble-admin.2026-05-28.log
├── ice-bubble-admin.2026-05-27.log
├── ice-bubble-admin-errors.2026-05-28.log
├── ice-bubble-collector-openclaw.2026-05-28.log
├── ice-bubble-collector-openclaw-errors.2026-05-28.log
└── ...
```

- 常规日志：`{service}.{YYYY-MM-DD}.log`
- 错误日志（仅 error/fatal）：`{service}-errors.{YYYY-MM-DD}.log`
- 滚动策略：每天零点切换，或文件超过 `maxSize` 时切换

### 2.6 依赖方案

#### 推荐：Pino 方案

```json
{
  "dependencies": {
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "pino-roll": "^4.0.0"
  }
}
```

| 包 | 用途 |
|---|------|
| `pino` | 核心日志引擎 |
| `pino-pretty` | 开发环境彩色美化输出 |
| `pino-roll` | 文件轮转（按日 + 按大小） |

#### 备选：Winston 方案

```json
{
  "dependencies": {
    "winston": "^3.11.0",
    "winston-daily-rotate-file": "^5.0.0"
  }
}
```

### 2.7 `@ice-bubble/types` 中新增类型

在 types 包中新增日志相关类型定义（仅类型，无运行时依赖）：

```typescript
// packages/types/src/logger.ts

/**
 * 日志级别
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * 日志数据载荷（值必须可 JSON 序列化）
 */
export type LogData = Record<string, unknown>;

/**
 * Logger 接口（各模块依赖此接口，而非具体实现）
 */
export interface ILogger {
  trace(msg: string, data?: LogData): void;
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, error?: Error | unknown, data?: LogData): void;
  fatal(msg: string, error?: Error | unknown, data?: LogData): void;
  child(name: string): ILogger;
}
```

> 说明：`ILogger` 接口放在 types 包，让各模块可以依赖抽象而非具体实现，方便未来切换日志库。

---

## 3. 迁移方案

### 3.1 迁移策略：三步走，渐进式

```
Phase 1 ────────► Phase 2 ────────► Phase 3
创建 @ice-bubble   逐个模块迁移       清理旧代码
/logger 包         保留旧 API        统一验证
(1-2天)            (每个模块 0.5天)   (0.5天)
```

### 3.2 Phase 1：创建 `@ice-bubble/logger` 包

1. 在 `packages/logger/` 下创建包
2. 实现统一的 `Logger` 类和配置加载
3. 实现控制台传输（pino-pretty 开发 / JSON 生产）
4. 实现文件传输（pino-roll 按日轮转）
5. 在 types 包中新增 `ILogger` 接口
6. 编写单元测试
7. 从 root `package.json` 的 `workspaces` 中加上 `packages/logger`

```bash
npm install --workspace=@ice-bubble/logger
```

### 3.3 Phase 2：逐模块迁移

**迁移模式（每个模块相同）：**

1. 添加依赖 `"@ice-bubble/logger": "*"`
2. 创建新的 `src/utils/logger.ts`，重新导出统一 Logger：

```typescript
// src/utils/logger.ts（新）
import { createLogger } from '@ice-bubble/logger';

export const logger = createLogger('ice-bubble-admin');  // 服务名区分
export { Logger, LogLevel } from '@ice-bubble/logger';
```

3. 保持 `export const logger` 和 `export class Logger` 的 API 不变
4. 编译验证 → 运行验证

**迁移顺序建议：**

| 顺序 | 模块 | 原因 |
|------|------|------|
| 1 | collector-opencode | 最简单，风险最低 |
| 2 | collector-openclaw | 依赖多，中等复杂度 |
| 3 | admin | 使用场景最多（child/setLevel），最后迁移 |

### 3.4 向后兼容处理

**admin 的兼容处理：**

admin 有两个独有的 API 需要兼容：

```typescript
// child() —— 已有等价物，直接映射
const childLog = parentLog.child('sub-module');

// setLevel() —— 运行时动态改级别
log.setLevel(LogLevel.DEBUG);
// 统一方案中通过 log.level = 'debug' 实现（pino 原生支持）
```

**collector 的兼容处理：**

collector 的 `error()` 签名是 `error(message, error?, meta?)`，与统一 API `error(message, error?, data?)` 一致，无需改动。

**import 路径不变：**

```typescript
// 旧路径（继续可用）
import { Logger, logger } from './utils/logger.js';

// 底层实现已切换为 @ice-bubble/logger
```

### 3.5 Phase 3：清理与验证

1. 移除旧 Logger 实现的残留代码
2. 移除不再需要的直接依赖（collector 的 `winston`）
3. 全量运行测试套件
4. 手动验证所有三个服务的日志输出：
   - 控制台彩色输出正常
   - 文件按日生成
   - JSON 格式可被 `jq` 或日志平台正确解析

### 3.6 迁移风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 日志格式变化导致监控脚本失效 | 中 | 中 | 保留文本格式的开发输出；JSON 输出是新增的 |
| pino 文件轮转在高负载下丢日志 | 低 | 低 | pino 是异步写入，有背压处理 |
| admin 的 `setLevel()` 行为差异 | 低 | 低 | pino 支持 `logger.level = 'debug'` 动态切换 |
| 依赖冲突 | 低 | 低 | Pino 依赖极少，与现有依赖无冲突 |

---

## 4. 额外收益

### 4.1 日志聚合就绪

JSON 格式的日志可直接接入：

- **ELK（Elasticsearch + Logstash + Kibana）**
- **Grafana Loki** + Promtail
- **Datadog / New Relic**
- 简单的 `jq` 命令行查询

示例：
```bash
# 查询最近 100 条错误日志
tail -100 logs/ice-bubble-admin.2026-05-28.log | jq 'select(.level >= 50)'

# 按模块统计日志量
cat logs/ice-bubble-admin.2026-05-28.log | jq -r '.module' | sort | uniq -c | sort -rn
```

### 4.2 请求追踪（可选扩展）

后续可以扩展加入 `requestId` / `traceId`：

```typescript
const log = logger.child({ requestId: crypto.randomUUID() });
log.info('Handling request');
// 同一请求的所有日志自动带上 requestId
```

### 4.3 性能无顾虑

Pino 的异步写入不会阻塞事件循环，在 collector 这种高频采集场景下不会成为性能瓶颈。benchmark: pino 处理 100 万条日志约 0.5s，winston 约 2s。

---

## 5. 建议实施计划

| 步骤 | 内容 | 预估工时 |
|------|------|---------|
| 1 | 创建 `@ice-bubble/logger` + 实现 + 测试 | 1 天 |
| 2 | 更新 `@ice-bubble/types` 新增 `ILogger` | 0.5 小时 |
| 3 | 迁移 `collector-opencode` | 0.5 小时 |
| 4 | 迁移 `collector-openclaw` | 0.5 小时 |
| 5 | 迁移 `admin` | 1 小时 |
| 6 | 清理旧依赖 + 全量测试 | 1 小时 |
| 7 | 文档 + systemd 日志配置更新 | 0.5 小时 |

**总预估：1.5-2 天**

---

## 6. 待决策事项

1. **Pino 还是 Winston？** — 推荐 Pino，但如团队更熟悉 Winston 也可行。无论选哪个，统一封装层的 API 不变。
2. **日志文件目录** — 建议 `./logs/`，与现有的 `data/` 目录同级。需确认部署环境有写权限。
3. **systemd + 日志** — 如果三个服务都由 systemd 管理，且 `StandardOutput=journal`，则文件输出可能与 journald 重复。建议：开发环境保留文件输出，生产环境可选关掉控制台输出（`LOG_CONSOLE_ENABLED=false`），由 journald 统一收集。
4. **日志级别动态调整** — 是否需要支持运行时通过 API/信号调整日志级别（如 `SIGUSR1` 切换 debug）？方便生产排查。

---

## 附录 A：三个模块的现有 Logger 使用统计

```
admin             (20 处 import)
├── import { logger } from './utils/index.js'   → 12 处（通用工具模块）
├── import { Logger } from './utils/logger.js'  → 6 处（需要模块级日志）
└── import { Logger, LogLevel } from ...        → 2 处（需要 LogLevel）

collector-openclaw (15 处 import)
├── import { Logger } from './utils/logger.js'  → 14 处
└── import { Logger } from '../utils/logger.js' → 1 处（api 子目录）

collector-opencode (10 处 import)
├── import { Logger } from './utils/logger.js'  → 8 处
└── import { Logger } from '../../utils/logger.js' → 2 处（api 子目录）
```

## 附录 B：Pino 关键配置参考

```typescript
import pino from 'pino';

const logger = pino({
  name: 'ice-bubble-admin',
  level: process.env.LOG_LEVEL || 'info',
  // 基础字段（每条日志都带）
  base: { pid: process.pid, hostname: require('os').hostname() },
  // 时间格式
  timestamp: pino.stdTimeFunctions.isoTime,
  // 开发环境美化输出
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
```
