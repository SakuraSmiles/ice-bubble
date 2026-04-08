# 测试目录

本目录统一管理所有测试相关文件。

## 📁 目录结构

```
tests/
├── scripts/                          # 测试脚本
│   └── test-sqlite-manager.ts        # SQLiteManager 测试脚本
├── test-output/                      # 测试输出目录（自动生成，测试后自动清理）
│   ├── sqlite-test.db                # 测试数据库文件
│   └── ...                           # 其他测试临时文件
├── 测试方案-SQLiteManager.md          # 测试用例文档
└── README.md                         # 本文件
```

## 🚀 运行测试

### 测试方式

```bash
# 运行 SQLiteManager 测试
npm run test:sqlite
```

**特点：**
- ✅ 简单直接，快速验证
- ✅ 测试数据隔离在 `tests/test-output/`
- ✅ 测试结束后自动清理
- ✅ 不影响项目结构
- ✅ 完整的测试报告和性能数据

### 为什么不使用 Vitest？

由于 `better-sqlite3` 是原生 C++ 模块，与 vitest 存在兼容性问题（测试执行时可能卡住）。因此我们使用 tsx 脚本进行测试，这是轻量级且可靠的方案。

**vitest 配置保留说明：**
- `vitest.config.ts` 保留在项目根目录，供未来其他模块测试使用
- 未来开发的非原生模块可以使用 vitest 进行单元测试

## 🧪 测试数据管理

### 数据隔离原则

- **测试数据统一存放**: `tests/test-output/`
- **自动创建**: 测试开始时自动创建目录
- **自动清理**: 测试结束后自动删除整个目录
- **不影响项目**: 测试数据不会污染项目源码和配置

### 清理机制

测试脚本会在以下时机清理测试数据：

1. **测试开始前**: 创建 `tests/test-output/` 目录（如果不存在）
2. **测试结束后**: 删除整个 `tests/test-output/` 目录及其内容
3. **异常退出时**: 在 `finally` 块中确保清理

## 📝 测试用例文档

详细的测试用例请参考：

- [测试方案-SQLiteManager.md](./测试方案-SQLiteManager.md) - SQLiteManager 测试用例清单

## 🔄 测试流程

### 开发自测

```
开发人员 A 完成功能 → 运行测试脚本 → 所有测试通过 → 提交代码
```

### 交叉测试

```
开发人员 B 拉取代码 → 运行测试脚本 → 填写测试方案 → 提交 Bug 列表
```

### 回归测试

```
开发人员 A 修复 Bug → 开发人员 B 重新运行测试 → 验证修复 → 验收通过
```

## 🛠️ 新增测试模块

### 添加新的测试文件

**测试脚本**: 放在 `tests/scripts/` 中
```
tests/scripts/test-new-module.ts
```

**测试方案文档**: 放在 `tests/` 根目录
```
tests/测试方案-NewModule.md
```

**注意事项：**
- 如果测试涉及原生模块（如 better-sqlite3），建议使用 tsx 测试脚本
- 如果测试纯 JavaScript/TypeScript 模块，可以使用 vitest（在 tests/ 对应子目录创建 .test.ts 文件）

### 测试数据路径约定

```typescript
// 统一使用 tests/test-output/ 作为测试数据根目录
const TEST_OUTPUT_DIR = path.join(__dirname, '..', 'test-output');
const TEST_DB_PATH = path.join(TEST_OUTPUT_DIR, 'your-test-file.db');

// 测试结束后自动清理
function cleanupTestData() {
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
        fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    }
}
```

## 📊 测试覆盖范围

- ✅ **功能测试**: 核心功能、业务逻辑
- ✅ **异常测试**: 错误处理、边界条件
- ✅ **性能测试**: 批量操作、响应时间
- ⬜ **集成测试**: 多模块协作（待开发）
- ⬜ **端到端测试**: 完整流程（待开发）

## 🔧 配置文件

- `vitest.config.ts` - Vitest 配置（项目根目录）
- `package.json` - 测试脚本配置
  ```json
  {
    "scripts": {
      "test": "vitest",
      "test:sqlite": "tsx tests/scripts/test-sqlite-manager.ts"
    }
  }
  ```

## 🐛 问题排查

### 测试失败

1. 检查依赖是否安装: `npm install`
2. 检查 TypeScript 编译: `npm run typecheck`
3. 查看错误日志: 测试脚本会输出详细错误信息

### 清理失败

如果测试数据未自动清理：

```bash
# 手动删除测试输出目录
Remove-Item -Path tests\test-output -Recurse -Force
```

## 📚 相关文档

- [测试方案-SQLiteManager](./测试方案-SQLiteManager.md)
- [存储层设计](../docs/存储层设计.md)
- [项目 README](../README.md)
