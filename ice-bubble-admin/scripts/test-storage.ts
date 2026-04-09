#!/usr/bin/env tsx
/**
 * 测试存储层功能
 */

import { DBManager, ModuleRepository } from '../src/storage/index.js';
import type { ModuleRegistry, ModuleRuntimeStatus, ModuleHealth } from '../src/types/module.js';

async function testStorage() {
  console.log('=== 开始测试存储层 ===\n');

  // 1. 初始化数据库
  console.log('1. 初始化数据库...');
  const dbManager = new DBManager();
  await dbManager.init({
    dbPath: '../data/test-admin.db',
    walMode: true,
    foreignKeys: true
  });

  const db = dbManager.getConnection();
  const repository = new ModuleRepository(db);

  // 2. 测试模块注册
  console.log('2. 测试模块注册...');
  const testModule: ModuleRegistry = {
    moduleKey: 'test-collector',
    moduleName: '测试采集器',
    moduleType: 'collector',
    status: 'running',
    version: '1.0.0',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const savedModule = await repository.upsertModule(testModule);
  console.log(`   创建模块: ${savedModule.moduleName} (${savedModule.moduleKey})`);

  // 3. 测试模块查询
  console.log('3. 测试模块查询...');
  const modules = await repository.getModules({ limit: 10 });
  console.log(`   查询到 ${modules.total} 个模块`);
  console.log(`   第一页: ${modules.modules.length} 条记录`);

  // 4. 测试模块详情
  console.log('4. 测试模块详情...');
  const moduleDetail = await repository.getModule('test-collector');
  if (moduleDetail) {
    console.log(`   模块详情: ${moduleDetail.module.moduleName}`);
  }

  // 5. 测试运行时状态
  console.log('5. 测试运行时状态...');
  const runtimeStatus: ModuleRuntimeStatus = {
    moduleKey: 'test-collector',
    isRunning: true,
    startTime: new Date(),
    uptimeSeconds: 3600,
    lastHeartbeat: new Date(),
    messagesCollected: 1000,
    errorsCount: 5,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await repository.upsertModuleRuntimeStatus(runtimeStatus);
  console.log('   运行时状态已保存');

  // 6. 测试健康状态
  console.log('6. 测试健康状态...');
  const health: ModuleHealth = {
    moduleKey: 'test-collector',
    healthStatus: 'healthy',
    checkTime: new Date(),
    message: '运行正常'
  };

  await repository.recordModuleHealth(health);
  console.log('   健康状态已记录');

  // 7. 测试健康汇总
  console.log('7. 测试健康汇总...');
  const healthSummary = await repository.getHealthSummary();
  console.log(`   健康汇总: 总计 ${healthSummary.totalModules}, 健康 ${healthSummary.healthy}`);

  // 8. 测试数据库统计
  console.log('8. 测试数据库统计...');
  const dbStats = await repository.getDatabaseStats();
  console.log(`   数据库统计: ${dbStats.moduleCount} 个模块, ${dbStats.healthCount} 条健康记录`);

  // 9. 清理测试数据
  console.log('9. 清理测试数据...');
  await repository.deleteModule('test-collector');
  console.log('   测试模块已删除');

  // 10. 关闭数据库
  console.log('10. 关闭数据库...');
  await dbManager.close();

  console.log('\n=== 存储层测试完成 ===');
  console.log('所有测试通过！');
}

// 运行测试
testStorage().catch((error) => {
  console.error('测试失败:', error);
  process.exit(1);
});