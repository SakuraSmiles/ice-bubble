# FileCollector 使用指南

## 概述

FileCollector 是 OpenClaw 数据采集系统的核心组件之一，负责从文件系统采集 Session 数据。

## 功能特性

✅ **文件扫描**: 自动扫描 `~/.openclaw/agents/*/sessions/*.jsonl` 文件  
✅ **文件监听**: 使用 chokidar 实时监听文件变化  
✅ **增量读取**: 避免重复处理已读取的数据  
✅ **数据转换**: 自动转换为 UnifiedMessage 统一格式  
✅ **批量处理**: 支持批量处理优化性能  
✅ **错误处理**: 完善的错误处理和日志记录  

## 快速开始

### 1. 基本使用

```typescript
import { FileCollector } from '@ice-bubble/collector-openclaw';
import { UnifiedMessage } from '@ice-bubble/collector-openclaw/types';

// 创建采集器
const collector = new FileCollector({
  openclawDataDir: '~/.openclaw', // OpenClaw 数据目录
  enableWatch: true,              // 启用文件监听
  batchSize: 100                  // 批量处理大小
});

// 监听消息事件
collector.on('message', (message: UnifiedMessage) => {
  console.log('收到消息:', message.id);
  console.log('消息类型:', message.messageType);
  console.log('SessionKey:', message.sessionKey);
});

// 监听错误事件
collector.on('error', (error: Error) => {
  console.error('错误:', error);
});

// 监听状态事件
collector.on('status', (stats) => {
  console.log('统计:', stats);
});

// 启动采集器
await collector.start();

// 运行一段时间后停止
await collector.stop();
```

### 2. 配置选项

```typescript
interface FileCollectorConfig {
  /**
   * OpenClaw 数据根目录
   * @required
   */
  openclawDataDir: string;

  /**
   * 是否启用文件监听
   * @default true
   */
  enableWatch?: boolean;

  /**
   * 扫描间隔（毫秒），仅当 enableWatch=false 时生效
   * @default 5000
   */
  scanInterval?: number;

  /**
   * 批量处理大小
   * @default 100
   */
  batchSize?: number;

  /**
   * 是否启用增量读取
   * @default true
   */
  enableIncremental?: boolean;
}
```

### 3. 事件类型

#### message 事件

当读取到有效的 OpenClaw 消息时触发。

```typescript
collector.on('message', (message: UnifiedMessage) => {
  // message.id: 消息唯一标识
  // message.sessionKey: Session Key
  // message.messageType: 'user' | 'agent' | 'tool'
  // message.timestamp: 消息时间戳
  // message.source: 'file'
  // message.content: 消息内容（可选）
  // message.model: AI 模型（仅 agent 类型）
  // message.tools: 工具调用列表（可选）
  // message.raw: 原始数据（可选）
});
```

#### error 事件

当发生错误时触发。

```typescript
collector.on('error', (error: Error) => {
  console.error('错误:', error.message);
});
```

#### status 事件

定期触发，报告处理进度。

```typescript
collector.on('status', (stats) => {
  console.log(`总计: ${stats.total}`);
  console.log(`成功: ${stats.processed}`);
  console.log(`失败: ${stats.failed}`);
});
```

## 工作原理

### 1. 初始扫描

启动时，FileCollector 会扫描所有 `.jsonl` 文件：

```
~/.openclaw/
└── agents/
    ├── dev/
    │   └── sessions/
    │       ├── session-001.jsonl
    │       └── session-002.jsonl
    └── prod/
        └── sessions/
            └── session-003.jsonl
```

### 2. 文件监听

使用 `chokidar` 监听文件变化：

- **add**: 新增文件时触发
- **change**: 文件修改时触发
- **unlink**: 文件删除时触发

### 3. 增量读取

维护每个文件的读取进度（已读取行号），避免重复处理：

```typescript
interface FileProgress {
  filePath: string;
  lastLine: number;      // 已读取到的行号
  lastModified: number;  // 文件最后修改时间
}
```

