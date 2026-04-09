# 模块接入指南

> ice-bubble-admin 模块接入规范文档

## 概述

本文档说明如何将外部模块接入 ice-bubble-admin 系统进行统一管理。

## 接口规范

### 1. 获取模块状态

每个模块需要实现一个标准的状态接口，供 admin 定时获取：

**请求**
```
GET /api/meta/status
Host: {module-base-url}
```

**响应**
```json
{
  "moduleKey": "collector-openclaw",
  "moduleType": "collector",
  "version": "1.0.0",
  "status": "running",
  "runtime": {
    "startTime": "2026-04-09T12:32:00Z",
    "uptimeSeconds": 3600,
    "messagesCollected": 19563,
    "errorsCount": 0
  },
  "health": {
    "status": "healthy",
    "message": "正常"
  }
}
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| moduleKey | string | 是 | 模块唯一标识 |
| moduleType | string | 是 | 模块类型 |
| version | string | 否 | 模块版本 |
| status | string | 是 | 运行状态 |
| runtime | object | 否 | 运行时信息 |
| runtime.startTime | string | 否 | 启动时间 ISO8601 |
| runtime.uptimeSeconds | number | 否 | 运行秒数 |
| runtime.messagesCollected | number | 否 | 采集消息数 |
| runtime.errorsCount | number | 否 | 错误次数 |
| health | object | 否 | 健康信息 |
| health.status | string | 否 | healthy/warning/error |
| health.message | string | 否 | 健康描述 |

## 模块类型

| 类型 | 说明 |
|------|------|
| collector | 数据采集模块 |
| api | API 服务模块 |
| worker | 后台任务模块 |

## 配置示例

在 admin 的 `config.json` 中添加模块配置：

```json
{
  "modules": [
    {
      "moduleKey": "collector-openclaw",
      "name": "OpenClaw采集器",
      "baseUrl": "http://192.168.1.100:18789",
      "enabled": true,
      "pollInterval": 30000
    }
  ]
}
```

## 模块配置字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| moduleKey | string | 是 | 模块唯一标识 |
| name | string | 是 | 模块名称 |
| baseUrl | string | 是 | 模块基础地址 |
| enabled | boolean | 否 | 是否启用 |
| pollInterval | number | 否 | 轮询间隔(毫秒) |

## REST API

admin 提供以下接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/modules | 获取所有模块列表 |
| GET | /api/modules/:key | 获取单个模块详情 |
| GET | /api/modules/:key/status | 手动触发状态更新 |

## 错误响应

```json
{
  "error": "错误描述",
  "code": "ERROR_CODE"
}
```

---

**版本**: 1.0.0  
**最后更新**: 2026-04-09