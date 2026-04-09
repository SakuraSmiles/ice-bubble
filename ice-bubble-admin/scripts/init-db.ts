#!/usr/bin/env tsx
/**
 * 初始化数据库脚本
 */

import { DBManager } from '../src/storage/index.js';
import { defaultStorageConfig } from '../src/storage/index.js';

async function initDatabase() {
  console.log('=== 初始化 ice-bubble Admin 数据库 ===\n');

  const dbManager = new DBManager();
  
  try {
    // 使用默认配置初始化数据库
    await dbManager.init({
      dbPath: defaultStorageConfig.database.path,
      walMode: defaultStorageConfig.database.walMode,
      foreignKeys: defaultStorageConfig.database.foreignKeys,
      performance: defaultStorageConfig.database.performance
    });

    console.log('✅ 数据库初始化成功');
    console.log(`📁 数据库文件: ${defaultStorageConfig.database.path}`);
    
    // 获取数据库统计
    const stats = await dbManager.getStats();
    console.log(`📊 数据库大小: ${stats.totalSizeMB} MB`);
    console.log(`📊 表数量: ${stats.tableCount}`);
    console.log(`📊 总行数: ${stats.rowCount}`);

    // 关闭数据库连接
    await dbManager.close();
    
    console.log('\n✅ 数据库初始化完成！');
    console.log('💡 提示: 数据库文件已创建，表结构已初始化。');
    
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    process.exit(1);
  }
}

// 运行初始化
initDatabase().catch((error) => {
  console.error('初始化失败:', error);
  process.exit(1);
});