### 4. 数据转换流程

```
OpenClaw .jsonl 文件
    ↓
readJsonlFileIncremental (增量读取)
    ↓
OpenClawEvent[]
    ↓
convertOpenClawEvent (数据转换)
    ↓
UnifiedMessage
    ↓
emit('message', message)
```

## 高级用法

### 1. 定时扫描模式

如果不希望使用文件监听，可以使用定时扫描：

```typescript
const collector = new FileCollector({
  openclawDataDir: '~/.openclaw',
  enableWatch: false,      // 禁用文件监听
  scanInterval: 10000      // 每 10 秒扫描一次
});
```

### 2. 获取统计信息

```typescript
const stats = collector.getStats();
console.log('总文件数:', stats.totalFiles);
console.log('已处理文件数:', stats.processedFiles);
console.log('总事件数:', stats.totalEvents);
console.log('成功事件数:', stats.successEvents);
console.log('失败事件数:', stats.failedEvents);
```

### 3. 获取文件进度

```typescript
const progress = collector.getFileProgress();
progress.forEach((file, filePath) => {
  console.log(`文件: ${filePath}`);
  console.log(`已读取行号: ${file.lastLine}`);
  console.log(`最后修改时间: ${new Date(file.lastModified)}`);
});
```

### 4. 重置统计信息

```typescript
collector.resetStats();
```

## 性能优化

### 1. 批量处理

使用 `batchSize` 参数控制批量处理大小：

```typescript
const collector = new FileCollector({
  openclawDataDir: '~/.openclaw',
  batchSize: 100  // 每 100 条消息批量处理一次
});
```

### 2. 增量读取

默认启用增量读取，避免重复处理已读取的数据：

```typescript
const collector = new FileCollector({
  openclawDataDir: '~/.openclaw',
  enableIncremental: true  // 启用增量读取
});
```

### 3. 文件监听优化

使用 `awaitWriteFinish` 配置确保文件写入完成：

```typescript
// 内部配置
awaitWriteFinish: {
  stabilityThreshold: 1000,  // 等待 1 秒
  pollInterval: 200          // 每 200ms 检查一次
}
```

## 错误处理

### 1. 文件不存在

```typescript
try {
  await collector.start();
} catch (error) {
  console.error('OpenClaw 数据目录不存在:', error);
}
```

### 2. JSON 解析错误

FileCollector 会自动跳过无效的 JSON 行，并记录警告日志：

```
[FileReader] 第 42 行 JSON 解析失败: {"invalid json...
```

### 3. 数据转换错误

如果数据转换失败，会触发 `error` 事件：

```typescript
collector.on('error', (error) => {
  console.error('事件处理失败:', error);
});
```

## 测试

运行测试脚本：

```bash
npx tsx tests/scripts/test-file-collector.ts
```

测试内容包括：
1. 初始扫描所有 Session 文件
2. 文件监听功能验证
3. 增量读取验证
4. 数据转换验证
5. 统计信息验证

## 常见问题

### Q: 为什么有些消息没有被处理？

A: 检查以下几点：
1. 文件路径是否正确（`~/.openclaw/agents/*/sessions/*.jsonl`）
2. 文件格式是否为 JSON Lines（每行一个 JSON 对象）
3. 消息类型是否为 `message`（其他类型如 `session`、`model_change` 不会生成 UnifiedMessage）

### Q: 如何处理大量文件？

A: 建议：
1. 使用较小的 `batchSize`（如 50-100）
2. 启用增量读取（默认启用）
3. 使用文件监听模式，避免频繁全量扫描

### Q: 如何确保数据完整性？

A: FileCollector 提供以下保障：
1. 维护文件读取进度，支持断点续传
2. 使用 `awaitWriteFinish` 确保文件写入完成
3. 完善的错误处理和日志记录

## 相关文档

- [OpenClaw数据格式参考](./dev/OpenClaw-Session数据格式参考.md)
- [数据转换映射](./dev/数据转换映射.md)
- [架构设计](./dev/架构设计.md)
